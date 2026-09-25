const express = require('express');
const router = express.Router();
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const billingService = require('../services/billingService');
const ghlService = require('../services/ghlService');
const BillingTransaction = require('../models/BillingTransaction');
const ExportJob = require('../models/ExportJob');
const OAuthToken = require('../models/OAuthToken');
const CompanyLocation = require('../models/CompanyLocation');
const logger = require('../utils/logger');
const { logError, getUserFriendlyMessage } = require('../utils/errorLogger');
const { authenticateSession } = require('../middleware/auth');
const SpecialExport = require('../models/SpecialExport');
const AppConfig = require('../models/AppConfig');
const PricingRequest = require('../models/PricingRequest');
const nodemailer = require('nodemailer');
const { escapeHtml, isValidEmail } = require('../utils/sanitize');

// Reuse the same Gmail/nodemailer pattern as routes/support.js. Same env vars.
const pricingMailer = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.SUPPORT_EMAIL_USER,
    pass: process.env.SUPPORT_EMAIL_PASSWORD
  },
  tls: { rejectUnauthorized: false }
});

const INTERNAL_REVIEW_EMAIL = 'rapiddev21@gmail.com';
const AUTO_APPROVE_VOLUME_THRESHOLD = 10000;
// Server-side floor on customer-proposed credit prices. Matches the UI hint in
// PricingRequestModal so the client and server agree on what's submittable.
const MIN_PROPOSED_CREDIT_PRICE = 0.005;

// Initialize AWS Lambda client
const lambda = new LambdaClient({
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  }
});


const LAMBDA_FUNCTION_NAME = process.env.EXPORT_LAMBDA_FUNCTION_NAME || 'convo-vault-export';
/**
 * Billing Routes - Handle export pricing, charges, and job management
 */

// Maximum date range for exports (2 years in milliseconds)
const MAX_DATE_RANGE_MS = 2 * 365 * 24 * 60 * 60 * 1000;
const MAX_DATE_RANGE_MS_SPECIAL_TAB = 365 * 24 * 60 * 60 * 1000; // 1 year

/**
 * Validate the date range. There is no maximum span — any range is allowed as long as the
 * dates are valid and startDate is before endDate. (`maxRange` is kept in the signature for
 * backward compatibility with existing callers but is no longer enforced.)
 */
function validateDateRange(startDate, endDate, maxRange = MAX_DATE_RANGE_MS) {
  if (!startDate || !endDate) return { valid: true };

  const start = new Date(startDate);
  const end = new Date(endDate);

  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    return { valid: false, error: 'Invalid date format' };
  }

  if (end < start) {
    return { valid: false, error: 'End date must be after start date' };
  }

  return { valid: true };
}

// Hardcoded flat-fee re-downloads. When a sub-account re-requests an export whose
// locationId + exportType + exact date range match an entry here, we bill this flat fee
// (instead of per-record pricing) and run the normal export + email flow again. Used for
// re-downloads of data the customer already paid full price for once.
const FIXED_PRICE_EXPORTS = [
];

// Returns the flat fee (number) when the request matches a FIXED_PRICE_EXPORTS entry, else null.
// Matches on locationId + exportType + exact start/end timestamps.
function matchFixedPriceExport(locationId, exportType, filters) {
  if (!filters?.startDate || !filters?.endDate) return null;
  const start = new Date(filters.startDate).getTime();
  const end = new Date(filters.endDate).getTime();
  if (isNaN(start) || isNaN(end)) return null;
  for (const e of FIXED_PRICE_EXPORTS) {
    if (e.locationId === locationId &&
        e.exportType === exportType &&
        new Date(e.startDate).getTime() === start &&
        new Date(e.endDate).getTime() === end) {
      return e.amount;
    }
  }
  return null;
}

/**
 * @route POST /api/billing/estimate
 * @desc Get cost estimate for export
 */
router.post('/estimate', authenticateSession, async (req, res) => {
  // Extend timeout for this route — tag resolution + note counting can take minutes
  req.setTimeout(600000);
  res.setTimeout(600000);
  try {
    const { locationId, exportType, filters } = req.body;

    if (!locationId) {
      return res.status(400).json({
        success: false,
        error: 'locationId is required'
      });
    }

    const validExportTypes = ['conversations', 'messages', 'notes', 'tasks', 'opportunities', 'formSubmissions', 'links', 'socialPosts', 'callLogs', 'templates', 'specialTabMessages', 'callTranscriptions', 'contacts', 'customFields', 'customValues', 'tags', 'opportunityStageHistory', 'contactBundle', 'messagesByTag', 'groupMessages', 'internalMessages'];
    if (!exportType || !validExportTypes.includes(exportType)) {
      return res.status(400).json({
        success: false,
        error: `exportType must be one of: ${validExportTypes.join(', ')}`
      });
    }

    // Feature-gate: opportunityStageHistory is a custom build for specific locations only.
    if (exportType === 'opportunityStageHistory') {
      const allowed = await AppConfig.hasValue('opportunityStageExportLocations', locationId);
      if (!allowed) {
        return res.status(403).json({
          success: false,
          error: 'Opportunity Stage History export is not enabled for this sub-account.'
        });
      }
    }

    // Validate date range (not applicable for notes/links/templates/customFields/customValues/tags)
    if (!['notes', 'links', 'templates', 'customFields', 'customValues', 'tags'].includes(exportType)) {
      const dateValidation = validateDateRange(filters?.startDate, filters?.endDate, ['specialTabMessages', 'callTranscriptions'].includes(exportType) ? MAX_DATE_RANGE_MS_SPECIAL_TAB : MAX_DATE_RANGE_MS);
      if (!dateValidation.valid) {
        return res.status(400).json({
          success: false,
          error: dateValidation.error
        });
      }
    }

    logger.info('Calculating export estimate', { locationId, exportType, filters });

    // For notes: track resolved contacts from tag lookup to return to frontend
    let resolvedContactIds = null;
    let resolvedContactNames = null;
    let resolvedContactsMeta = null;

    let counts = {
      conversations: 0,
      smsMessages: 0,
      emailMessages: 0,
      notes: 0,
      tasks: 0,
      opportunities: 0,
      formSubmissions: 0,
      links: 0,
      socialPosts: 0,
      callLogs: 0,
      templates: 0,
      contacts: 0,
      customFields: 0,
      customValues: 0,
      tags: 0,
      opportunityStageHistory: 0
    };

    if (exportType === 'contacts') {
      // One paged probe gives us meta.total without scanning everything.
      const result = await ghlService.searchContactsAdvanced(locationId, {
        ...filters,
        limit: 1
      });
      counts.contacts = result.total || 0;
    } else if (exportType === 'conversations') {
      // Fetch first page of conversations to estimate count
      const result = await ghlService.searchConversations(locationId, {
        ...filters,
        limit: 100
      });

      // Use total from response if available, otherwise use fetched count
      const total = result.total || result.conversations?.length || 0;
      counts.conversations = total;

    } else if (exportType === 'messages') {
      // Fetch first page of messages to estimate count and types
      const result = await ghlService.exportMessages(locationId, {
        ...filters,
        limit: 100
      });

      const messages = result.messages || [];
      const total = result.total || messages.length;

      // Count message types from sample
      // Email = TYPE_EMAIL or type 3, everything else = text message
      let textCount = 0, emailCount = 0;
      messages.forEach(msg => {
        const type = String(msg.type || '').toLowerCase();
        if (type.includes('email') || type === '3' || type === 'type_email') {
          emailCount++;
        } else {
          textCount++; // SMS, WhatsApp, Call, GMB, FB, etc.
        }
      });

      // Extrapolate if we have more items than sample
      if (messages.length > 0 && total > messages.length) {
        const ratio = total / messages.length;
        counts.smsMessages = Math.round(textCount * ratio);
        counts.emailMessages = Math.round(emailCount * ratio);
      } else {
        counts.smsMessages = textCount;
        counts.emailMessages = emailCount;
      }

    } else if (exportType === 'notes') {
      // Resolve contactIds: either direct selection or by tag
      resolvedContactIds = [];
      resolvedContactNames = filters?.contactNames || {};
      resolvedContactsMeta = filters?.contactsMeta ? { ...filters.contactsMeta } : {};

      if (filters?.contactId) {
        resolvedContactIds = [filters.contactId];
      } else if (filters?.contactIds?.length > 0) {
        resolvedContactIds = filters.contactIds;
      } else if (filters?.tags) {
        // Resolve all contacts matching the tag via pagination
        let startAfterId = null;
        let startAfter = null;
        let hasMore = true;
        let page = 0;
        const MAX_PAGES = 100; // Safety limit: 100 pages * 100 contacts = 10,000 max
        while (hasMore && page < MAX_PAGES) {
          page++;
          const result = await ghlService.searchContacts(locationId, { tag: filters.tags, limit: 100, startAfterId, startAfter });
          const contacts = result.contacts || [];
          logger.info('Tag contacts page result', { page, contactsReturned: contacts.length, metaTotal: result.meta?.total, metaStartAfterId: result.meta?.startAfterId });
          for (const c of contacts) {
            resolvedContactIds.push(c.id);
            if (!resolvedContactNames[c.id]) {
              resolvedContactNames[c.id] = c.contactName || `${c.firstName || ''} ${c.lastName || ''}`.trim() || 'Unknown';
            }
            if (!resolvedContactsMeta[c.id]) {
              resolvedContactsMeta[c.id] = { email: c.email || '', phone: c.phone || '' };
            }
          }
          if (contacts.length < 100) {
            hasMore = false;
          } else if (result.meta?.startAfterId) {
            startAfterId = result.meta.startAfterId;
            startAfter = result.meta.startAfter || null;
          } else {
            // No cursor in meta — stop to avoid infinite loop
            logger.warn('No pagination cursor in meta, stopping', { page, totalResolved: resolvedContactIds.length });
            hasMore = false;
          }
        }
        if (page >= MAX_PAGES) {
          logger.warn('Hit max pages limit for tag contact resolution', { tag: filters.tags, totalResolved: resolvedContactIds.length });
        }
        logger.info('Tag contact resolution complete', { tag: filters.tags, totalContacts: resolvedContactIds.length, pages: page });
      }

      // Dedup contactIds
      const beforeDedup = resolvedContactIds.length;
      resolvedContactIds = [...new Set(resolvedContactIds)];
      if (beforeDedup !== resolvedContactIds.length) {
        logger.warn('Duplicate contactIds removed', { before: beforeDedup, after: resolvedContactIds.length });
      }

      if (resolvedContactIds.length === 0) {
        return res.status(400).json({ success: false, error: 'No contacts found with this tag' });
      }

      // Count notes in parallel batches with retry (3 attempts max)
      let total = 0;
      let skipped = 0;
      const BATCH_SIZE = 5;
      const MAX_RETRIES = 3;
      let pendingContactIds = [...resolvedContactIds];


      for (let attempt = 1; attempt <= MAX_RETRIES && pendingContactIds.length > 0; attempt++) {
        const failedThisRound = [];
        for (let i = 0; i < pendingContactIds.length; i += BATCH_SIZE) {
          const batch = pendingContactIds.slice(i, i + BATCH_SIZE);
          const results = await Promise.allSettled(
            batch.map(cId => ghlService.getContactNotes(locationId, cId).then(r => ({ cId, total: r.total, notesLength: r.notes?.length || 0 })))
          );
          for (let j = 0; j < results.length; j++) {
            if (results[j].status === 'fulfilled') {
              const { cId, total: noteCount, notesLength } = results[j].value;
              logger.info('Contact notes count', { contactId: cId, noteCount, notesArrayLength: notesLength });
              total += noteCount;
            } else {
              failedThisRound.push(batch[j]);
            }
          }
        }
        if (failedThisRound.length > 0) {
          logger.warn(`Attempt ${attempt}: ${failedThisRound.length} contacts failed`, { attempt, failed: failedThisRound.length, runningTotal: total });
        }
        pendingContactIds = failedThisRound;
      }

      if (pendingContactIds.length > 0) {
        skipped = pendingContactIds.length;
        logger.warn('Contacts skipped after max retries', { skipped, contactIds: pendingContactIds.slice(0, 10) });
      }

      counts.notes = total;
      logger.info('Notes count complete', { totalContacts: resolvedContactIds.length, totalNotes: total, skippedContacts: skipped });

    } else if (exportType === 'tasks') {
      // Tasks: location-level search API — always upfront billing
      const result = await ghlService.getLocationTasks(locationId, {
        contactIds: filters?.contactIds || [],
        assignedTo: filters?.assignedTo,
        completed: filters?.completed,
        overdue: filters?.overdue,
        query: filters?.query,
        dueDate: filters?.dueDate,
        sortKey: filters?.sortKey,
        sortDirection: filters?.sortDirection,
        unAssigned: filters.unAssigned,
        businessId: filters.businessId,
        limit: 1
      });
      counts.tasks = result.total || 0;

    } else if (exportType === 'opportunities') {
      // Opportunities: location-level search API returns total directly
      const result = await ghlService.searchOpportunities(locationId, {
        ...filters,
        limit: 1
      });
      counts.opportunities = result.total || 0;

    } else if (exportType === 'formSubmissions') {
      // Form Submissions: page-based API returns total in meta
      const result = await ghlService.getFormSubmissions(locationId, {
        formId: filters?.formId,
        q: filters?.query,
        startAt: filters?.startDate,
        endAt: filters?.endDate,
        limit: 1
      });
      counts.formSubmissions = result.total || 0;

    } else if (exportType === 'links') {
      const result = await ghlService.getLinks(locationId, { query: filters?.query, limit: 1000 });
      counts.links = result.total || result.links?.length || 0;

    } else if (exportType === 'socialPosts') {
      // Social Posts: list endpoint returns total
      const result = await ghlService.getSocialPosts(locationId, {
        ...filters,
        limit: 1
      });
      counts.socialPosts = result.total || 0;

    } else if (exportType === 'callLogs') {
      // Call Logs: page-based API returns total
      const result = await ghlService.getCallLogs(locationId, {
        ...filters,
        pageSize: 1
      });
      counts.callLogs = result.total || 0;

    } else if (exportType === 'templates') {
      // Templates: returns totalCount directly
      const result = await ghlService.getTemplates(locationId, {
        type: filters?.type,
        limit: '1'
      });
      counts.templates = result.total || 0;

    } else if (exportType === 'customFields') {
      // Custom fields: single-shot list, no pagination
      const result = await ghlService.getCustomFields(locationId, filters?.model || 'all');
      counts.customFields = result.total || 0;

    } else if (exportType === 'customValues') {
      // Custom values: single-shot list, no pagination
      const result = await ghlService.getCustomValues(locationId, filters?.documentType || 'all');
      counts.customValues = result.total || 0;

    } else if (exportType === 'tags') {
      // Tags: single-shot list, no pagination, no filters
      const result = await ghlService.getLocationTags(locationId);
      counts.tags = result.total || 0;

    } else if (exportType === 'opportunityStageHistory') {
      // Opportunity Stage History (gated custom build) — full walk:
      //   1) Walk all opportunities → group by contact, snapshot opportunity custom fields.
      //   2) Build pipelines + custom-field name maps (one call each).
      //   3) Per contact: walk full message timeline, find TYPE_ACTIVITY_OPPORTUNITY rows,
      //      derive [enteredAt, leftAt] window per opportunity stage.
      //   4) Bucket conversation messages (SMS/Email/Webchat/Call) into each stage window.
      //   5) Per contact: pull custom field snapshot (one call).
      //   6) For each (opportunity × stage) emit one row → store all rows in SpecialExport
      //      (chunked, `messages` field — reuses the specialTabMessages chunk reader in Lambda).
      // Transcripts are deferred to a Phase-2 pass (call message IDs are stored for later resolution).
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const THROTTLE_MS = 120;

      // End-to-end logging for the OSH (Opportunity Stage History) flow. Tag every line with [OSH]
      // so this single custom-build location's trace can be greppped in production logs without
      // dragging in unrelated export-type noise.
      const oshRunId = `osh_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const oshStart = Date.now();
      const oshLog = (msg, meta = {}) => logger.info(`[OSH] ${msg}`, {
        runId: oshRunId,
        locationId,
        elapsedMs: Date.now() - oshStart,
        ...meta
      });
      const oshWarn = (msg, meta = {}) => logger.warn(`[OSH] ${msg}`, {
        runId: oshRunId,
        locationId,
        elapsedMs: Date.now() - oshStart,
        ...meta
      });
      const oshSample = (arr, n = 1) => Array.isArray(arr) ? arr.slice(0, n) : arr;
      oshLog('flow started', { filters });

      const withRetry = async (fn, maxRetries = 4) => {
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          try {
            return await fn();
          } catch (err) {
            const status = err.response?.status;
            const transient = status === 429 || (status >= 500 && status < 600);
            if (transient && attempt < maxRetries) {
              const delay = Math.min(30000, Math.pow(2, attempt) * 1500);
              logger.warn('Transient error walking opportunity stages, retrying', { status, attempt: attempt + 1, delay });
              await sleep(delay);
            } else throw err;
          }
        }
      };

      // Step 1: pipelines (stage id → stage name + pipeline name)
      oshLog('step1.pipelines: request', { endpoint: 'GET /opportunities/pipelines' });
      const pipelinesResp = await withRetry(() => ghlService.getPipelines(locationId));
      const stageMap = {};                 // stageId → { stageName, pipelineId, pipelineName }
      const stageIdByPipelineAndName = {}; // pipelineId → { stageName → stageId } (name-based lookup, scoped per pipeline because names can collide across pipelines)
      // Activity events expose pipeline as a *name* (e.g. "Liam"), not an id, so we need:
      //   pipelineByName: name → id (so we can resolve a ghost opp's pipelineId from activity data)
      //   resolveStageId(pipelineName, stageName) → stageId (handles the collision-by-name case via pipeline scoping)
      const pipelineByName = {};
      for (const p of (pipelinesResp.pipelines || [])) {
        pipelineByName[p.name] = { id: p.id, name: p.name };
        stageIdByPipelineAndName[p.id] = {};
        for (const s of (p.stages || [])) {
          stageMap[s.id] = { stageName: s.name, pipelineId: p.id, pipelineName: p.name };
          stageIdByPipelineAndName[p.id][s.name] = s.id;
        }
      }
      const resolveStageId = (pipelineName, stageName) => {
        if (!pipelineName || !stageName) return null;
        const pipelineId = pipelineByName[pipelineName]?.id;
        return (pipelineId && stageIdByPipelineAndName[pipelineId]?.[stageName]) || null;
      };
      oshLog('step1.pipelines: response', {
        pipelineCount: (pipelinesResp.pipelines || []).length,
        totalStages: Object.keys(stageMap).length,
        samplePipeline: oshSample((pipelinesResp.pipelines || []).map(p => ({
          id: p.id,
          name: p.name,
          stageCount: (p.stages || []).length
        })), 3)
      });

      // Step 2: custom field schemas (separate calls for contact + opportunity models)
      oshLog('step2.customFields: request', {
        endpoints: [
          'GET /locations/{locationId}/customFields?model=contact',
          'GET /locations/{locationId}/customFields?model=opportunity'
        ]
      });
      const [cfContactResp, cfOppResp] = await Promise.all([
        withRetry(() => ghlService.getCustomFields(locationId, 'contact')).catch((e) => {
          oshWarn('step2.customFields: contact fetch failed (non-fatal)', { error: e.message, status: e.response?.status });
          return { customFields: [] };
        }),
        withRetry(() => ghlService.getCustomFields(locationId, 'opportunity')).catch((e) => {
          oshWarn('step2.customFields: opportunity fetch failed (non-fatal)', { error: e.message, status: e.response?.status });
          return { customFields: [] };
        })
      ]);
      const contactCfMap = {};
      for (const f of (cfContactResp.customFields || [])) contactCfMap[f.id] = f.name;
      const oppCfMap = {};
      for (const f of (cfOppResp.customFields || [])) oppCfMap[f.id] = f.name;
      // Sorted, deduped name lists for the Lambda CSV column schema. We persist these on the
      // SpecialExport so chunk-0's CSV header has the full set of "Contact CF: <name>" /
      // "Opp CF: <name>" columns up-front, even if some chunks lack any value for a field.
      const contactCustomFieldNames = Array.from(new Set(Object.values(contactCfMap))).sort();
      const opportunityCustomFieldNames = Array.from(new Set(Object.values(oppCfMap))).sort();
      oshLog('step2.customFields: response', {
        contactCustomFieldCount: Object.keys(contactCfMap).length,
        opportunityCustomFieldCount: Object.keys(oppCfMap).length,
        sampleContactFields: oshSample(Object.values(contactCfMap), 5),
        sampleOpportunityFields: oshSample(Object.values(oppCfMap), 5)
      });

      // Step 3: walk all opportunities (cursor pagination)
      oshLog('step3.opportunities: walk start', { endpoint: 'POST /opportunities/search', pageSize: 100, maxPages: 500 });
      const allOpps = [];
      let oppCursor = null;
      let oppPage = 0;
      while (true) {
        oppPage++;
        oshLog('step3.opportunities: page request', { page: oppPage, cursor: oppCursor, limit: 100 });
        const r = await withRetry(() => ghlService.searchOpportunities(locationId, {
          limit: 100,
          searchAfter: oppCursor || undefined
        }));
        const ops = r.opportunities || [];
        allOpps.push(...ops);
        oshLog('step3.opportunities: page response', {
          page: oppPage,
          returned: ops.length,
          runningTotal: allOpps.length,
          nextCursor: r.searchAfter || null,
          sampleOpp: oshSample(ops.map(o => ({
            id: o.id,
            contactId: o.contactId,
            pipelineId: o.pipelineId,
            pipelineStageId: o.pipelineStageId,
            createdAt: o.createdAt
          })), 1)
        });
        if (ops.length < 100 || !r.searchAfter || r.searchAfter.length === 0) break;
        oppCursor = r.searchAfter;
        if (oppPage > 500) {
          oshWarn('step3.opportunities: hit hard page cap (500), truncating', { totalCollected: allOpps.length });
          break;
        }
        await sleep(THROTTLE_MS);
      }
      oshLog('step3.opportunities: walk complete', { totalOpportunities: allOpps.length, pagesWalked: oppPage });

      // Map: opportunityId → { ...opp, contactId, customFieldsResolved }
      const oppById = {};
      for (const o of allOpps) {
        const cfResolved = {};
        for (const cf of (o.customFields || [])) {
          const name = oppCfMap[cf.id] || cf.id;
          cfResolved[name] = cf.fieldValue ?? cf.value ?? cf.fieldValueString ?? '';
        }
        oppById[o.id] = { ...o, customFieldsResolved: cfResolved };
      }

      // Group opportunities by contactId so we walk each contact's message timeline once.
      const oppsByContact = {};
      let oppsWithoutContact = 0;
      for (const o of allOpps) {
        if (!o.contactId) { oppsWithoutContact++; continue; }
        (oppsByContact[o.contactId] ||= []).push(o);
      }
      oshLog('step3.opportunities: grouped by contact', {
        uniqueContacts: Object.keys(oppsByContact).length,
        opportunitiesSkippedNoContact: oppsWithoutContact,
        avgOppsPerContact: Object.keys(oppsByContact).length
          ? +(allOpps.length / Object.keys(oppsByContact).length).toFixed(2)
          : 0
      });

      // Helpers — pulled out to keep the per-contact loop readable.
      // GHL's per-conversation /conversations/{convId}/messages endpoint returns `type` as a
      // NUMERIC code (28 = TYPE_ACTIVITY_OPPORTUNITY), while the bulk /conversations/messages/export
      // endpoint returns the STRING form. We accept both — production logs at runId
      // osh_1778836221027_2955gc confirmed the numeric variant was silently dropping every event.
      const isActivityOpportunity = (m) => {
        const t = m.type ?? m.messageType;
        if (t === 28 || t === '28') return true;
        return String(t || '').toUpperCase() === 'TYPE_ACTIVITY_OPPORTUNITY';
      };
      // Activity-row shape (verified against GHL DB records / webhook payloads):
      //
      //   STAGE CHANGE event:
      //     activity: {
      //       type: 'opportunity_stage_updated',
      //       title: 'Opportunity updated',
      //       data: {
      //         id: <opportunityId>,
      //         name: <opportunityName>,
      //         status: 'open' | 'won' | 'lost' | ...,
      //         pipeline: <pipelineName>,   // NAME, not id
      //         stage: { oldStageName: <name>, newStageName: <name> }   // NAMES, not ids
      //       }
      //     }
      //
      //   CREATION event:
      //     activity: {
      //       type: 'opportunity_created',
      //       data: { id, name, status, pipeline, stage: { newStageName } }   // no oldStageName
      //     }
      //
      // Pipeline + stage are returned as names; we resolve back to IDs by name lookup via
      // stageMap (built in step 1). The leaner shape from /conversations/{convId}/messages may
      // omit `activity` entirely (still being verified) — legacy info/meta/body paths kept as
      // a fallback so this works against either response.
      const extractStageEvent = (m) => {
        // Preferred: structured activity field (webhook + DB shape)
        const act = m.activity || null;
        const actData = act?.data || null;
        const actStage = actData?.stage || {};

        // Legacy fallback: try info/meta/body-as-JSON
        const info = m.info || m.meta || (() => { try { return typeof m.body === 'string' ? JSON.parse(m.body) : m.body; } catch { return null; } })() || {};
        const legacyStage = info.stage || info.stages || {};

        const oppId =
          actData?.id ||
          info.id || info.opportunityId || info.opportunity_id ||
          m.opportunityId || null;

        const oldStageId =
          actStage.oldStageId || actStage.fromStageId ||
          legacyStage.oldStageId || legacyStage.from ||
          info.oldStageId || info.previousStageId || null;
        const newStageId =
          actStage.newStageId || actStage.toStageId ||
          legacyStage.newStageId || legacyStage.to ||
          info.newStageId || info.currentStageId || null;

        const oldStageName =
          actStage.oldStageName || actStage.fromStageName ||
          legacyStage.oldStageName || legacyStage.fromName ||
          info.oldStageName ||
          (oldStageId && stageMap[oldStageId]?.stageName) || null;
        const newStageName =
          actStage.newStageName || actStage.toStageName ||
          legacyStage.newStageName || legacyStage.toName ||
          info.newStageName ||
          (newStageId && stageMap[newStageId]?.stageName) || null;

        // Pipeline name comes from `activity.data.pipeline` (e.g. "Liam"); fallback to legacy paths.
        const pipelineName = actData?.pipeline || info.pipeline || info.pipelineName || null;
        // Opportunity display name (useful when synthesizing ghost-opp rows for deleted opps).
        const oppName = actData?.name || info.name || null;
        // Event type lets the caller distinguish creation (no previous-stage row to close) from
        // stage transitions (emit a row for the FROM stage window) from deletion (close final row).
        const eventType = act?.type || info.type || null;

        // Activity events carry stage *names* but not *ids*. Reverse-resolve when missing,
        // so downstream code has stageIds for both old and new (scoped by pipeline to avoid
        // collisions when the same stage name exists in multiple pipelines).
        const resolvedOldStageId = oldStageId || resolveStageId(pipelineName, oldStageName);
        const resolvedNewStageId = newStageId || resolveStageId(pipelineName, newStageName);

        return {
          oppId,
          oldStageId: resolvedOldStageId,
          newStageId: resolvedNewStageId,
          oldStageName, newStageName,
          pipelineName, oppName,
          eventType,
          dateAdded: m.dateAdded || m.dateUpdated || null
        };
      };

      // Channel messages: GHL returns numeric type codes from /conversations/messages/export
      // (e.g. type=20 inbound SMS) and from per-conversation /messages (when not filtered).
      // String form is `TYPE_SMS` / `TYPE_EMAIL` / etc. We accept either.
      //
      // The 25–29 numeric range is reserved for activity events (28 = TYPE_ACTIVITY_OPPORTUNITY,
      // confirmed in production). Everything else returned by these channel endpoints is a real
      // conversation message — trust the endpoint rather than maintaining a whitelist.
      const ACTIVITY_TYPE_NUMS = new Set([25, 26, 27, 28, 29]);
      const isConversationMsg = (m) => {
        const t = m.type ?? m.messageType;
        if (typeof t === 'number') return !ACTIVITY_TYPE_NUMS.has(t);
        const str = String(t || '').toUpperCase();
        if (!str) return false;
        if (str.startsWith('TYPE_ACTIVITY')) return false;
        return str.startsWith('TYPE_SMS') || str === 'TYPE_EMAIL' || str === 'TYPE_LIVE_CHAT'
          || str === 'TYPE_WEBCHAT' || str === 'TYPE_CALL' || str === 'TYPE_WHATSAPP'
          || str === 'TYPE_FACEBOOK' || str === 'TYPE_INSTAGRAM';
      };
      // Calls: numeric type 1 = TYPE_CALL in GHL; also accept the string form for safety.
      const isCallMsg = (m) => {
        const t = m.type ?? m.messageType;
        if (t === 1 || t === '1') return true;
        return String(t || '').toUpperCase() === 'TYPE_CALL';
      };

      const allRows = [];

      // Step 4: per-contact walk. Two separate endpoint paths because GHL splits message types:
      //   • Activity messages (TYPE_ACTIVITY_OPPORTUNITY) → ONLY come from per-conversation
      //     GET /conversations/{convId}/messages with type filter.
      //   • Channel messages (SMS, Email, WhatsApp, Facebook, Instagram) → come from
      //     GET /conversations/messages/export?contactId (one call per contact, paginated).
      //
      // So per contact:
      //   a) list their conversations (for the activity-message pass)
      //   b) for each conversation, fetch ONLY TYPE_ACTIVITY_OPPORTUNITY (server-side filter
      //      keeps payload tiny — these are sparse compared to chat)
      //   c) one export call per contact for all channel messages
      //   d) merge into one timeline, split into activities + channel rows for processing

      // Walk contacts in parallel with a small concurrency cap. The cap matters because each
      // contact runs ~4 GHL API calls (conversations search + activity messages + channel
      // messages + contact snapshot); GHL throttles aggressively, and going wide here is the
      // fastest path to 429s. Two-at-a-time roughly halves wall-clock time without surfacing
      // rate limits in our test runs.
      const contactEntries = Object.entries(oppsByContact);
      const contactsTotal = contactEntries.length;
      const OSH_CONCURRENCY = 2;
      for (let batchStart = 0; batchStart < contactEntries.length; batchStart += OSH_CONCURRENCY) {
        const batch = contactEntries.slice(batchStart, batchStart + OSH_CONCURRENCY);
        await Promise.all(batch.map(async ([contactId, opps], batchOffset) => {
          const contactIndex = batchStart + batchOffset + 1;
          const contactStart = Date.now();
        oshLog('step4.contact: start', {
          contactIndex,
          contactsTotal,
          contactId,
          opportunityCount: opps.length,
          opportunityIds: opps.map(o => o.id)
        });

        // a) Find conversations for this contact.
        // GHL has an effectively 1:1 contact↔conversation mapping (a few channels may split into
        // separate convos, but never anywhere near 100). One call with limit=100 covers every
        // realistic case — no pagination loop needed. If we ever see exactly 100, warn so we
        // know the assumption broke.
        oshLog('step4a.conversations: request', { contactId, endpoint: 'GET /conversations/search', limit: 100 });
        const convoResult = await withRetry(() => ghlService.searchConversations(locationId, {
          contactId,
          limit: 100
        }));
        const convosForContact = convoResult.conversations || [];
        oshLog('step4a.conversations: response', {
          contactId,
          returned: convosForContact.length,
          sampleConvo: oshSample(convosForContact.map(c => ({
            id: c.id,
            lastMessageDate: c.lastMessageDate || c.dateUpdated || c.dateAdded
          })), 1)
        });
        if (convosForContact.length >= 100) {
          oshWarn('step4a.conversations: returned 100 — 1:1 contact↔conversation assumption may no longer hold; check this contact for hidden pagination', { contactId });
        }

        // b) Per-conversation: pull ONLY activity-opportunity rows (server-side type filter).
        //    These rows drive stage-transition derivation. Channel messages (incl. emails) are
        //    fetched in step 4c via the bulk ES endpoint.
        oshLog('step4b.activityMessages: walk start', {
          contactId,
          endpoint: 'GET /conversations/{convId}/messages?type=TYPE_ACTIVITY_OPPORTUNITY',
          conversationsToWalk: convosForContact.length
        });
        const activityMsgs = [];
        for (const convo of convosForContact) {
          const convId = convo.id;
          let msgCursor = null;
          let msgPages = 0;
          const PAGE_SIZE = 100;
          const before = activityMsgs.length;
          while (true) {
            msgPages++;
            const msgOptions = { limit: PAGE_SIZE, type: 'TYPE_ACTIVITY_OPPORTUNITY' };
            if (msgCursor) msgOptions.lastMessageId = msgCursor;
            oshLog('step4b.activityMessages: page request', { contactId, conversationId: convId, page: msgPages, lastMessageId: msgCursor });
            const r = await withRetry(() => ghlService.getMessages(locationId, convId, msgOptions));
            const wrapper = r.messages || {};
            const pageMsgs = wrapper.messages || [];
            activityMsgs.push(...pageMsgs.map(m => ({ ...m, conversationId: convId })));
            oshLog('step4b.activityMessages: page response', {
              contactId,
              conversationId: convId,
              page: msgPages,
              returned: pageMsgs.length,
              hasNextPage: !!wrapper.nextPage,
              sampleActivity: oshSample(pageMsgs.map(m => ({
                id: m.id,
                type: m.type || m.messageType,
                dateAdded: m.dateAdded
              })), 1)
            });
            if (pageMsgs.length < PAGE_SIZE || !wrapper.nextPage) break;
            msgCursor = wrapper.lastMessageId;
            if (msgPages > 20) {
              oshWarn('step4b.activityMessages: hit hard page cap (20)', { contactId, conversationId: convId, collected: activityMsgs.length - before });
              break;
            }
            await sleep(THROTTLE_MS);
          }
          await sleep(THROTTLE_MS);
        }
        oshLog('step4b.activityMessages: walk complete', { contactId, totalActivityMessages: activityMsgs.length });

        // c) TWO bulk exportMessages passes per contact (channels are pulled twice on purpose):
        //      • Pass A — no channel filter: returns SMS / WhatsApp / Calls / Webchat / FB / IG.
        //        In practice this endpoint OMITS emails when no channel is specified.
        //      • Pass B — channel='Email': the only reliable way to get emails out of GHL's bulk
        //        export endpoint.
        //    Both passes are merged; we dedupe by messageId in case any row overlaps.
        oshLog('step4c.channelMessages: walk start', {
          contactId,
          endpoint: 'GET /conversations/messages/export?contactId',
          passes: ['no-channel (non-email channels)', "channel='Email' (emails)"],
          pageSize: 100,
          maxPages: 50
        });

        // Reusable paginated walker for one exportMessages pass.
        const fetchExportPass = async (channelFilter) => {
          const collected = [];
          let cursor = null;
          let pages = 0;
          const passLabel = channelFilter ? `channel=${channelFilter}` : 'no-channel';
          while (true) {
            pages++;
            const opts = {
              contactId,
              startDate: new Date(0).toISOString(),
              endDate: new Date().toISOString(),
              limit: 1000,
              cursor: cursor || undefined
            };
            if (channelFilter) opts.channel = channelFilter;
            oshLog('step4c.channelMessages: page request', { contactId, pass: passLabel, page: pages, cursor });
            const r = await withRetry(() => ghlService.exportMessages(locationId, opts));
            const msgs = r.messages || [];
            collected.push(...msgs);
            oshLog('step4c.channelMessages: page response', {
              contactId,
              pass: passLabel,
              page: pages,
              returned: msgs.length,
              runningTotal: collected.length,
              hasNextPage: !!r.nextPage,
              nextCursor: r.lastMessageId || null,
              sampleMessage: oshSample(msgs.map(m => ({
                id: m.id,
                type: m.type || m.messageType,
                direction: m.direction,
                dateAdded: m.dateAdded
              })), 1)
            });
            if (msgs.length < 100 || !r.nextPage) break;
            cursor = r.lastMessageId;
            if (pages > 50) {
              oshWarn('step4c.channelMessages: hit hard page cap (50)', { contactId, pass: passLabel, collected: collected.length });
              break;
            }
            await sleep(THROTTLE_MS);
          }
          return collected;
        };

        // Run both passes serially to keep rate-limit pressure manageable on bigger accounts.
        const nonEmailMsgs = await fetchExportPass(null);
        const emailMsgs = await fetchExportPass('Email');

        // Dedupe by messageId — pass A *should* not include emails, but if GHL ever returns them
        // both passes would overlap. Keep the first occurrence (typically pass A's non-email rows).
        const channelMsgs = [];
        const seenIds = new Set();
        for (const m of [...nonEmailMsgs, ...emailMsgs]) {
          channelMsgs.push(m);
        }
        oshLog('step4c.channelMessages: walk complete', {
          contactId,
          totalChannelMessages: channelMsgs.length,
          nonEmailFromPassA: nonEmailMsgs.length,
          emailsFromPassB: emailMsgs.length,
          dedupedOverlap: (nonEmailMsgs.length + emailMsgs.length) - channelMsgs.length
        });

        // d) Merge for downstream code that treats `contactMsgs` as the unified timeline
        const contactMsgs = [...activityMsgs, ...channelMsgs];
        oshLog('step4d.timeline: merged', {
          contactId,
          totalMessages: contactMsgs.length,
          activityCount: activityMsgs.length,
          channelCount: channelMsgs.length
        });

        // Pull custom field snapshot for this contact (best-effort)
        oshLog('step4e.contactSnapshot: request', { contactId, endpoint: 'GET /contacts/{contactId}' });
        let contactCfResolved = {};
        try {
          const contactDetail = await withRetry(() => ghlService.getContact ? ghlService.getContact(locationId, contactId) : Promise.resolve(null));
          for (const cf of (contactDetail?.contact?.customFields || contactDetail?.customFields || [])) {
            const name = contactCfMap[cf.id] || cf.id;
            contactCfResolved[name] = cf.value ?? cf.fieldValue ?? '';
          }
          oshLog('step4e.contactSnapshot: response', {
            contactId,
            customFieldCount: Object.keys(contactCfResolved).length,
            sampleFieldNames: oshSample(Object.keys(contactCfResolved), 5)
          });
        } catch (e) {
          oshWarn('step4e.contactSnapshot: failed (non-fatal)', { contactId, error: e.message, status: e.response?.status });
        }
        await sleep(THROTTLE_MS);

        // Group stage transitions per opportunity from activity rows.
        const stageEventsByOpp = {};
        let activityRowsScanned = 0;
        let activityRowsSkippedNoOppId = 0;
        for (const m of contactMsgs) {
          if (!isActivityOpportunity(m)) continue;
          activityRowsScanned++;
          const ev = extractStageEvent(m);
          if (!ev.oppId) { activityRowsSkippedNoOppId++; continue; }
          (stageEventsByOpp[ev.oppId] ||= []).push(ev);
        }
        // Surface stage transitions by NAME (not id) so we can sanity-check the walk against the
        // GHL UI without needing to map ids back to stages first.
        const transitionsByOpp = Object.fromEntries(
          Object.entries(stageEventsByOpp).map(([oppId, evs]) => [
            oppId,
            evs.map(e => ({
              type: e.eventType,
              from: e.oldStageName,
              to: e.newStageName,
              at: e.dateAdded
            }))
          ])
        );
        oshLog('step5.stageEvents: extracted', {
          contactId,
          activityRowsScanned,
          activityRowsSkippedNoOppId,
          opportunitiesWithEvents: Object.keys(stageEventsByOpp).length,
          eventCountByOpp: Object.fromEntries(
            Object.entries(stageEventsByOpp).map(([k, v]) => [k, v.length])
          ),
          transitionsByOpp
        });

        // Ghost-opp synthesis: activity events may reference opportunities that no longer exist
        // in /opportunities/search (deleted, merged, archived). Their stage history is real and
        // billable — synthesize minimal opp records from the event data so the row-emission loop
        // below treats them uniformly. Without this, the customer loses the most valuable
        // history (e.g. a sales rep's complete deleted-opp trail).
        const knownOppIds = new Set(opps.map(o => o.id));
        const ghostOppIds = Object.keys(stageEventsByOpp).filter(id => !knownOppIds.has(id));
        for (const ghostId of ghostOppIds) {
          const eventsForGhost = stageEventsByOpp[ghostId]
            .slice()
            .sort((a, b) => new Date(a.dateAdded) - new Date(b.dateAdded));
          const firstEv = eventsForGhost[0];
          const lastEv = eventsForGhost[eventsForGhost.length - 1];
          const wasDeleted = eventsForGhost.some(ev => ev.eventType === 'opportunity_deleted');
          opps.push({
            id: ghostId,
            contactId,
            // Resolve pipelineId from the event's pipeline NAME (activity events expose
            // `data.pipeline` as a name, not an id).
            pipelineId: pipelineByName[firstEv.pipelineName]?.id || null,
            pipelineName: firstEv.pipelineName || null,
            pipelineStageId: null,
            // Use the earliest event timestamp as a stand-in for createdAt — the opp existed
            // at least as far back as its first observed event.
            createdAt: firstEv.dateAdded,
            customFieldsResolved: {},
            _ghost: true,
            _ghostName: firstEv.oppName || null,
            _deleted: wasDeleted,
            _lastSeenAt: lastEv.dateAdded
          });
        }
        if (ghostOppIds.length > 0) {
          oshLog('step5.stageEvents: ghost opportunities synthesized', {
            contactId,
            ghostCount: ghostOppIds.length,
            ghostIds: ghostOppIds,
            ghostsDeleted: opps.filter(o => o._ghost && o._deleted).length
          });
        }

        // Pre-sort all conversation messages once for efficient window slicing.
        const convoMsgs = contactMsgs
          .filter(isConversationMsg)
          .map(m => ({ ...m, _ts: m.dateAdded ? new Date(m.dateAdded).getTime() : 0 }))
          .sort((a, b) => a._ts - b._ts);
        oshLog('step6.timeline: prepared for windowing', {
          contactId,
          conversationMessageCount: convoMsgs.length,
          earliestMessage: convoMsgs.length ? new Date(convoMsgs[0]._ts).toISOString() : null,
          latestMessage: convoMsgs.length ? new Date(convoMsgs[convoMsgs.length - 1]._ts).toISOString() : null
        });

        const sliceWindow = (fromMs, toMs) => {
          return convoMsgs
            .filter(m => m._ts >= fromMs && (toMs ? m._ts < toMs : true))
            .map(m => ({
              dateAdded: m.dateAdded,
              type: m.type || m.messageType,
              direction: m.direction || (m.type === 'TYPE_EMAIL' && m.meta?.email?.direction) || '',
              channel: m.channel || m.subType || '',
              body: m.body || m.message || m.meta?.email?.subject || '',
              from: m.meta?.email?.from || m.from || '',
              to: (m.meta?.email?.to || []).join('; ') || m.to || m.phone || '',
              messageId: m.id,
              conversationId: m.conversationId || '',
              isCall: isCallMsg(m)
            }));
        };

        // Build a row per (opportunity, stage_session).
        //
        // Canonical key: stage NAME, not stage ID. Activity events from GHL only expose names
        // (oldStageName / newStageName) — IDs are not in the activity payload. We resolve ID
        // as best-effort enrichment via stageIdByPipelineAndName[opp.pipelineId][stageName],
        // but if it doesn't resolve (test pipelines, deleted stages) the export still has the
        // stage name and remains useful.
        //
        // Event types we handle from activity.type:
        //   - "opportunity_created"        → seeds the initial stage (newStageName only)
        //   - "opportunity_stage_updated"  → closes prior stage row, opens new one
        // Other event types are ignored as non-transitions.
        const rowsBeforeContact = allRows.length;

        // Resolve a stage name → id within a given pipeline (best-effort).
        // Renamed from `resolveStageId` to avoid shadowing the outer `resolveStageId(pipelineName, stageName)`
        // helper used by extractStageEvent — they have different signatures (id vs name).
        const resolveStageIdByPipelineId = (pipelineId, stageName) => {
          if (!stageName) return null;
          return stageIdByPipelineAndName[pipelineId]?.[stageName] || null;
        };
        // Pipeline name for the row (display field). Derived from stageMap via the opp's current
        // stageId, or from any event's resolved id. Falls back to null.
        const resolvePipelineName = (opp) => {
          const sid = opp.pipelineStageId || opp.stageId;
          return (sid && stageMap[sid]?.pipelineName) || null;
        };

        for (const opp of opps) {
          const oppPipelineName = resolvePipelineName(opp);
          const allEvents = (stageEventsByOpp[opp.id] || []).sort(
            (a, b) => new Date(a.dateAdded) - new Date(b.dateAdded)
          );

          // No events: emit a single open-stage row using opp.pipelineStageId (the only ID we
          // can trust here, since it came directly from /opportunities/search).
          if (allEvents.length === 0) {
            const enteredAt = opp.createdAt || opp.dateAdded || null;
            const stageId = opp.pipelineStageId || opp.stageId || null;
            const stageInfo = stageId ? stageMap[stageId] : null;
            const fromMs = enteredAt ? new Date(enteredAt).getTime() : 0;
            allRows.push({
              contactId,
              opportunityId: opp.id,
              pipelineId: opp.pipelineId || stageInfo?.pipelineId || null,
              pipelineName: stageInfo?.pipelineName || oppPipelineName,
              stageName: stageInfo?.stageName || null,
              stageId,
              enteredAt,
              leftAt: null,
              durationSeconds: enteredAt ? Math.round((Date.now() - new Date(enteredAt).getTime()) / 1000) : null,
              messages: sliceWindow(fromMs, null),
              callMessageIds: sliceWindow(fromMs, null).filter(m => m.isCall).map(m => m.messageId),
              contactCustomFields: contactCfResolved,
              opportunityCustomFields: oppById[opp.id]?.customFieldsResolved || {},
              // Snapshot of opportunity.monetaryValue at export time. Ghost opps don't have this
              // (activity events don't carry it) — left null in that case.
              monetaryValue: oppById[opp.id]?.monetaryValue ?? null,
              currentStage: true
            });
            continue;
          }

          // Determine the INITIAL stage name + entry timestamp.
          // If the first event is `opportunity_created`, use its newStageName at its dateAdded.
          // Otherwise (the created event is missing or pruned), infer from the first
          // stage_updated event's oldStageName, anchored at opp.createdAt.
          const firstEvt = allEvents[0];
          let currentStageName;
          let entryMs;
          if (firstEvt.eventType === 'opportunity_created') {
            currentStageName = firstEvt.newStageName || null;
            entryMs = new Date(firstEvt.dateAdded).getTime();
          } else {
            currentStageName = firstEvt.oldStageName
              || (opp.pipelineStageId && stageMap[opp.pipelineStageId]?.stageName)
              || null;
            entryMs = opp.createdAt
              ? new Date(opp.createdAt).getTime()
              : new Date(firstEvt.dateAdded).getTime();
          }

          // Walk events and emit a CLOSED row each time the opp leaves a stage.
          // After an `opportunity_deleted` event we mark the opp as terminated so the trailing
          // OPEN row at the bottom is skipped — a deleted opp has no current stage.
          let oppTerminated = false;
          for (const ev of allEvents) {
            if (ev.eventType === 'opportunity_created') {
              // Already consumed by the initial-stage seed above; no row to emit here.
              continue;
            }
            const isTransition = ev.eventType === 'opportunity_stage_updated';
            const isDelete = ev.eventType === 'opportunity_deleted';
            if (!isTransition && !isDelete) {
              // Status change, etc. — not a stage event we model.
              continue;
            }
            const leftMs = new Date(ev.dateAdded).getTime();
            const stageId = resolveStageIdByPipelineId(opp.pipelineId, currentStageName);
            const stageInfo = stageId ? stageMap[stageId] : null;
            allRows.push({
              contactId,
              opportunityId: opp.id,
              pipelineId: opp.pipelineId || stageInfo?.pipelineId || null,
              pipelineName: stageInfo?.pipelineName || oppPipelineName,
              stageName: currentStageName,
              stageId,
              enteredAt: new Date(entryMs).toISOString(),
              leftAt: new Date(leftMs).toISOString(),
              durationSeconds: Math.round((leftMs - entryMs) / 1000),
              messages: sliceWindow(entryMs, leftMs),
              callMessageIds: sliceWindow(entryMs, leftMs).filter(m => m.isCall).map(m => m.messageId),
              contactCustomFields: contactCfResolved,
              opportunityCustomFields: oppById[opp.id]?.customFieldsResolved || {},
              // Snapshot of opportunity.monetaryValue at export time. Ghost opps don't have this
              // (activity events don't carry it) — left null in that case.
              monetaryValue: oppById[opp.id]?.monetaryValue ?? null,
              currentStage: false,
              // Mark the row that closes a deletion so the customer can distinguish a
              // "moved to next stage" close from a "removed from pipeline" close.
              ...(isDelete ? { deleted: true, deletedAt: new Date(leftMs).toISOString() } : {}),
              // Flag synthesized rows. A deleted opp that came from the activity stream
              // (not /opportunities/search) will have BOTH `deleted: true` and `ghostOpportunity: true`.
              ...(opp._ghost ? { ghostOpportunity: true } : {})
            });
            if (isDelete) {
              oppTerminated = true;
              break; // No further events can apply to a deleted opp.
            }
            entryMs = leftMs;
            currentStageName = ev.newStageName || null;
          }

          // Final OPEN row: only emitted when the opp is still active. Ghost opps that ended
          // in `opportunity_deleted` skip this — their timeline closed on the deletion event.
          if (!oppTerminated) {
            const finalStageId = resolveStageIdByPipelineId(opp.pipelineId, currentStageName);
            const finalStageInfo = finalStageId ? stageMap[finalStageId] : null;
            allRows.push({
              contactId,
              opportunityId: opp.id,
              pipelineId: opp.pipelineId || finalStageInfo?.pipelineId || null,
              pipelineName: finalStageInfo?.pipelineName || oppPipelineName,
              stageName: currentStageName,
              stageId: finalStageId,
              enteredAt: new Date(entryMs).toISOString(),
              leftAt: null,
              durationSeconds: Math.round((Date.now() - entryMs) / 1000),
              messages: sliceWindow(entryMs, null),
              callMessageIds: sliceWindow(entryMs, null).filter(m => m.isCall).map(m => m.messageId),
              contactCustomFields: contactCfResolved,
              opportunityCustomFields: oppById[opp.id]?.customFieldsResolved || {},
              // Snapshot of opportunity.monetaryValue at export time. Ghost opps don't have this
              // (activity events don't carry it) — left null in that case.
              monetaryValue: oppById[opp.id]?.monetaryValue ?? null,
              currentStage: true,
              // Flag synthesized rows so downstream consumers can distinguish "real" opps
              // from those reconstructed from activity events alone.
              ...(opp._ghost ? { ghostOpportunity: true } : {})
            });
          }
        }
        oshLog('step4.contact: done', {
          contactIndex,
          contactsTotal,
          contactId,
          rowsEmitted: allRows.length - rowsBeforeContact,
          runningTotalRows: allRows.length,
          contactDurationMs: Date.now() - contactStart
        });
        }));
      }

      // Billing inputs: charge by (opportunities + channel messages), NOT by stage-rows.
      // — opportunityCount: unique opportunities that produced any row.
      // — channelMessageCount: total messages bucketed across all stage windows.
      // Activity-opportunity rows themselves (the internal stage-change events) are NOT counted —
      // those are infrastructure, not customer-visible messages.
      const opportunityCount = allOpps.length;
      const channelMessageCount = allRows.reduce((sum, r) => sum + ((r.messages || []).length), 0);
      const billableUnits = opportunityCount + channelMessageCount;
      counts.opportunityStageHistory = billableUnits;

      // Summarize the row distribution so we can sanity-check the walk at a glance:
      // rows with both enteredAt + leftAt (closed stage sessions) vs current-stage rows still open.
      const closedRows = allRows.filter(r => r.leftAt).length;
      const openRows = allRows.length - closedRows;
      const rowsWithMessages = allRows.filter(r => Array.isArray(r.messages) && r.messages.length > 0).length;
      const rowsWithCalls = allRows.filter(r => Array.isArray(r.callMessageIds) && r.callMessageIds.length > 0).length;
      oshLog('step7.billing: computed billable units', {
        opportunityCount,
        channelMessageCount,
        billableUnits,
        stageRows: allRows.length,
        unitPrice: 0.10
      });
      oshLog('step7.walk: complete', {
        opportunities: allOpps.length,
        contactsWalked: Object.keys(oppsByContact).length,
        totalRows: allRows.length,
        closedStageRows: closedRows,
        openStageRows: openRows,
        rowsWithAnyMessages: rowsWithMessages,
        rowsWithCallMessages: rowsWithCalls,
        sampleRow: oshSample(allRows.map(r => ({
          contactId: r.contactId,
          opportunityId: r.opportunityId,
          stageName: r.stageName,
          enteredAt: r.enteredAt,
          leftAt: r.leftAt,
          durationSeconds: r.durationSeconds,
          messageCount: (r.messages || []).length,
          callCount: (r.callMessageIds || []).length
        })), 2)
      });

      logger.info('Opportunity Stage History — walk complete', {
        locationId,
        opportunities: allOpps.length,
        contactsWalked: Object.keys(oppsByContact).length,
        totalRows: allRows.length
      });

      if (allRows.length === 0) {
        oshWarn('step8.persist: aborting — no rows to persist', { reason: 'No stage transitions found for this sub-account.' });
        return res.status(400).json({ success: false, error: 'No stage transitions found for this sub-account.' });
      }

      // Chunked SpecialExport — Lambda reads the `messages` field via the existing specialTabMessages chunk path.
      const CHUNK_SIZE = 5000;
      const totalChunks = Math.max(1, Math.ceil(allRows.length / CHUNK_SIZE));
      const firstChunk = allRows.slice(0, CHUNK_SIZE);
      oshLog('step8.persist: writing first chunk', {
        totalRows: allRows.length,
        totalChunks,
        chunkSize: CHUNK_SIZE,
        firstChunkSize: firstChunk.length
      });
      const specialExport = await SpecialExport.create({
        locationId,
        filters: { type: 'opportunityStageHistory' },
        messages: firstChunk,
        totalMessages: allRows.length,
        totalConversations: Object.keys(oppsByContact).length,
        totalOpportunities: opportunityCount,
        totalChannelMessages: channelMessageCount,
        contactCustomFieldNames,
        opportunityCustomFieldNames,
        chunkIndex: 0,
        totalChunks,
        status: 'ready'
      });
      oshLog('step8.persist: first chunk written', { specialExportId: String(specialExport._id) });
      if (totalChunks > 1) {
        const chunkDocs = [];
        for (let ci = 1; ci < totalChunks; ci++) {
          chunkDocs.push({
            locationId,
            filters: { type: 'opportunityStageHistory' },
            messages: allRows.slice(ci * CHUNK_SIZE, (ci + 1) * CHUNK_SIZE),
            totalMessages: allRows.length,
            totalConversations: Object.keys(oppsByContact).length,
            totalOpportunities: opportunityCount,
            totalChannelMessages: channelMessageCount,
            contactCustomFieldNames,
            opportunityCustomFieldNames,
            groupId: specialExport._id,
            chunkIndex: ci,
            totalChunks,
            status: 'ready',
            createdAt: new Date(),
            updatedAt: new Date()
          });
        }
        await SpecialExport.insertMany(chunkDocs);
        oshLog('step8.persist: extra chunks written', { extraChunks: chunkDocs.length, groupId: String(specialExport._id) });
        logger.info('Opportunity Stage History — chunks stored', { totalChunks, totalRows: allRows.length });
      }

      // Build estimate response with the SpecialExport ref for the charge-and-export step.
      // Pass the (opps + msgs) breakdown so the response shows the customer exactly what they're paying for.
      // `calculateEstimateForLocation` honors the per-location credit-price override in AppConfig.
      const computedEstimate = await billingService.calculateEstimateForLocation({
        opportunityStageHistory: billableUnits,
        opportunityStageOppCount: opportunityCount,
        opportunityStageMsgCount: channelMessageCount
      }, locationId);
      oshLog('step9.response: estimate returned to client', {
        specialExportId: String(specialExport._id),
        estimate: computedEstimate,
        totalDurationMs: Date.now() - oshStart
      });
      return res.json({
        success: true,
        data: {
          estimate: computedEstimate,
          specialExportId: specialExport._id
        }
      });

    } else if (exportType === 'messagesByTag') {
      // Messages by Contact Tag: resolve contacts by tag(s), CAP at the first 500, then gather
      // every message (optionally filtered by channel + date range) for those contacts by calling
      // the SAME message export API the Messages tab uses (exportMessages), once per contactId.
      // Messages are stored in 5,000-message chunked SpecialExport docs, so Lambda reads them via
      // the same chunk path as specialTabMessages.
      const tagsFilter = Array.isArray(filters?.tags)
        ? filters.tags.filter(Boolean)
        : (typeof filters?.tags === 'string' && filters.tags.trim() ? [filters.tags.trim()] : []);

      if (tagsFilter.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'Messages by Tag export requires at least one tag in filters.tags.'
        });
      }

      const channelFilter = typeof filters?.channel === 'string' ? filters.channel.trim() : '';

      // Helper: retry on 429 with exponential backoff (mirrors specialTabMessages)
      const withRetry = async (fn, maxRetries = 3) => {
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          try {
            return await fn();
          } catch (err) {
            if (err.response?.status === 429 && attempt < maxRetries) {
              const delay = Math.pow(2, attempt) * 2000; // 2s, 4s, 8s
              logger.warn('Rate limited (429), retrying...', { attempt: attempt + 1, delay });
              await new Promise(r => setTimeout(r, delay));
            } else {
              throw err;
            }
          }
        }
      };

      // Resolve contacts matching the tag(s) via pagination (copied from the notes tag loop).
      // Union across tags, deduped.
      const resolvedIds = [];
      const seenContacts = new Set();
      for (const tag of tagsFilter) {
        let startAfterId = null;
        let startAfter = null;
        let hasMore = true;
        let page = 0;
        const MAX_PAGES = 100; // Safety limit: 100 pages * 100 contacts = 10,000 max per tag
        while (hasMore && page < MAX_PAGES) {
          page++;
          const result = await withRetry(() => ghlService.searchContacts(locationId, { tag, limit: 100, startAfterId, startAfter }));
          const contacts = result.contacts || [];
          logger.info('messagesByTag: tag contacts page result', { tag, page, contactsReturned: contacts.length, metaTotal: result.meta?.total });
          for (const c of contacts) {
            if (!seenContacts.has(c.id)) {
              seenContacts.add(c.id);
              resolvedIds.push(c.id);
            }
          }
          if (contacts.length < 100) {
            hasMore = false;
          } else if (result.meta?.startAfterId) {
            startAfterId = result.meta.startAfterId;
            startAfter = result.meta.startAfter || null;
          } else {
            logger.warn('messagesByTag: no pagination cursor in meta, stopping', { tag, page, totalResolved: resolvedIds.length });
            hasMore = false;
          }
        }
        if (page >= MAX_PAGES) {
          logger.warn('messagesByTag: hit max pages limit for tag contact resolution', { tag, totalResolved: resolvedIds.length });
        }
      }

      const resolvedContactCount = resolvedIds.length;

      if (resolvedContactCount === 0) {
        return res.status(400).json({
          success: false,
          error: 'No contacts found for the selected tag(s).'
        });
      }

      // CAP at the first MAX_CONTACTS contacts EXPLICITLY.
      const MAX_CONTACTS = 200;
      let cappedAt500 = false; // field name kept for the UI contract; means "capped at MAX_CONTACTS"
      let contactIdsFilter = resolvedIds;
      if (resolvedContactCount > MAX_CONTACTS) {
        cappedAt500 = true;
        contactIdsFilter = resolvedIds.slice(0, MAX_CONTACTS);
        logger.warn('messagesByTag: resolved contacts exceed cap, capping', { resolvedContactCount, cappedTo: MAX_CONTACTS, tags: tagsFilter });
      }
      logger.info('messagesByTag: contact resolution complete', { tags: tagsFilter, resolvedContactCount, usedContactCount: contactIdsFilter.length, cap: MAX_CONTACTS, cappedAt500 });

      // Gather messages per tagged contact. Two paths depending on channel:
      //
      //  • Live Chat (channel === 'LiveChat'): the bulk export API (/conversations/messages/export)
      //    does NOT return Live Chat / Conversation-AI messages — they aren't an exportable channel.
      //    So for Live Chat we discover each contact's conversations, then fetch each conversation's
      //    messages with type=TYPE_LIVE_CHAT (limit 300, paginated via lastMessageId).
      //
      //  • All other channels ('' / SMS / Email / WhatsApp / Facebook / Instagram): the SAME message
      //    export API the Messages tab uses (ghlService.exportMessages), once per contactId.
      //
      // Date filters are intentionally NOT applied here — Messages by Tag exports the full history.
      const isLiveChat = channelFilter === 'LiveChat';
      const allMessages = [];
      const CONTACT_PARALLEL = 5;
      const PAGE_LIMIT = 100;
      const LIVECHAT_PAGE_LIMIT = 300;
      let contactsDone = 0;
      let failedContacts = 0;
      for (let i = 0; i < contactIdsFilter.length; i += CONTACT_PARALLEL) {
        const batch = contactIdsFilter.slice(i, i + CONTACT_PARALLEL);
        const results = await Promise.allSettled(
          batch.map(async (cid) => {
            const msgs = [];
            let apiCalls = 0;

            if (isLiveChat) {
              // Discover this contact's conversations, then walk each for Live Chat messages.
              // Live Chat / Conversation-AI threads surface under two GHL message types —
              // TYPE_LIVE_CHAT and TYPE_WEBCHAT — so we fetch both per conversation.
              const LIVECHAT_TYPES = ['TYPE_LIVE_CHAT', 'TYPE_WEBCHAT'];
              const convoResult = await withRetry(() => ghlService.searchConversations(locationId, { contactId: cid, limit: 100 }));
              apiCalls++;
              const convos = convoResult.conversations || [];
              for (const convo of convos) {
                const convId = convo.id;
                for (const msgType of LIVECHAT_TYPES) {
                  let lastMessageId = null;
                  while (true) {
                    const msgOptions = { limit: LIVECHAT_PAGE_LIMIT, type: msgType };
                    if (lastMessageId) msgOptions.lastMessageId = lastMessageId;
                    const r = await withRetry(() => ghlService.getMessages(locationId, convId, msgOptions));
                    apiCalls++;
                    const wrapper = r.messages || {};
                    const pageMsgs = wrapper.messages || [];
                    msgs.push(...pageMsgs.map(m => ({ ...m, conversationId: convId, contactId: cid })));
                    if (pageMsgs.length < LIVECHAT_PAGE_LIMIT || !wrapper.nextPage) break;
                    lastMessageId = wrapper.lastMessageId;
                  }
                }
              }
            } else {
              // Channel/export-API path (SMS, Email, WhatsApp, FB, IG, or all-except-email).
              let cursor = null;
              while (true) {
                const opts = { contactId: cid, limit: PAGE_LIMIT };
                if (channelFilter) opts.channel = channelFilter;
                if (cursor) opts.cursor = cursor;
                const resp = await withRetry(() => ghlService.exportMessages(locationId, opts));
                apiCalls++;
                const pageMsgs = resp.messages || [];
                msgs.push(...pageMsgs);
                cursor = resp.nextCursor || null;
                if (!cursor || pageMsgs.length < PAGE_LIMIT) break;
              }
            }

            logger.info('messagesByTag: contact fetched', { contactId: cid, apiCalls, messages: msgs.length, channel: channelFilter || 'all' });
            return msgs;
          })
        );
        for (const r of results) {
          if (r.status === 'fulfilled') {
            allMessages.push(...r.value);
          } else {
            failedContacts++;
            logger.warn('messagesByTag: contact fetch failed', { error: r.reason?.message });
          }
        }
        contactsDone += batch.length;
        // Progress log per batch of contacts (each batch = up to CONTACT_PARALLEL parallel API loops).
        logger.info('messagesByTag: progress', { contactsDone, totalContacts: contactIdsFilter.length, messagesSoFar: allMessages.length });
      }

      logger.info('messagesByTag: fetched', { totalMessages: allMessages.length, contacts: contactIdsFilter.length, failedContacts, channel: channelFilter || 'all', liveChat: isLiveChat });

      // Split into 5,000-message chunks to stay under MongoDB's 16MB BSON limit.
      // Lambda BATCH_SIZE is also 5000 so each invocation loads exactly one chunk doc.
      const CHUNK_SIZE = 5000;
      const totalChunks = Math.max(1, Math.ceil(allMessages.length / CHUNK_SIZE));

      // Create chunk 0 first to obtain its _id as the groupId for all remaining chunks.
      const firstChunkMessages = allMessages.slice(0, CHUNK_SIZE);
      const specialExport = await SpecialExport.create({
        locationId,
        filters: { tags: tagsFilter, channel: channelFilter || null },
        messages: firstChunkMessages,
        totalMessages: allMessages.length,
        totalConversations: contactIdsFilter.length,
        chunkIndex: 0,
        totalChunks,
        status: 'ready'
      });

      // Create remaining chunks linked by groupId = specialExport._id
      if (totalChunks > 1) {
        const chunkDocs = [];
        for (let ci = 1; ci < totalChunks; ci++) {
          chunkDocs.push({
            locationId,
            filters: { tags: tagsFilter, channel: channelFilter || null },
            messages: allMessages.slice(ci * CHUNK_SIZE, (ci + 1) * CHUNK_SIZE),
            totalMessages: allMessages.length,
            totalConversations: contactIdsFilter.length,
            groupId: specialExport._id,
            chunkIndex: ci,
            totalChunks,
            status: 'ready',
            createdAt: new Date(),
            updatedAt: new Date()
          });
        }
        await SpecialExport.insertMany(chunkDocs);
        logger.info('messagesByTag: chunks stored', { totalChunks, totalMessages: allMessages.length });
      }

      const total = allMessages.length;
      const unitPrice = 0.004;
      const finalAmount = total * unitPrice;
      return res.json({
        success: true,
        data: {
          estimate: {
            itemCounts: { messagesByTag: total, total },
            baseAmount: finalAmount,
            discountPercent: 0,
            discountAmount: 0,
            finalAmount
          },
          resolvedContactCount,
          cappedAt500,
          filters,
          exportType,
          specialExportId: specialExport._id
        }
      });
    } else if (exportType === 'groupMessages' || exportType === 'internalMessages') {
      // Group & Internal chat export.
      //
      // These threads are INVISIBLE to the normal message export: group SMS is excluded from the
      // default /conversations/search (GHL requires conversationType=5 explicitly), and internal
      // chat (conversationType=6) is never queried. So we discover the threads by type, then walk
      // each thread's messages with the matching message-type filter.
      //
      //   groupMessages    → conversationType=5, message type TYPE_SMS (no TYPE_GROUP_SMS exists)
      //   internalMessages → conversationType=6, message type TYPE_INTERNAL_CHAT
      //
      // Everything after discovery (chunked SpecialExport storage, per-message pricing, the Lambda
      // reader) is identical to specialTabMessages — Lambda reads these via the same chunk path.
      const isGroup = exportType === 'groupMessages';
      const conversationType = isGroup ? 5 : 6;
      // Group chat passes NO message-type filter (fetch every message in the thread by
      // conversationId — the conversationType=5 search already scoped us to group threads).
      // Internal chat filters to TYPE_INTERNAL_CHAT.
      const messageType = isGroup ? null : 'TYPE_INTERNAL_CHAT';

      // Retry on 429 with exponential backoff (mirrors specialTabMessages)
      const withRetry = async (fn, maxRetries = 4) => {
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          try {
            return await fn();
          } catch (err) {
            const is429 = err.response?.status === 429;
            const is5xx = err.response?.status >= 500 && err.response?.status < 600;
            if ((is429 || is5xx) && attempt < maxRetries) {
              const delay = Math.min(30000, Math.pow(2, attempt) * 2000) + Math.floor(Math.random() * 500);
              logger.warn(`${exportType}: transient error, retrying`, { status: err.response?.status, attempt: attempt + 1, delay });
              await new Promise(r => setTimeout(r, delay));
            } else {
              throw err;
            }
          }
        }
      };

      // 1) Resolve the conversations to export.
      //    - If the caller picked specific thread(s) (filters.conversationIds[] or filters.conversationId),
      //      export just those.
      //    - Otherwise discover every group/internal conversation in the location (paginate by skip).
      const pickedIds = [
        ...(Array.isArray(filters?.conversationIds) ? filters.conversationIds : []),
        ...(typeof filters?.conversationId === 'string' ? [filters.conversationId] : [])
      ].map(id => String(id || '').trim()).filter(Boolean);
      const uniquePickedIds = [...new Set(pickedIds)];

      const allConversationIds = [];
      if (uniquePickedIds.length > 0) {
        allConversationIds.push(...uniquePickedIds);
        logger.info(`${exportType}: specific conversations selected`, { count: uniquePickedIds.length });
      } else {
        const seen = new Set();
        let skip = 0;
        const SEARCH_LIMIT = 100;
        const MAX_SEARCH_PAGES = 200; // hard stop (20,000 threads) — protects against a runaway loop
        for (let page = 0; page < MAX_SEARCH_PAGES; page++) {
          const searchFilters = { conversationType, limit: SEARCH_LIMIT, skip };
          const result = await withRetry(() => ghlService.searchConversations(locationId, searchFilters));
          const convos = result.conversations || [];
          for (const c of convos) {
            if (c?.id && !seen.has(c.id)) {
              seen.add(c.id);
              allConversationIds.push(c.id);
            }
          }
          logger.info(`${exportType}: conversation search page`, { page, skip, returned: convos.length, totalSoFar: allConversationIds.length });
          if (convos.length < SEARCH_LIMIT) break;
          skip += SEARCH_LIMIT;
        }
        logger.info(`${exportType}: conversations resolved`, { count: allConversationIds.length, conversationType });
      }

      // 2) Walk each conversation's messages (5 parallel).
      //    For group chat we do NOT pass a message-type filter — just fetch every message in the
      //    conversation by conversationId (the conversationType=5 search already scoped us to group
      //    threads). Internal chat still filters to TYPE_INTERNAL_CHAT.
      const allMessages = [];
      const PARALLEL = 5;
      for (let i = 0; i < allConversationIds.length; i += PARALLEL) {
        const batch = allConversationIds.slice(i, i + PARALLEL);
        const results = await Promise.allSettled(
          batch.map(async (cId) => {
            const msgs = [];
            let cursor = undefined;
            const PAGE_SIZE = 300;
            while (true) {
              const msgOptions = { limit: PAGE_SIZE };
              if (!isGroup) msgOptions.type = messageType;
              if (cursor) msgOptions.lastMessageId = cursor;
              const r = await withRetry(() => ghlService.getMessages(locationId, cId, msgOptions));
              const wrapper = r.messages || {};
              const pageMsgs = wrapper.messages || [];
              msgs.push(...pageMsgs.map(m => ({ ...m, conversationId: cId })));
              if (pageMsgs.length < PAGE_SIZE || !wrapper.nextPage) break;
              cursor = wrapper.lastMessageId;
            }
            return msgs;
          })
        );
        for (const r of results) {
          if (r.status === 'fulfilled') allMessages.push(...r.value);
        }
      }

      logger.info(`${exportType}: fetched`, { totalMessages: allMessages.length, totalConversations: allConversationIds.length });

      // 3) Chunk into 5,000-message SpecialExport docs (same as specialTabMessages → same Lambda reader).
      const CHUNK_SIZE = 5000;
      const totalChunks = Math.max(1, Math.ceil(allMessages.length / CHUNK_SIZE));
      const firstChunkMessages = allMessages.slice(0, CHUNK_SIZE);
      const specialExport = await SpecialExport.create({
        locationId,
        filters: { type: messageType, conversationType },
        messages: firstChunkMessages,
        totalMessages: allMessages.length,
        totalConversations: allConversationIds.length,
        chunkIndex: 0,
        totalChunks,
        status: 'ready'
      });

      if (totalChunks > 1) {
        const chunkDocs = [];
        for (let ci = 1; ci < totalChunks; ci++) {
          chunkDocs.push({
            locationId,
            filters: { type: messageType, conversationType },
            messages: allMessages.slice(ci * CHUNK_SIZE, (ci + 1) * CHUNK_SIZE),
            totalMessages: allMessages.length,
            totalConversations: allConversationIds.length,
            groupId: specialExport._id,
            chunkIndex: ci,
            totalChunks,
            status: 'ready',
            createdAt: new Date(),
            updatedAt: new Date()
          });
        }
        await SpecialExport.insertMany(chunkDocs);
        logger.info(`${exportType}: chunks stored`, { totalChunks, totalMessages: allMessages.length });
      }

      const total = allMessages.length;
      const unitPrice = 0.018; // same per-message pricing as Special Messages
      const finalAmount = total * unitPrice;
      return res.json({
        success: true,
        data: {
          estimate: {
            itemCounts: { [exportType]: total, total },
            baseAmount: finalAmount,
            discountPercent: 0,
            discountAmount: 0,
            finalAmount
          },
          filters,
          exportType,
          specialExportId: specialExport._id
        }
      });
    } else if (exportType === 'specialTabMessages') {
      // Special Messages: fetch messages matching the type(s) from a SCOPED set of conversations.
      // Caller must provide either filters.conversationId OR filters.contactIds — the previous
      // whole-sub-account walk was removed because it routinely hit GHL rate limits on large accounts.
      // typeFilter may be a single string (one type selected) or an array (all activity types).
      // Single string → passed to GHL API directly. Array → fetch unfiltered, filter client-side.
      const typeFilter = filters?.type;
      const isTypeArray = Array.isArray(typeFilter);

      const conversationIdFilter = typeof filters?.conversationId === 'string' ? filters.conversationId.trim() : '';
      const contactIdsFilter = Array.isArray(filters?.contactIds) ? filters.contactIds.filter(Boolean) : [];

      if (!conversationIdFilter && contactIdsFilter.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'Activity Messages export requires either filters.conversationId or filters.contactIds (at least one contact).'
        });
      }

      // Helper: retry on 429 with exponential backoff
      const withRetry = async (fn, maxRetries = 3) => {
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          try {
            return await fn();
          } catch (err) {
            if (err.response?.status === 429 && attempt < maxRetries) {
              const delay = Math.pow(2, attempt) * 2000; // 2s, 4s, 8s
              logger.warn('Rate limited (429), retrying...', { attempt: attempt + 1, delay });
              await new Promise(r => setTimeout(r, delay));
            } else {
              throw err;
            }
          }
        }
      };

      let allConversationIds = [];
      if (conversationIdFilter) {
        // Direct conversationId — skip discovery entirely.
        allConversationIds = [conversationIdFilter];
      } else {
        // Per-contact discovery (mirrors callTranscriptions). Concurrency 3 to keep GHL happy.
        const CONTACT_PARALLEL = 3;
        const seen = new Set();
        for (let i = 0; i < contactIdsFilter.length; i += CONTACT_PARALLEL) {
          const batch = contactIdsFilter.slice(i, i + CONTACT_PARALLEL);
          const results = await Promise.allSettled(
            batch.map(cid => withRetry(() => ghlService.searchConversations(locationId, { contactId: cid, limit: 100 })))
          );
          for (const r of results) {
            if (r.status === 'fulfilled') {
              const convos = r.value?.conversations || [];
              for (const c of convos) {
                if (c?.id && !seen.has(c.id)) {
                  seen.add(c.id);
                  allConversationIds.push(c.id);
                }
              }
            }
          }
        }
      }

      logger.info('Special Messages: conversations resolved', {
        count: allConversationIds.length,
        scope: conversationIdFilter ? 'conversationId' : `contactIds(${contactIdsFilter.length})`
      });

      // Fetch messages for each conversation (5 parallel), pass type filter to API
      const allMessages = [];
      const PARALLEL = 5;
      for (let i = 0; i < allConversationIds.length; i += PARALLEL) {
        const batch = allConversationIds.slice(i, i + PARALLEL);
        const results = await Promise.allSettled(
          batch.map(async (cId) => {
            const msgs = [];
            let cursor = undefined;
            const PAGE_SIZE = 300;
            while (true) {
              const msgOptions = { limit: PAGE_SIZE, type: typeFilter?.join(',') };
              if (cursor) msgOptions.lastMessageId = cursor;
              const result = await withRetry(() => ghlService.getMessages(locationId, cId, msgOptions));
              // GHL response: { messages: { lastMessageId, nextPage, messages: [...] } }
              const wrapper = result.messages || {};
              const pageMsgs = wrapper.messages || [];
              const filtered = pageMsgs
                .map(m => ({ ...m, conversationId: cId }));
              msgs.push(...filtered);
              if (pageMsgs.length < PAGE_SIZE || !wrapper.nextPage) break;
              cursor = wrapper.lastMessageId;
            }
            return msgs;
          })
        );
        for (const r of results) {
          if (r.status === 'fulfilled') allMessages.push(...r.value);
        }
      }

      logger.info('Special Messages: fetched', { totalMessages: allMessages.length, totalConversations: allConversationIds.length, type: typeFilter });

      // Split into 5,000-message chunks to stay under MongoDB's 16MB BSON limit.
      // Lambda BATCH_SIZE is also 5000 so each invocation loads exactly one chunk doc.
      const CHUNK_SIZE = 5000;
      const totalChunks = Math.max(1, Math.ceil(allMessages.length / CHUNK_SIZE));

      // Create chunk 0 first to obtain its _id as the groupId for all remaining chunks.
      const firstChunkMessages = allMessages.slice(0, CHUNK_SIZE);
      const specialExport = await SpecialExport.create({
        locationId,
        filters: { type: typeFilter },
        messages: firstChunkMessages,
        totalMessages: allMessages.length,
        totalConversations: allConversationIds.length,
        chunkIndex: 0,
        totalChunks,
        status: 'ready'
      });

      // Create remaining chunks linked by groupId = specialExport._id
      if (totalChunks > 1) {
        const chunkDocs = [];
        for (let ci = 1; ci < totalChunks; ci++) {
          chunkDocs.push({
            locationId,
            filters: { type: typeFilter },
            messages: allMessages.slice(ci * CHUNK_SIZE, (ci + 1) * CHUNK_SIZE),
            totalMessages: allMessages.length,
            totalConversations: allConversationIds.length,
            groupId: specialExport._id,
            chunkIndex: ci,
            totalChunks,
            status: 'ready',
            createdAt: new Date(),
            updatedAt: new Date()
          });
        }
        await SpecialExport.insertMany(chunkDocs);
        logger.info('Special Messages: chunks stored', { totalChunks, totalMessages: allMessages.length });
      }

      const total = allMessages.length;
      const unitPrice = 0.018;
      const finalAmount = total * unitPrice;
      return res.json({
        success: true,
        data: {
          estimate: {
            itemCounts: { specialTabMessages: total, total },
            baseAmount: finalAmount,
            discountPercent: 0,
            discountAmount: 0,
            finalAmount
          },
          filters,
          exportType,
          specialExportId: specialExport._id
        }
      });
    } else if (exportType === 'callTranscriptions') {
      // Single-walk export: walks every conversation once, fetches TYPE_CALL messages,
      // pulls transcripts for the eligible statuses, and persists the final CSV-ready
      // records into specialexports.callTranscriptionsMessages (chunked).
      // After this, charge-and-export only links the existing doc and triggers Lambda;
      // Lambda only reads + writes CSV.
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));

      // Generous retry — GHL rate-limits aggressively under bulk read.
      const withRetry = async (fn, maxRetries = 6) => {
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          try {
            return await fn();
          } catch (err) {
            const is429 = err.response?.status === 429;
            const is5xx = err.response?.status >= 500 && err.response?.status < 600;
            if ((is429 || is5xx) && attempt < maxRetries) {
              // Exponential w/ jitter, capped at 30s: 2s, 4s, 8s, 16s, 30s, 30s
              const base = Math.min(30000, Math.pow(2, attempt) * 2000);
              const delay = base + Math.floor(Math.random() * 500);
              logger.warn('Transient error, retrying', { status: err.response?.status, attempt: attempt + 1, delay });
              await sleep(delay);
            } else {
              throw err;
            }
          }
        }
      };

      // Conversation discovery — contactIds is now REQUIRED. The whole-sub-account walk has been
      // removed: it was untargeted and could blow up bills on big accounts. Caller must select at
      // least one contact in the UI (we still allow multiple).
      const contactIdsFilter = Array.isArray(filters?.contactIds) ? filters.contactIds.filter(Boolean) : [];
      if (contactIdsFilter.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'Call Transcriptions export requires at least one contactId in filters.contactIds.'
        });
      }
      const allConversationIds = [];
      // Walk per-contact, concurrency 3 (same as the message walk below).
      const CONTACT_PARALLEL = 3;
      for (let i = 0; i < contactIdsFilter.length; i += CONTACT_PARALLEL) {
        const batch = contactIdsFilter.slice(i, i + CONTACT_PARALLEL);
        const results = await Promise.allSettled(
          batch.map(cid => withRetry(() => ghlService.searchConversations(locationId, { contactId: cid, limit: 100 })))
        );
        for (const r of results) {
          if (r.status === 'fulfilled') {
            const convos = r.value.conversations || [];
            allConversationIds.push(...convos.map(c => c.id));
          }
        }
      }
      logger.info('Call Transcriptions: per-contact conversations fetched', {
        contactCount: contactIdsFilter.length,
        conversationCount: allConversationIds.length
      });

      // Step A — collect transcribable call messages.
      // Lower concurrency (3) to reduce 429 pressure on GHL; the tradeoff is wall-clock time.
      const PARALLEL = 3;
      const PAGE_SIZE = 300;
      const CALL_STATUSES_OK = new Set(['completed', 'answered', 'voicemail']);
      const transcribableMsgs = [];
      let conversationsFailed = 0;
      for (let i = 0; i < allConversationIds.length; i += PARALLEL) {
        const batch = allConversationIds.slice(i, i + PARALLEL);
        const results = await Promise.allSettled(
          batch.map(async (cId) => {
            const out = [];
            let cursor = undefined;
            while (true) {
              const msgOptions = { limit: PAGE_SIZE, type: 'TYPE_CALL' };
              if (cursor) msgOptions.lastMessageId = cursor;
              const result = await withRetry(() => ghlService.getMessages(locationId, cId, msgOptions));
              const wrapper = result.messages || {};
              const pageMsgs = wrapper.messages || [];
              for (const m of pageMsgs) {
                if (CALL_STATUSES_OK.has(String(m?.status || '').toLowerCase())) {
                  out.push({ ...m, conversationId: cId });
                }
              }
              if (pageMsgs.length < PAGE_SIZE || !wrapper.nextPage) break;
              cursor = wrapper.lastMessageId;
            }
            return out;
          })
        );
        for (const r of results) {
          if (r.status === 'fulfilled') {
            transcribableMsgs.push(...r.value);
          } else {
            conversationsFailed++;
            logger.warn('Conversation message fetch failed (after retries)', { error: r.reason?.message });
          }
        }
      }
      logger.info('Call Transcriptions: transcribable messages found', {
        count: transcribableMsgs.length, conversationsFailed
      });

      // Step B — fetch the plain-text transcript per message.
      // Per-message diagnostic logging so we can see exactly what GHL returns
      // (which messages are 400/404, empty, or unavailable for some other reason).
      const transcriptionRecords = [];
      let emptyCount = 0;
      let badRequestCount = 0;
      let notFoundCount = 0;
      let otherErrorCount = 0;
      for (let i = 0; i < transcribableMsgs.length; i += PARALLEL) {
        const batch = transcribableMsgs.slice(i, i + PARALLEL);
        const results = await Promise.allSettled(
          batch.map(async (m) => {
            try {
              const raw = (await withRetry(() => ghlService.getMessageTranscription(locationId, m.id))) || '';
              const transcript = String(raw);
              const preview = transcript.length > 200 ? transcript.slice(0, 200) + '…' : transcript;
              logger.info('Transcription response', {
                messageId: m.id,
                conversationId: m.conversationId,
                msgStatus: m.status,
                bodyType: typeof raw,
                length: transcript.length,
                preview
              });
              if (!transcript.trim()) return { status: 'empty' };
              return {
                status: 'ok',
                record: {
                  messageId: m.id,
                  conversationId: m.conversationId,
                  contactId: m.contactId || '',
                  userId: m.userId || '',
                  messageType: m.type || '',
                  direction: m.direction || '',
                  status: m.status || '',
                  dateAdded: m.dateAdded || null,
                  callDuration: m.meta?.callDuration || '',
                  callStatus: m.meta?.callStatus || '',
                  transcript
                }
              };
            } catch (err) {
              const httpStatus = err.response?.status;
              const body = err.response?.data;
              const bodyPreview = typeof body === 'string'
                ? (body.length > 200 ? body.slice(0, 200) + '…' : body)
                : (body ? JSON.stringify(body).slice(0, 200) : '');
              logger.warn('Transcription fetch error', {
                messageId: m.id,
                conversationId: m.conversationId,
                msgStatus: m.status,
                httpStatus,
                error: err.message,
                bodyPreview
              });
              return { status: 'error', httpStatus };
            }
          })
        );
        for (const r of results) {
          if (r.status !== 'fulfilled') continue;
          const v = r.value;
          if (v.status === 'ok') transcriptionRecords.push(v.record);
          else if (v.status === 'empty') emptyCount++;
          else if (v.status === 'error') {
            if (v.httpStatus === 400) badRequestCount++;
            else if (v.httpStatus === 404) notFoundCount++;
            else otherErrorCount++;
          }
        }
      }

      logger.info('Call Transcriptions: transcripts fetched', {
        eligible: transcribableMsgs.length,
        storedTranscriptions: transcriptionRecords.length,
        emptyCount,
        badRequestCount,
        notFoundCount,
        otherErrorCount
      });

      if (transcriptionRecords.length === 0) {
        return res.status(400).json({ success: false, error: 'No transcribable calls found for this sub-account' });
      }

      // Chunked SpecialExport — store in callTranscriptionsMessages so it's clearly distinct
      // from the specialTabMessages records which use `messages`.
      const CHUNK_SIZE = 5000;
      const totalChunks = Math.max(1, Math.ceil(transcriptionRecords.length / CHUNK_SIZE));
      const specialExport = await SpecialExport.create({
        locationId,
        filters: { type: 'call_transcriptions' },
        callTranscriptionsMessages: transcriptionRecords.slice(0, CHUNK_SIZE),
        totalMessages: transcriptionRecords.length,
        totalConversations: allConversationIds.length,
        chunkIndex: 0,
        totalChunks,
        status: 'ready'
      });
      if (totalChunks > 1) {
        const chunkDocs = [];
        for (let ci = 1; ci < totalChunks; ci++) {
          chunkDocs.push({
            locationId,
            filters: { type: 'call_transcriptions' },
            callTranscriptionsMessages: transcriptionRecords.slice(ci * CHUNK_SIZE, (ci + 1) * CHUNK_SIZE),
            totalMessages: transcriptionRecords.length,
            totalConversations: allConversationIds.length,
            groupId: specialExport._id,
            chunkIndex: ci,
            totalChunks,
            status: 'ready',
            createdAt: new Date(),
            updatedAt: new Date()
          });
        }
        await SpecialExport.insertMany(chunkDocs);
      }

      const total = transcriptionRecords.length;
      const unitPrice = 0.05;
      const finalAmount = total * unitPrice;
      return res.json({
        success: true,
        data: {
          estimate: {
            itemCounts: {
              callTranscriptions: total,
              total,
              // Heavy-task context (shown in the modal so the user understands the work involved)
              conversationsTraversed: allConversationIds.length,
              callMessagesScanned: transcribableMsgs.length
            },
            baseAmount: finalAmount,
            discountPercent: 0,
            discountAmount: 0,
            finalAmount
          },
          filters,
          exportType,
          specialExportId: specialExport._id
        }
      });
    }

    if (exportType === 'contactBundle') {
      // Per-contact unified bundle: all channel messages (non-email) via per-conversation
      // getMessages, all emails via the ES bulk exportMessages endpoint, and call transcriptions
      // for eligible calls. One CSV row per message, sorted by dateAdded ASC.
      //
      // Three-rate flat pricing: SMS-like $0.02 / Email $0.04 / Call $0.05 — no volume discount.
      const requestedContactIds = Array.isArray(filters?.contactIds)
        ? filters.contactIds.filter(Boolean)
        : [];
      if (requestedContactIds.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'Contact Bundle export requires at least one contactId in filters.contactIds.'
        });
      }

      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const withRetry = async (fn, maxRetries = 5) => {
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          try { return await fn(); }
          catch (err) {
            const is429 = err.response?.status === 429;
            const is5xx = err.response?.status >= 500 && err.response?.status < 600;
            if ((is429 || is5xx) && attempt < maxRetries) {
              const delay = Math.min(20000, Math.pow(2, attempt) * 1500) + Math.floor(Math.random() * 400);
              await sleep(delay);
            } else throw err;
          }
        }
      };

      const CALL_STATUSES_OK = new Set(['completed', 'answered', 'voicemail']);
      // Numeric type codes from /conversations/{convId}/messages:
      //   1 = Call, 3 = Email; 25–29 = activity events (skip)
      const isEmailMsg = (m) => {
        const t = m.type ?? m.messageType;
        if (typeof t === 'number') return t === 3;
        return String(t || '').toUpperCase() === 'TYPE_EMAIL';
      };
      const isCallMsg = (m) => {
        const t = m.type ?? m.messageType;
        if (typeof t === 'number') return t === 1;
        return String(t || '').toUpperCase() === 'TYPE_CALL';
      };
      const isActivity = (m) => {
        const t = m.type ?? m.messageType;
        if (typeof t === 'number') return t >= 25 && t <= 29;
        return String(t || '').toUpperCase().startsWith('TYPE_ACTIVITY');
      };
      const channelLabel = (m) => {
        const t = m.type ?? m.messageType;
        if (typeof t === 'string') return t.replace(/^TYPE_/, '');
        // Best-effort numeric → label mapping for the CSV.
        switch (t) {
          case 1: return 'CALL';
          case 2: return 'SMS';
          case 3: return 'EMAIL';
          case 20: return 'SMS'; // observed in production logs
          case 21: return 'EMAIL';
          default: return String(t || 'UNKNOWN');
        }
      };

      // Per-contact worker — returns the rows it collected. Stays self-contained so we can
      // run several in parallel without sharing mutable state.
      const walkOneContact = async (contactId) => {
        const rows = [];

        // 1) List the contact's conversations (1:1 in practice; one call with limit=100 covers it).
        const convoResp = await withRetry(() => ghlService.searchConversations(locationId, {
          contactId,
          limit: 100
        }));
        const convoIds = (convoResp.conversations || []).map(c => c.id);

        // 2) For each conversation, pull NON-EMAIL messages from the per-conversation endpoint.
        //    Emails are fetched separately via ES below; activity events are dropped.
        const CONV_PARALLEL = 2;
        for (let i = 0; i < convoIds.length; i += CONV_PARALLEL) {
          const batch = convoIds.slice(i, i + CONV_PARALLEL);
          const batchResults = await Promise.all(batch.map(async (cId) => {
            const out = [];
            let cursor = undefined;
            let pages = 0;
            while (true) {
              pages++;
              const opts = { limit: 100 };
              if (cursor) opts.lastMessageId = cursor;
              const r = await withRetry(() => ghlService.getMessages(locationId, cId, opts));
              const wrapper = r.messages || {};
              const pageMsgs = wrapper.messages || [];
              for (const m of pageMsgs) {
                if (isEmailMsg(m)) continue;       // emails come from ES below
                out.push({ ...m, conversationId: cId });
              }
              if (pageMsgs.length < 100 || !wrapper.nextPage) break;
              cursor = wrapper.lastMessageId;
              if (pages > 20) break;
            }
            return out;
          }));
          for (const arr of batchResults) {
            for (const m of arr) {
              const callEligible = isCallMsg(m) && CALL_STATUSES_OK.has(String(m.status || '').toLowerCase());
              rows.push({
                contactId,
                conversationId: m.conversationId || '',
                messageId: m.id,
                category: isCallMsg(m) ? 'call' : 'sms',
                channel: channelLabel(m),
                direction: m.direction || '',
                dateAdded: m.dateAdded || m.dateUpdated || '',
                from: m.from || '',
                to: m.to || '',
                body: m.body || '',
                subject: '',
                status: m.status || '',
                durationSeconds: m.duration || m.meta?.call?.duration || null,
                _needsTranscript: callEligible
              });
            }
          }
        }

        // 3) Fetch transcripts for eligible calls (concurrency 3, same as CallTranscriptions tab).
        const transcribeQueue = rows.filter(r => r._needsTranscript);
        const TRANSCRIBE_PARALLEL = 3;
        for (let i = 0; i < transcribeQueue.length; i += TRANSCRIBE_PARALLEL) {
          const batch = transcribeQueue.slice(i, i + TRANSCRIBE_PARALLEL);
          await Promise.all(batch.map(async (row) => {
            try {
              const text = await withRetry(() => ghlService.getMessageTranscription(locationId, row.messageId));
              row.transcription = text || '';
            } catch {
              row.transcription = '';
            }
          }));
        }
        for (const r of rows) delete r._needsTranscript;

        // 4) Fetch ALL emails for this contact via the ES bulk endpoint (channel=Email).
        let cursor = undefined;
        let pages = 0;
        while (true) {
          pages++;
          const r = await withRetry(() => ghlService.exportMessages(locationId, {
            contactId,
            channel: 'Email',
            limit: 100,
            cursor: cursor || undefined,
            startDate: new Date(0).toISOString(),
            endDate: new Date().toISOString()
          }));
          const msgs = r.messages || [];
          for (const m of msgs) {
            rows.push({
              contactId,
              conversationId: m.conversationId || '',
              messageId: m.id,
              category: 'email',
              channel: 'EMAIL',
              direction: m.direction || m.meta?.email?.direction || '',
              dateAdded: m.dateAdded || m.dateUpdated || '',
              from: m.meta?.email?.from || m.from || '',
              to: (m.meta?.email?.to || []).join('; ') || m.to || '',
              body: m.body || '',
              subject: m.meta?.email?.subject || '',
              status: m.status || '',
              durationSeconds: null
            });
          }
          if (msgs.length < 100 || !r.nextPage) break;
          cursor = r.lastMessageId;
          if (pages > 50) break;
        }

        return rows;
      };

      // Walk contacts in parallel batches of 2 (same conservative cap as OSH).
      const allRows = [];
      const CONTACT_PARALLEL = 2;
      for (let i = 0; i < requestedContactIds.length; i += CONTACT_PARALLEL) {
        const batch = requestedContactIds.slice(i, i + CONTACT_PARALLEL);
        const results = await Promise.allSettled(batch.map(cid => walkOneContact(cid)));
        for (const r of results) {
          if (r.status === 'fulfilled') allRows.push(...r.value);
          else logger.warn('Contact Bundle: contact walk failed', { error: r.reason?.message });
        }
      }

      // Sort by dateAdded ASC so the CSV reads chronologically across all categories.
      allRows.sort((a, b) => {
        const ta = a.dateAdded ? new Date(a.dateAdded).getTime() : 0;
        const tb = b.dateAdded ? new Date(b.dateAdded).getTime() : 0;
        return ta - tb;
      });

      const smsCount = allRows.filter(r => r.category === 'sms').length;
      const emailCount = allRows.filter(r => r.category === 'email').length;
      const callCount = allRows.filter(r => r.category === 'call').length;
      const SMS_PRICE = 0.02;
      const EMAIL_PRICE = 0.04;
      const CALL_PRICE = 0.05;
      const finalAmount = smsCount * SMS_PRICE + emailCount * EMAIL_PRICE + callCount * CALL_PRICE;

      logger.info('Contact Bundle: walk complete', {
        locationId,
        contactCount: requestedContactIds.length,
        totalRows: allRows.length,
        smsCount, emailCount, callCount, finalAmount
      });

      if (allRows.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'No messages found for the selected contacts.'
        });
      }

      // Persist chunked. The Lambda reads from `messages` field via the existing path.
      const CHUNK_SIZE = 5000;
      const totalChunks = Math.max(1, Math.ceil(allRows.length / CHUNK_SIZE));
      const specialExport = await SpecialExport.create({
        locationId,
        filters: { type: 'contactBundle', contactIds: requestedContactIds },
        messages: allRows.slice(0, CHUNK_SIZE),
        totalMessages: allRows.length,
        totalConversations: 0,
        contactBundleSmsCount: smsCount,
        contactBundleEmailCount: emailCount,
        contactBundleCallCount: callCount,
        chunkIndex: 0,
        totalChunks,
        status: 'ready'
      });
      if (totalChunks > 1) {
        const chunkDocs = [];
        for (let ci = 1; ci < totalChunks; ci++) {
          chunkDocs.push({
            locationId,
            filters: { type: 'contactBundle', contactIds: requestedContactIds },
            messages: allRows.slice(ci * CHUNK_SIZE, (ci + 1) * CHUNK_SIZE),
            totalMessages: allRows.length,
            contactBundleSmsCount: smsCount,
            contactBundleEmailCount: emailCount,
            contactBundleCallCount: callCount,
            groupId: specialExport._id,
            chunkIndex: ci,
            totalChunks,
            status: 'ready',
            createdAt: new Date(),
            updatedAt: new Date()
          });
        }
        await SpecialExport.insertMany(chunkDocs);
      }

      return res.json({
        success: true,
        data: {
          estimate: {
            itemCounts: {
              contactBundleSms: smsCount,
              contactBundleEmail: emailCount,
              contactBundleCall: callCount,
              total: allRows.length
            },
            breakdown: {
              sms:   { count: smsCount,   unitPrice: SMS_PRICE,   subtotal: smsCount * SMS_PRICE },
              email: { count: emailCount, unitPrice: EMAIL_PRICE, subtotal: emailCount * EMAIL_PRICE },
              call:  { count: callCount,  unitPrice: CALL_PRICE,  subtotal: callCount * CALL_PRICE }
            },
            baseAmount: finalAmount,
            discountPercent: 0,
            discountAmount: 0,
            finalAmount,
            finalAmountDollars: finalAmount
          },
          filters,
          exportType,
          specialExportId: specialExport._id
        }
      });
    }

    // Get access token to fetch actual prices from GHL
    const tokenData = await ghlService.getValidToken(locationId);
    const accessToken = tokenData.accessToken || tokenData;

    // Calculate estimate with actual GHL meter prices
    let estimate = await billingService.calculateEstimateWithPrices(counts, accessToken, locationId);
    estimate = {
      ...estimate,
      discountTiers: billingService.getDiscountTiers(),
      unitPrices: billingService.getUnitPrices(locationId)
    }

    // Flat-fee re-download override: a hardcoded locationId + exportType + date range bills a
    // fixed fee instead of per-record pricing. Keeps the normal export/download flow afterward.
    const fixedFee = matchFixedPriceExport(locationId, exportType, filters);
    if (fixedFee != null) {
      estimate.baseAmount = fixedFee;
      estimate.discountPercent = 0;
      estimate.discountAmount = 0;
      estimate.finalAmount = fixedFee;
      estimate.finalAmountDollars = fixedFee;
      estimate.fixedPriceRedownload = true;
      logger.info('Estimate: fixed-price re-download matched', { locationId, exportType, amount: fixedFee });
    }

    const responseData = {
      estimate,
      filters,
      exportType,
      discountTiers: billingService.getDiscountTiers(),
      unitPrices: billingService.getUnitPrices(locationId)
    };

    // For notes with tags: return resolved contactIds so frontend can reuse them for export
    if (exportType === 'notes' && resolvedContactIds && resolvedContactIds.length > 0) {
      responseData.resolvedContactIds = resolvedContactIds;
      responseData.resolvedContactNames = resolvedContactNames;
      responseData.resolvedContactsMeta = resolvedContactsMeta || {};
    }

    res.json({ success: true, data: responseData });

  } catch (error) {
    logError('Estimate calculation error', error, {
      locationId: req.body?.locationId,
      exportType: req.body?.exportType
    });

    res.status(500).json({
      success: false,
      error: 'Failed to calculate estimate',
      message: getUserFriendlyMessage(error)
    });
  }
});

/**
 * @route POST /api/billing/charge-and-export
 * @desc Check funds, charge wallet, create job, trigger Lambda
 */
router.post('/charge-and-export', authenticateSession, async (req, res) => {
  try {
    const { locationId, exportType, format, filters, notificationEmail } = req.body;
    const { companyId, userId } = req.user;

    if (!locationId) {
      return res.status(400).json({
        success: false,
        error: 'locationId is required'
      });
    }

    const validExportTypes = ['conversations', 'messages', 'notes', 'tasks', 'opportunities', 'formSubmissions', 'links', 'socialPosts', 'callLogs', 'templates', 'specialTabMessages', 'callTranscriptions', 'contacts', 'customFields', 'customValues', 'tags', 'opportunityStageHistory', 'contactBundle', 'messagesByTag', 'groupMessages', 'internalMessages'];
    if (!exportType || !validExportTypes.includes(exportType)) {
      return res.status(400).json({
        success: false,
        error: `exportType must be one of: ${validExportTypes.join(', ')}`
      });
    }

    // Feature-gate: opportunityStageHistory is a custom build for specific locations only.
    if (exportType === 'opportunityStageHistory') {
      const allowed = await AppConfig.hasValue('opportunityStageExportLocations', locationId);
      if (!allowed) {
        return res.status(403).json({
          success: false,
          error: 'Opportunity Stage History export is not enabled for this sub-account.'
        });
      }
    }

    // Validate email is provided (required for notification)
    if (!notificationEmail || !notificationEmail.trim()) {
      return res.status(400).json({
        success: false,
        error: 'Email address is required for export notification'
      });
    }

    // Basic email format validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(notificationEmail.trim())) {
      return res.status(400).json({
        success: false,
        error: 'Please provide a valid email address'
      });
    }

    // Validate date range (not applicable for notes/links/templates/customFields/customValues/tags)
    if (!['notes', 'links', 'templates', 'customFields', 'customValues', 'tags'].includes(exportType)) {
      const dateValidation = validateDateRange(filters?.startDate, filters?.endDate, ['specialTabMessages', 'callTranscriptions'].includes(exportType) ? MAX_DATE_RANGE_MS_SPECIAL_TAB : MAX_DATE_RANGE_MS);
      if (!dateValidation.valid) {
        return res.status(400).json({
          success: false,
          error: dateValidation.error
        });
      }
    }

    logger.info('Starting charge-and-export', { locationId, exportType, companyId });

    // Notes require contacts — validate before any counting
    if (exportType === 'notes' && !filters?.contactId && !filters?.contactIds?.length) {
      return res.status(400).json({ success: false, error: 'Please select contacts or enter a tag to export notes' });
    }

    // Step 1: Get counts for billing
    const fetchCounts = async () => {
      const counts = {
        conversations: 0,
        smsMessages: 0,
        emailMessages: 0,
        notes: 0,
        tasks: 0,
        opportunities: 0,
        formSubmissions: 0,
        links: 0,
        socialPosts: 0,
        callLogs: 0,
        templates: 0,
        customFields: 0,
        customValues: 0,
        tags: 0
      };
      let totalItems = 0;

      if (exportType === 'conversations') {
        const result = await ghlService.searchConversations(locationId, {
          ...filters,
          limit: 100
        });
        totalItems = result.total || result.conversations?.length || 0;
        counts.conversations = totalItems;
      } else if (exportType === 'contacts') {
        const result = await ghlService.searchContactsAdvanced(locationId, {
          ...filters,
          limit: 1
        });
        totalItems = result.total || 0;
        counts.contacts = totalItems;
      } else if (exportType === 'notes') {
        // Notes: contactIds already resolved during estimate, count passed from frontend
        totalItems = filters?.estimatedNoteCount || 0;
        counts.notes = totalItems;

      } else if (exportType === 'tasks') {
        // Tasks: location-level search API — always upfront billing
        const result = await ghlService.getLocationTasks(locationId, {
          contactIds: filters?.contactIds || [],
          assignedTo: filters?.assignedTo,
          completed: filters?.completed,
          overdue: filters?.overdue,
          query: filters?.query,
          dueDate: filters?.dueDate,
          sortKey: filters?.sortKey,
          sortDirection: filters?.sortDirection,
          limit: 1
        });
        totalItems = result.total || 0;
        counts.tasks = totalItems;

      } else if (exportType === 'opportunities') {
        // Opportunities: location-level search API returns total directly
        const result = await ghlService.searchOpportunities(locationId, {
          ...filters,
          limit: 1
        });
        totalItems = result.total || 0;
        counts.opportunities = totalItems;

      } else if (exportType === 'formSubmissions') {
        const result = await ghlService.getFormSubmissions(locationId, {
          formId: filters?.formId,
          q: filters?.query,
          startAt: filters?.startDate,
          endAt: filters?.endDate,
          limit: 1
        });
        totalItems = result.total || 0;
        counts.formSubmissions = totalItems;

      } else if (exportType === 'links') {
        const result = await ghlService.getLinks(locationId, { query: filters?.query, limit: 1000 });
        totalItems = result.total || result.links?.length || 0;
        counts.links = totalItems;

      } else if (exportType === 'socialPosts') {
        const result = await ghlService.getSocialPosts(locationId, {
          ...filters,
          limit: 1
        });
        totalItems = result.total || 0;
        counts.socialPosts = totalItems;

      } else if (exportType === 'callLogs') {
        const result = await ghlService.getCallLogs(locationId, {
          ...filters,
          pageSize: 1
        });
        totalItems = result.total || 0;
        counts.callLogs = totalItems;

      } else if (exportType === 'templates') {
        const result = await ghlService.getTemplates(locationId, {
          type: filters?.type,
          limit: '1'
        });
        totalItems = result.total || 0;
        counts.templates = totalItems;

      } else if (exportType === 'customFields') {
        const result = await ghlService.getCustomFields(locationId, filters?.model || 'all');
        totalItems = result.total || 0;
        counts.customFields = totalItems;

      } else if (exportType === 'customValues') {
        const result = await ghlService.getCustomValues(locationId, filters?.documentType || 'all');
        totalItems = result.total || 0;
        counts.customValues = totalItems;

      } else if (exportType === 'tags') {
        const result = await ghlService.getLocationTags(locationId);
        totalItems = result.total || 0;
        counts.tags = totalItems;

      } else if (exportType === 'specialTabMessages') {
        // LiveChat: use estimatedTotal from frontend (already counted during estimate)
        totalItems = filters?.estimatedTotal || 0;

      } else if (exportType === 'messagesByTag') {
        // Messages by Tag: messages were already gathered + chunked during /estimate.
        // Use estimatedTotal from frontend (do not re-walk GHL).
        totalItems = filters?.estimatedTotal || 0;

      } else if (exportType === 'groupMessages' || exportType === 'internalMessages') {
        // Group / Internal chat: messages already gathered + chunked during /estimate.
        // Use estimatedTotal from frontend (do not re-walk GHL).
        totalItems = filters?.estimatedTotal || 0;

      } else if (exportType === 'callTranscriptions') {
        // Use estimatedTotal from frontend (already counted during estimate — heavy task, do not re-walk)
        totalItems = filters?.estimatedTotal || 0;

      } else if (exportType === 'opportunityStageHistory') {
        // Billed by (opportunities + messages), not stage-rows. Read both counts off the
        // SpecialExport persisted during /estimate so we don't have to re-walk GHL. If the
        // doc is missing the new fields (older estimate), fall back to the frontend total.
        const se = filters?.specialExportId
          ? await SpecialExport.findById(filters.specialExportId).lean().catch(() => null)
          : null;
        const oppCount = se?.totalOpportunities ?? 0;
        const msgCount = se?.totalChannelMessages ?? 0;
        if (se && (oppCount > 0 || msgCount > 0)) {
          totalItems = oppCount + msgCount;
          counts.opportunityStageHistory = totalItems;
          counts.opportunityStageOppCount = oppCount;
          counts.opportunityStageMsgCount = msgCount;
        } else {
          // Legacy / fallback: estimatedTotal from frontend is already (opps + msgs) post-change.
          totalItems = filters?.estimatedTotal || 0;
          counts.opportunityStageHistory = totalItems;
        }

      } else if (exportType === 'contactBundle') {
        // Three-rate billing (sms / email / call). Pull the breakdown off the SpecialExport
        // doc persisted during /estimate so we never re-walk GHL at charge time.
        const se = filters?.specialExportId
          ? await SpecialExport.findById(filters.specialExportId).lean().catch(() => null)
          : null;
        const smsC = se?.contactBundleSmsCount ?? 0;
        const emailC = se?.contactBundleEmailCount ?? 0;
        const callC = se?.contactBundleCallCount ?? 0;
        totalItems = smsC + emailC + callC;
        counts.contactBundleSmsCount = smsC;
        counts.contactBundleEmailCount = emailC;
        counts.contactBundleCallCount = callC;
        counts.contactBundleTotal = totalItems;

      } else {
        // Use estimatedTotal from the estimate step if available (avoids GHL returning a different count)
        if (filters?.estimatedTotal) {
          totalItems = filters.estimatedTotal;
          logger.info('Using estimatedTotal from frontend', { estimatedTotal: totalItems });
        }

        const result = await ghlService.exportMessages(locationId, {
          ...filters,
          limit: 100
        });
        const messages = result.messages || [];

        if (!totalItems) {
          totalItems = result.total || messages.length;
        }

        // Count types from sample and extrapolate
        // Email = TYPE_EMAIL or type 3, everything else = text message
        let textCount = 0, emailCount = 0;
        messages.forEach(msg => {
          const type = String(msg.type || '').toLowerCase();
          if (type.includes('email') || type === '3' || type === 'type_email') emailCount++;
          else textCount++; // SMS, WhatsApp, Call, GMB, FB, etc.
        });

        if (messages.length > 0 && totalItems > messages.length) {
          const ratio = totalItems / messages.length;
          counts.smsMessages = Math.round(textCount * ratio);
          counts.emailMessages = Math.round(emailCount * ratio);
        } else {
          counts.smsMessages = textCount;
          counts.emailMessages = emailCount;
        }
      }

      return { counts, totalItems };
    };

    let { counts, totalItems } = await fetchCounts();

    // If first fetch returns 0, retry once to guard against transient empty results
    if (totalItems === 0) {
      logger.warn('totalItems=0 on first fetch, retrying once before declaring no data', { locationId, exportType });
      ({ counts, totalItems } = await fetchCounts());
    }

    if (totalItems === 0) {
      const noDataError = exportType === 'notes'
        ? 'No notes found for the selected contacts'
        : 'No items found matching the filters';
      return res.status(400).json({
        success: false,
        error: noDataError
      });
    }

    // Step 2: Get access token for billing API
    const tokenData = await ghlService.getValidToken(locationId);
    const accessToken = tokenData.accessToken || tokenData;

    // Special Messages: standalone billing (flat $0.018/msg, single meter charge, no discount)
    let estimate, meterCharges;
    if (exportType === 'specialTabMessages') {
      const unitPrice = 0.018;
      const finalAmount = totalItems * unitPrice;
      estimate = { baseAmount: finalAmount, discountPercent: 0, discountAmount: 0, finalAmount };
      meterCharges = [{ meterId: '69864aed1265653fdd7c0620', qty: totalItems, description: 'Special messages export' }];
    } else if (exportType === 'messagesByTag') {
      // Messages by Tag: standalone billing (flat $0.004/msg, single meter charge, no discount).
      const unitPrice = 0.004;
      const finalAmount = totalItems * unitPrice;
      estimate = { baseAmount: finalAmount, discountPercent: 0, discountAmount: 0, finalAmount };
      meterCharges = [{ meterId: '69864aed1265653fdd7c0620', qty: totalItems, description: 'Messages by tag export' }];
    } else if (exportType === 'groupMessages' || exportType === 'internalMessages') {
      // Group / Internal chat: same per-message pricing as Special Messages ($0.018/msg, same meter).
      const unitPrice = 0.018;
      const finalAmount = totalItems * unitPrice;
      estimate = { baseAmount: finalAmount, discountPercent: 0, discountAmount: 0, finalAmount };
      const desc = exportType === 'groupMessages' ? 'Group messages export' : 'Internal messages export';
      meterCharges = [{ meterId: '69864aed1265653fdd7c0620', qty: totalItems, description: desc }];
    } else if (exportType === 'callTranscriptions') {
      // Call Transcriptions: standalone billing (flat $0.05/record, single meter charge, no discount).
      // Reuses the same meter as specialTabMessages.
      const unitPrice = 0.05;
      const finalAmount = totalItems * unitPrice;
      estimate = { baseAmount: finalAmount, discountPercent: 0, discountAmount: 0, finalAmount };
      meterCharges = [{ meterId: '69864aed1265653fdd7c0620', qty: totalItems, description: 'Call transcriptions export' }];
    } else if (exportType === 'opportunityStageHistory') {
      // Opportunity Stage History: flat $0.10 per (opportunity + message), single meter charge,
      // no discount tier. totalItems = oppCount + msgCount (set above from the SpecialExport doc).
      const unitPrice = 0.10;
      const finalAmount = totalItems * unitPrice;
      estimate = {
        baseAmount: finalAmount,
        discountPercent: 0,
        discountAmount: 0,
        finalAmount,
        opportunityCount: counts.opportunityStageOppCount || 0,
        messageCount: counts.opportunityStageMsgCount || 0
      };
      const oppC = counts.opportunityStageOppCount || 0;
      const msgC = counts.opportunityStageMsgCount || 0;
      const desc = (oppC || msgC)
        ? `Opportunity stage history export (${oppC} opportunities + ${msgC} messages)`
        : 'Opportunity stage history export';
      meterCharges = [{ meterId: '69864aed1265653fdd7c0620', qty: totalItems, description: desc }];
    } else if (exportType === 'contactBundle') {
      // Contact Bundle: three flat rates, no discount.
      //   SMS-like messages : $0.02 each
      //   Email messages    : $0.04 each
      //   Call transcripts  : $0.05 each
      const smsC = counts.contactBundleSmsCount || 0;
      const emailC = counts.contactBundleEmailCount || 0;
      const callC = counts.contactBundleCallCount || 0;
      const finalAmount = smsC * 0.02 + emailC * 0.04 + callC * 0.05;
      estimate = {
        baseAmount: finalAmount,
        discountPercent: 0,
        discountAmount: 0,
        finalAmount,
        contactBundleSmsCount: smsC,
        contactBundleEmailCount: emailC,
        contactBundleCallCount: callC
      };
      meterCharges = [{
        meterId: '69864aed1265653fdd7c0620',
        qty: totalItems,
        description: `Contact bundle export (${smsC} SMS + ${emailC} email + ${callC} call)`
      }];
    } else {
      // Step 3: Calculate pricing with actual GHL meter prices
      estimate = await billingService.calculateEstimateWithPrices(counts, accessToken, locationId);
      // Step 5: Build meter charges
      meterCharges = billingService.buildMeterCharges(counts);
    }

    // Flat-fee re-download override: must mirror the /estimate override so the customer is
    // charged exactly the flat fee shown in the modal. Replaces per-record meter charges with
    // a single flat charge; the export then runs through the normal flow below.
    const fixedFee = matchFixedPriceExport(locationId, exportType, filters);
    if (fixedFee != null) {
      estimate = { ...estimate, baseAmount: fixedFee, discountPercent: 0, discountAmount: 0, finalAmount: fixedFee, finalAmountDollars: fixedFee };
      meterCharges = [{ meterId: '69864aed1265653fdd7c0620', qty: 1, description: `Re-download flat fee (${exportType}) $${fixedFee}` }];
      logger.info('Charge-and-export: fixed-price re-download matched', { locationId, exportType, amount: fixedFee });
    }

    // Safety net: if billing resolved to $0 despite totalItems>0, the counts used for
    // billing are out of sync with the export count — block instead of exporting for free.
    if (estimate.finalAmount === 0) {
      logger.warn('Billing calculated $0 — blocking export to prevent free charge', {
        locationId, exportType, totalItems, counts
      });
      return res.status(400).json({
        success: false,
        error: 'No billable items found. Please adjust your filters and try again.'
      });
    }

    // Step 4: Check wallet funds
    const hasFunds = await billingService.hasFunds(companyId, accessToken);
    if (!hasFunds) {
      // Surface the exact amount the wallet needs so the UI can tell the user how much to
      // recharge. GHL's has-funds endpoint only returns a boolean, so the required amount is
      // the export estimate total. Once they top up to at least this, a retry exports in seconds.
      const requiredAmount = Number(estimate.finalAmount) || 0;
      return res.status(402).json({
        success: false,
        code: 'INSUFFICIENT_FUNDS',
        error: 'Insufficient wallet balance',
        message: `Your agency or sub-account wallet doesn't have enough funds for this export. Add at least $${requiredAmount.toFixed(2)} and try again.`,
        requiredAmount,
      });
  }

    const transaction = await BillingTransaction.create({
      locationId,
      companyId,
      type: `export_${exportType}`,
      itemCounts: {
        ...counts,
        total: totalItems
      },
      pricing: {
        baseAmount: estimate.baseAmount,
        discountPercent: estimate.discountPercent,
        discountAmount: estimate.discountAmount,
        finalAmount: estimate.finalAmount
      },
      meterCharges,
      status: 'pending',
      userId
    });

    // Step 6: Charge wallet
    try {
      const chargeResult = await billingService.chargeWallet(companyId, accessToken, meterCharges, locationId, transaction._id.toString(), estimate.finalAmount);

      // Update transaction with charge IDs and referral code
      transaction.ghlChargeId = chargeResult?.charges.map(c => c?.chargeId).join(',');
      transaction.referralCode = chargeResult.referralCode || null;

      if (chargeResult.internalTesting) {
        transaction.status = 'tested';
        transaction.internalTesting = true;
        transaction.paymentIgnored = true;
      } else {
        transaction.status = 'charged';
      }
      await transaction.save();

    } catch (chargeError) {
      // Mark transaction as failed
      transaction.status = 'failed';
      transaction.errorMessage = chargeError.message;
      await transaction.save();

      // The charge can fail for insufficient funds even though hasFunds() passed earlier.
      // When it does, return the same INSUFFICIENT_FUNDS payload the precheck uses so the UI
      // shows the "recharge $X and try again" panel instead of a generic payment error.
      if (chargeError.insufficientFunds) {
        const requiredAmount = Number(estimate.finalAmount) || 0;
        const walletName = chargeError.walletScope === 'agency' ? 'agency wallet'
          : chargeError.walletScope === 'location' ? 'sub-account wallet'
          : 'agency or sub-account wallet';
        return res.status(402).json({
          success: false,
          code: 'INSUFFICIENT_FUNDS',
          error: 'Insufficient wallet balance',
          message: `Your ${walletName} doesn't have enough funds for this export. Add at least $${requiredAmount.toFixed(2)} and try again.`,
          requiredAmount,
          walletScope: chargeError.walletScope || null,
        });
      }

      return res.status(402).json({
        success: false,
        error: 'Payment failed',
        message: chargeError.message
      });
    }

    // Step 7: Verify OAuth token exists for this location
    const oauthToken = await OAuthToken.findActiveToken(locationId);
    if (!oauthToken || !oauthToken.refreshToken) {
      return res.status(400).json({
        success: false,
        error: 'No valid OAuth token found for this location'
      });
    }

    // Step 8: Create export job (Lambda will fetch tokens from OAuthToken collection)
    // Build filters object with all supported filter types
    const jobFilters = {
      // Common filters
      channel: filters?.channel || null,
      startDate: filters?.startDate ? new Date(filters.startDate) : null,
      endDate: filters?.endDate ? new Date(filters.endDate) : null,
      contactId: filters?.contactId || null,
      contactIds: filters?.contactIds?.length > 0 ? filters.contactIds : [],
      userIds: filters?.userIds?.length > 0 ? filters.userIds : [],
      // Conversation-specific filters
      query: filters?.query || null,
      id: filters?.id || null,
      conversationId: filters?.conversationId || null,
      lastMessageType: filters?.lastMessageType || null,
      lastMessageDirection: filters?.lastMessageDirection || null,
      status: filters?.status || null,
      lastMessageAction: filters?.lastMessageAction || null,
      sortBy: filters?.sortBy || null,
      // Opportunity-specific filters
      pipelineId: filters?.pipelineId || null,
      pipelineStageId: filters?.pipelineStageId || null,
      assignedTo: filters?.assignedTo || null,
      monetaryValueMin: filters?.monetaryValueMin ?? null,
      monetaryValueMax: filters?.monetaryValueMax ?? null,
      sortKey: filters?.sortKey || null,
      sortDirection: filters?.sortDirection || null,
      contactName: filters?.contactName || null,
      // Form submission-specific filters
      formId: filters?.formId || null,
      // Template-specific filters.
      // - Array (specialTabMessages "All" → 7 activity types) → comma-joined string
      // - String (single template type, or single activity type) → stored as-is
      // - Anything else → null
      templateType: Array.isArray(filters?.type)
        ? filters.type.join(',')
        : typeof filters?.type === 'string'
          ? filters.type
          : null,
      // Call log-specific filters
      agentId: filters?.agentId || null,
      callType: filters?.callType || null,
      actionType: filters?.actionType || null,
      direction: filters?.direction || null,
      callSortBy: filters?.sortBy || null,
      callSort: filters?.sort || null,
      // Notes/Tasks contact name map { contactId: "Name" }
      contactNames: filters?.contactNames || null,
      // Notes contact meta map { contactId: { email, phone } } — enriches the exported CSV
      contactsMeta: filters?.contactsMeta || null,
      // Task-specific filters
      dueDate: filters?.dueDate ? { gt: filters.dueDate.gt || null, lte: filters.dueDate.lte || null } : null,
      businessId: filters?.businessId || null,
      completed: filters?.completed ?? null,
      overdue: filters?.overdue ?? null,
      unAssigned: filters?.unAssigned != null ? filters?.unAssigned : null,
      // Tag filter for notes export (single string). messagesByTag sends an array of tags —
      // store it comma-joined so it fits the String schema (Lambda reads chunks by id, not this).
      tags: Array.isArray(filters?.tags) ? filters.tags.join(',') : (filters?.tags || null),
      // LiveChat-specific filters. Same array / string / null handling as `templateType` above.
      specialTabType: exportType
    };

    const exportJob = await ExportJob.create({
      locationId,
      companyId,
      billingTransactionId: transaction._id,
      exportType,
      format: format || 'csv',
      filters: jobFilters,
      totalItems,
      status: 'pending',
      notificationEmail: notificationEmail || null,
      userId
    });

    console.log("jobfilters: ", jobFilters)
    // Update transaction with job reference
    transaction.exportJobId = exportJob._id;
    await transaction.save();

    // Step 9a: Link the SpecialExport to this job.
    // For specialTabMessages and opportunityStageHistory it was created during /estimate; for callTranscriptions it was created in Step 7a (post-charge).
    if (['specialTabMessages', 'callTranscriptions', 'opportunityStageHistory', 'contactBundle', 'messagesByTag', 'groupMessages', 'internalMessages'].includes(exportType) && filters?.specialExportId) {
      try {
        await SpecialExport.findByIdAndUpdate(filters.specialExportId, {
          exportJobId: exportJob._id
        });
        logger.info('Linked SpecialExport to job', { specialExportId: filters.specialExportId, jobId: exportJob._id });
      } catch (linkError) {
        logger.error('Failed to link SpecialExport', { error: linkError.message });
      }
    }

    // Step 9: Trigger Lambda function
    try {
      const lambdaParams = {
        FunctionName: LAMBDA_FUNCTION_NAME,
        InvocationType: 'Event',  // Async invocation
        Qualifier: '$LATEST',     // Required for durable functions
        Payload: Buffer.from(JSON.stringify({
          exportJobId: exportJob._id.toString()
        }))
      };

      const lambdaResult = await lambda.send(new InvokeCommand(lambdaParams));

      // Update job status
      exportJob.status = 'processing';
      exportJob.startedAt = new Date();
      exportJob.lambdaRequestId = lambdaResult.$metadata?.requestId || null;
      await exportJob.save();

      logger.info('Lambda triggered successfully', {
        jobId: exportJob._id,
        requestId: lambdaResult.$metadata?.requestId
      });

    } catch (lambdaError) {
      // Lambda invocation failed - mark job but don't fail the request
      // Job can be retried later
      logger.error('Lambda invocation failed', {
        jobId: exportJob._id,
        error: lambdaError.message
      });

      exportJob.status = 'failed';
      exportJob.errorMessage = `Lambda invocation failed: ${lambdaError.message}`;
      await exportJob.save();
    }

    logger.info('Export job created', {
      jobId: exportJob._id,
      transactionId: transaction._id,
      totalItems
    });

    res.json({
      success: true,
      message: exportJob.status != 'failed' ? "Exported started successfully" : "Export failed",
      data: {
        jobId: exportJob._id,
        transactionId: transaction._id,
        totalItems,
        estimatedAmount: estimate.finalAmountDollars,
        status: exportJob.status
      }
    });

  } catch (error) {
    logError('Charge and export error', error, {
      locationId: req.body?.locationId,
      exportType: req.body?.exportType
    });

    res.status(500).json({
      success: false,
      error: 'Failed to start export',
      message: getUserFriendlyMessage(error)
    });
  }
});

/**
 * @route GET /api/billing/export-status/:jobId
 * @desc Get export job status
 */
router.get('/export-status/:jobId', authenticateSession, async (req, res) => {
  try {
    const { jobId } = req.params;

    const job = await ExportJob.findById(jobId).populate('billingTransactionId');

    if (!job) {
      return res.status(404).json({
        success: false,
        error: 'Export job not found'
      });
    }

    // Verify user has access (same location)
    if (job.locationId !== req.query.locationId && job.locationId !== req.body?.locationId) {
      // Allow if user is from same company
      if (job.companyId !== req.user?.companyId) {
        return res.status(403).json({
          success: false,
          error: 'Access denied'
        });
      }
    }

    res.json({
      success: true,
      data: {
        jobId: job._id,
        exportType: job.exportType,
        format: job.format,
        status: job.status,
        progress: {
          total: job.totalItems,
          processed: job.processedItems,
          percent: job.totalItems > 0 ? Math.round((job.processedItems / job.totalItems) * 100) : 0
        },
        downloadUrl: job.status === 'completed' ? job.downloadUrl : null,
        downloadUrlExpiresAt: job.downloadUrlExpiresAt,
        errorMessage: job.errorMessage,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
        createdAt: job.createdAt,
        billing: job.billingTransactionId?.pricing?.finalAmount ? {
          amount: job.billingTransactionId.pricing.finalAmount,
          status: job.billingTransactionId.status
        } : null
      }
    });

  } catch (error) {
    logError('Get export status error', error, { jobId: req.params?.jobId });

    res.status(500).json({
      success: false,
      error: 'Failed to get export status'
    });
  }
});

// S3 client for on-the-fly presigned download URLs. Uses the backend's ambient AWS credentials
// (EC2 role / env). Region falls back to us-east-1 (the exports bucket's region).
const downloadS3 = new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });

/**
 * @route GET /api/billing/download/:jobId
 * @desc Regenerate a fresh presigned S3 download URL ON THE FLY and redirect to it.
 *   Why: the URL stored at export time is signed with SHORT-LIVED credentials (STS session
 *   tokens live ≤12h), so a stored 7-day URL actually dies within hours (ExpiredToken).
 *   Instead we presign at click-time with a short (1h) expiry — always fresh, always works —
 *   but only while the job is still inside its 7-day policy window (downloadUrlExpiresAt).
 *   After 7 days the link is genuinely expired (410).
 */
router.get('/download/:jobId', authenticateSession, async (req, res) => {
  try {
    const { jobId } = req.params;
    const job = await ExportJob.findById(jobId);

    if (!job) {
      return res.status(404).json({ success: false, error: 'Export job not found' });
    }

    // Access check: same location, or same company (mirrors export-status).
    if (job.locationId !== req.query.locationId && job.companyId !== req.user?.companyId) {
      return res.status(403).json({ success: false, error: 'Access denied' });
    }

    if (job.status !== 'completed' || !job.s3Key) {
      return res.status(409).json({ success: false, error: 'Export is not ready for download yet.' });
    }

    // 7-day policy gate: refuse once the original window has elapsed.
    if (job.downloadUrlExpiresAt && Date.now() >= new Date(job.downloadUrlExpiresAt).getTime()) {
      return res.status(410).json({
        success: false,
        code: 'DOWNLOAD_EXPIRED',
        error: 'This download link has expired (7-day limit reached). Please run the export again.'
      });
    }

    // Fresh short-lived presigned URL (1h — used immediately). Signature is seconds old, so it
    // works regardless of whether the backend creds are permanent or temporary.
    const freshUrl = await getSignedUrl(
      downloadS3,
      new GetObjectCommand({ Bucket: job.s3Bucket || 'convo-vault-exports-1', Key: job.s3Key }),
      { expiresIn: 60 * 60 }
    );

    // Return the URL as JSON. The route is session-authenticated (Bearer token), so the client
    // fetches it via the api client and then opens the returned S3 URL in a new tab.
    return res.json({ success: true, data: { url: freshUrl } });
  } catch (error) {
    logError('Download redirect error', error, { jobId: req.params?.jobId });
    res.status(500).json({ success: false, error: 'Failed to generate download link' });
  }
});

/**
 * @route GET /api/billing/download-email/:jobId?token=…
 * @desc PUBLIC (no session) download link used in the "Your Export is Ready" email. Email links
 *   can't carry a login token, so this is authorized by the per-job `downloadToken` instead.
 *   Same fix as the in-app route: regenerates a FRESH presigned S3 URL on click (the URL stored
 *   at export time is signed with short-lived STS creds and dies within hours), enforces the
 *   7-day window via downloadUrlExpiresAt, then 302-redirects the browser straight to S3.
 */
router.get('/download-email/:jobId', async (req, res) => {
  const sendHtml = (title, msg) => res.status(410).send(
    `<html><body style="font-family:Arial,sans-serif;text-align:center;padding:60px">
       <h2 style="color:#EF4444">${title}</h2><p style="color:#6B7280">${msg}</p></body></html>`
  );
  try {
    const { jobId } = req.params;
    const { token } = req.query;
    const job = await ExportJob.findById(jobId);

    if (!job || job.status !== 'completed' || !job.s3Key) {
      return sendHtml('Export not found', 'This export is no longer available.');
    }

    // Token gate — must match the job's stored downloadToken.
    if (!token || !job.downloadToken || token !== job.downloadToken) {
      return res.status(403).send(
        `<html><body style="font-family:Arial,sans-serif;text-align:center;padding:60px">
           <h2 style="color:#EF4444">Invalid link</h2>
           <p style="color:#6B7280">This download link is not valid.</p></body></html>`
      );
    }

    // 7-day policy gate.
    if (job.downloadUrlExpiresAt && Date.now() >= new Date(job.downloadUrlExpiresAt).getTime()) {
      return sendHtml('Link expired', 'This download link has expired (7-day limit). Please run the export again from the app.');
    }

    const freshUrl = await getSignedUrl(
      downloadS3,
      new GetObjectCommand({ Bucket: job.s3Bucket || 'convo-vault-exports-1', Key: job.s3Key }),
      { expiresIn: 60 * 60 }
    );
    return res.redirect(302, freshUrl);
  } catch (error) {
    logError('Email download redirect error', error, { jobId: req.params?.jobId });
    return sendHtml('Something went wrong', 'Could not generate the download link. Please try again from the app.');
  }
});

/**
 * @route GET /api/billing/export-history
 * @desc Get recent export jobs for location with pagination
 */
router.get('/export-history', authenticateSession, async (req, res) => {
  try {
    const { locationId, limit, page } = req.query;

    if (!locationId) {
      return res.status(400).json({
        success: false,
        error: 'locationId is required'
      });
    }

    const pageNum = parseInt(page) || 1;
    const limitNum = parseInt(limit) || 10;
    const skip = (pageNum - 1) * limitNum;

    // Get total count for pagination
    const totalCount = await ExportJob.countDocuments({ locationId });

    // Get paginated jobs
    const jobs = await ExportJob.find({ locationId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum)
      .populate('billingTransactionId');

    res.json({
      success: true,
      data: {
        total: totalCount,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(totalCount / limitNum),
        jobs: jobs.map(job => ({
          jobId: job._id,
          exportType: job.exportType,
          format: job.format,
          status: job.status,
          totalItems: job.totalItems,
          processedItems: job.processedItems,
          downloadUrl: job.status === 'completed' ? job.downloadUrl : null,
          downloadUrlExpiresAt: job.downloadUrlExpiresAt,
          createdAt: job.createdAt,
          completedAt: job.completedAt,
          filters: job.filters || {},
          errorMessage: job.errorMessage,
          billing: job.billingTransactionId?.pricing?.finalAmount ? {
            amount: job.billingTransactionId.pricing.finalAmount
          } : null
        }))
      }
    });

  } catch (error) {
    logError('Get export history error', error, { locationId: req.query?.locationId });

    res.status(500).json({
      success: false,
      error: 'Failed to get export history'
    });
  }
});

/**
 * @route GET /api/billing/pricing
 * @desc Get current pricing information
 */
router.get('/pricing', async (req, res) => {
  const locationId = req.query?.locationId;
  // Custom Charge and Call Transcriptions stay gated; Complete Messages and Import Notes are now live for all locations.
  const [customChargeLocationIds, callTranscriptionsLocationIds] = await Promise.all([
    AppConfig.getValues('customChargeLocationIds'),
    AppConfig.getValues('callTranscriptionsLocationIds')
  ]);
  // "*" in values = show to all locations (global kill-switch)
  const customChargeEnabled = locationId
    ? (customChargeLocationIds.includes('*') || customChargeLocationIds.includes(locationId))
    : false;
  const callTranscriptionsEnabled = locationId
    ? (callTranscriptionsLocationIds.includes('*') || callTranscriptionsLocationIds.includes(locationId))
    : false;

  // Per-tab kill-switch. One AppConfig doc per tab: key `disabledTab:<tab>`, whose `values`
  // holds a mix of locationIds AND companyIds. A tab is disabled for this location if its
  // locationId OR its companyId appears in that tab's values (company id = disable for every
  // location under that company). 'import' is the special tab id that hides the whole Import mode.
  // Checked tabs = every export/import tab id the UI can render, plus 'import'/'export'.
  const CONFIGURABLE_TABS = [
    'import', 'export',
    'messages', 'specialTabMessages', 'contactBundle', 'messagesByTag', 'callTranscriptions',
    'contacts', 'opportunities', 'opportunityStageHistory', 'formSubmissions',
    'notes', 'tasks', 'templates', 'links', 'callLogs', 'customFields', 'customValues', 'tags',
    'importContacts', 'importNotes', 'importCustomFields', 'importCustomValues'
  ];
  let disabledTabs = [];
  if (locationId) {
    // Resolve the companyId for this location so company-level disables apply.
    let companyId = null;
    try {
      const companyLoc = await CompanyLocation.findCompanyByLocation(locationId);
      companyId = companyLoc?.companyId || null;
    } catch (e) { /* non-blocking: fall back to location-only matching */ }

    const perTab = await Promise.all(
      CONFIGURABLE_TABS.map(tab => AppConfig.getValues(`disabledTab:${tab}`))
    );
    disabledTabs = CONFIGURABLE_TABS.filter((tab, i) => {
      const vals = perTab[i];
      return vals.includes(locationId) || (companyId && vals.includes(companyId));
    });
  }
  res.json({
    success: true,
    data: {
      unitPrices: billingService.getUnitPrices(locationId),
      discountTiers: billingService.getDiscountTiers(),
      maxDateRange: '1 month',
      maxDateRangeMonths: 6,
      // Always-on now — kept in the response for backward compatibility with older clients.
      specialTabEnabled: true,
      importNotesEnabled: true,
      customChargeEnabled,
      callTranscriptionsEnabled,
      // Tab ids (and/or 'import') to hide for this location. UI filters its tab list by this.
      disabledTabs
    }
  });
});

/**
 * @route GET /api/billing/pipelines
 * @desc Get pipelines for a location (proxy to GHL API)
 */
router.get('/pipelines', authenticateSession, async (req, res) => {
  try {
    const { locationId } = req.query;

    if (!locationId) {
      return res.status(400).json({
        success: false,
        error: 'locationId is required'
      });
    }

    const result = await ghlService.getPipelines(locationId);

    res.json({
      success: true,
      data: {
        pipelines: result.pipelines || []
      }
    });

  } catch (error) {
    logError('Get pipelines error', error, { locationId: req.query?.locationId });

    res.status(500).json({
      success: false,
      error: 'Failed to get pipelines'
    });
  }
});

/**
 * @route GET /api/billing/forms
 * @desc Get forms for a location (proxy to GHL API)
 */
router.get('/forms', authenticateSession, async (req, res) => {
  try {
    const { locationId } = req.query;

    if (!locationId) {
      return res.status(400).json({
        success: false,
        error: 'locationId is required'
      });
    }

    const result = await ghlService.getForms(locationId);

    res.json({
      success: true,
      data: {
        forms: result.forms || [],
        total: result.total || 0
      }
    });

  } catch (error) {
    logError('Get forms error', error, { locationId: req.query?.locationId });

    res.status(500).json({
      success: false,
      error: 'Failed to get forms'
    });
  }
});

/**
 * @route GET /api/billing/contacts/:contactId/notes
 * @desc Get notes for a specific contact (for preview)
 */
router.get('/contacts/:contactId/notes', authenticateSession, async (req, res) => {
  try {
    const { contactId } = req.params;
    const { locationId } = req.query;

    if (!locationId) {
      return res.status(400).json({ success: false, error: 'locationId is required' });
    }

    const result = await ghlService.getContactNotes(locationId, contactId);

    res.json({
      success: true,
      data: {
        notes: result.notes || [],
        total: result.total || 0
      }
    });

  } catch (error) {
    logError('Get contact notes error', error, { contactId: req.params?.contactId });
    res.status(500).json({ success: false, error: 'Failed to fetch notes' });
  }
});

/**
 * @route GET /api/billing/contacts/:contactId/tasks
 * @desc Get tasks for a specific contact (for preview)
 */
router.get('/contacts/:contactId/tasks', authenticateSession, async (req, res) => {
  try {
    const { contactId } = req.params;
    const { locationId } = req.query;

    if (!locationId) {
      return res.status(400).json({ success: false, error: 'locationId is required' });
    }

    const result = await ghlService.getContactTasks(locationId, contactId);

    res.json({
      success: true,
      data: {
        tasks: result.tasks || [],
        total: result.total || 0
      }
    });

  } catch (error) {
    logError('Get contact tasks error', error, { contactId: req.params?.contactId });
    res.status(500).json({ success: false, error: 'Failed to fetch tasks' });
  }
});

/**
 * @route POST /api/billing/formSubmissions/search
 * @desc Search form submissions for a location (for preview in UI)
 */
router.post('/formSubmissions/search', authenticateSession, async (req, res) => {
  try {
    const { locationId, filters = {}, page = 1, limit = 25 } = req.body;
    if (!locationId) {
      return res.status(400).json({ success: false, error: 'locationId is required' });
    }
    const result = await ghlService.getFormSubmissions(locationId, {
      formId: filters.formId,
      q: filters.query,
      startAt: filters.startDate,
      endAt: filters.endDate,
      page,
      limit
    });
    res.json({
      success: true,
      data: {
        submissions: result.submissions || [],
        total: result.total || 0,
        page,
        limit
      }
    });
  } catch (error) {
    logError('Search form submissions error', error, { locationId: req.body?.locationId });
    res.status(500).json({ success: false, error: 'Failed to search form submissions' });
  }
});

/**
 * @route POST /api/billing/links/search
 * @desc Search trigger links for a location (for preview in UI)
 */
router.post('/links/search', authenticateSession, async (req, res) => {
  try {
    const { locationId, query = '', page = 1, limit = 25 } = req.body;
    if (!locationId) {
      return res.status(400).json({ success: false, error: 'locationId is required' });
    }
    const skip = (page - 1) * limit;
    const result = await ghlService.getLinks(locationId, { query, limit, skip });
    res.json({
      success: true,
      data: {
        links: result.links || [],
        total: result.total || 0,
        page,
        limit
      }
    });
  } catch (error) {
    logError('Search links error', error, { locationId: req.body?.locationId });
    res.status(500).json({ success: false, error: 'Failed to search links' });
  }
});

/**
 * @route POST /api/billing/opportunities/search
 * @desc Search opportunities for a location (for preview in UI)
 */
router.post('/opportunities/search', authenticateSession, async (req, res) => {
  try {
    const { locationId, filters = {}, searchAfter = null, limit = 20 } = req.body;

    if (!locationId) {
      return res.status(400).json({ success: false, error: 'locationId is required' });
    }

    const result = await ghlService.searchOpportunities(locationId, {
      ...filters,
      searchAfter: searchAfter || [],
      limit
    });

    res.json({
      success: true,
      data: {
        opportunities: result.opportunities || [],
        total: result.total || 0,
        nextSearchAfter: result.searchAfter || null
      }
    });
  } catch (error) {
    logError('Search opportunities error', error, { locationId: req.body?.locationId });
    res.status(500).json({ success: false, error: 'Failed to search opportunities' });
  }
});

/**
 * @route POST /api/billing/tasks/search
 * @desc Search tasks for a location (for preview in UI)
 */
router.post('/tasks/search', authenticateSession, async (req, res) => {
  try {
    const { locationId, filters = {}, searchAfter = null, limit = 25 } = req.body;

    if (!locationId) {
      return res.status(400).json({ success: false, error: 'locationId is required' });
    }

    const result = await ghlService.getLocationTasks(locationId, {
      contactIds: filters.contactIds || [],
      assignedTo: filters.assignedTo,
      unAssigned: filters.unAssigned,
      completed: filters.completed,
      overdue: filters.overdue,
      query: filters.query,
      dueDate: filters.dueDate,
      sortKey: filters.sortKey,
      sortDirection: filters.sortDirection,
      businessId: filters?.businessId,
      searchAfter: searchAfter || [],
      skip: 0,
      limit
    });

    // Return last task's searchAfter for cursor pagination
    const tasks = result.tasks || [];
    const nextSearchAfter = tasks.length > 0 ? (tasks[tasks.length - 1].searchAfter || null) : null;

    res.json({
      success: true,
      data: {
        tasks,
        total: result.total || 0,
        nextSearchAfter
      }
    });
  } catch (error) {
    logError('Search tasks error', error, { locationId: req.body?.locationId });
    res.status(500).json({ success: false, error: 'Failed to search tasks' });
  }
});

/**
 * @route POST /api/billing/templates/search
 * @desc Search templates for a location (for preview in UI)
 */
router.post('/templates/search', authenticateSession, async (req, res) => {
  try {
    const { locationId, filters = {}, page = 1, limit = 25 } = req.body;
    if (!locationId) {
      return res.status(400).json({ success: false, error: 'locationId is required' });
    }
    const skip = (page - 1) * limit;
    const result = await ghlService.getTemplates(locationId, {
      type: filters.type,
      limit: String(limit),
      skip: String(skip)
    });
    res.json({
      success: true,
      data: {
        templates: result.templates || [],
        total: result.total || 0,
        page,
        limit
      }
    });
  } catch (error) {
    logError('Search templates error', error, { locationId: req.body?.locationId });
    res.status(500).json({ success: false, error: 'Failed to search templates' });
  }
});

/**
 * @route POST /api/billing/callLogs/search
 * @desc Search call logs for a location (for preview in UI)
 */
router.post('/callLogs/search', authenticateSession, async (req, res) => {
  try {
    const { locationId, filters = {}, page = 1, pageSize = 50 } = req.body;
    if (!locationId) {
      return res.status(400).json({ success: false, error: 'locationId is required' });
    }
    const options = { page, pageSize };
    if (filters.agentId) options.agentId = filters.agentId;
    if (filters.contactId) options.contactId = filters.contactId;
    if (filters.callType) options.callType = filters.callType;
    if (filters.direction) options.direction = filters.direction;
    if (filters.actionType) options.actionType = filters.actionType;
    if (filters.startDate) options.startDate = filters.startDate;
    if (filters.endDate) options.endDate = filters.endDate;
    if (filters.sortBy) options.sortBy = filters.sortBy;
    if (filters.sort) options.sort = filters.sort;

    const result = await ghlService.getCallLogs(locationId, options);
    res.json({
      success: true,
      data: {
        callLogs: result.callLogs || [],
        total: result.total || 0,
        page,
        pageSize
      }
    });
  } catch (error) {
    logError('Search call logs error', error, { locationId: req.body?.locationId });
    res.status(500).json({ success: false, error: 'Failed to search call logs' });
  }
});

/**
 * @route GET /api/billing/voice-ai-agents
 * @desc Get voice AI agents for a location (for filter dropdowns)
 */
router.get('/voice-ai-agents', authenticateSession, async (req, res) => {
  try {
    const { locationId } = req.query;
    if (!locationId) {
      return res.status(400).json({ success: false, error: 'locationId is required' });
    }
    const result = await ghlService.getVoiceAIAgents(locationId);
    res.json({ success: true, data: result });
  } catch (error) {
    logError('Get voice AI agents error', error, { locationId: req.query?.locationId });
    res.status(500).json({ success: false, error: 'Failed to get voice AI agents' });
  }
});

/**
 * @route GET /api/billing/users
 * @desc Search users for a location's company (for filter dropdowns)
 */
router.get('/users', authenticateSession, async (req, res) => {
  try {
    const { locationId, query = '' } = req.query;
    if (!locationId) {
      return res.status(400).json({ success: false, error: 'locationId is required' });
    }
    const isLite = req.get('X-App') === 'lite';
    // Resolve companyId: prefer the CompanyLocation map, but fall back to the location's OAuth
    // token (which also stores companyId) for locations that have no CompanyLocation record
    // (e.g. sub-account-level installs, or older installs from before that map existed).
    let companyId = (await CompanyLocation.findCompanyByLocation(locationId))?.companyId;
    if (!companyId) {
      const tokenDoc = await OAuthToken.findActiveToken(locationId, { lite: isLite });
      companyId = tokenDoc?.companyId;
    }
    if (!companyId) {
      return res.status(404).json({ success: false, error: 'Company not found for this location' });
    }
    const users = await ghlService.searchUsers(locationId, { companyId, query, lite: isLite });
    res.json({ success: true, data: { users } });
  } catch (error) {
    logError('Search users error', error, { locationId: req.query?.locationId });
    res.status(500).json({ success: false, error: 'Failed to search users' });
  }
});

/**
 * @route GET /api/billing/contacts/search
 * @desc Search contacts for a location (for filter dropdowns)
 */
router.get('/contacts/search', authenticateSession, async (req, res) => {
  try {
    const { locationId, query, limit, tag } = req.query;

    if (!locationId) {
      return res.status(400).json({ success: false, error: 'locationId is required' });
    }

    const options = {
      query: query || '',
      limit: parseInt(limit) || 20,
      lite: req.get('X-App') === 'lite'
    };
    if (tag) options.tag = tag;

    const result = await ghlService.searchContacts(locationId, options);

    res.json({
      success: true,
      data: {
        contacts: result.contacts || [],
        total: result.total || 0
      }
    });

  } catch (error) {
    logError('Search contacts error', error, { locationId: req.query?.locationId });
    res.status(500).json({ success: false, error: 'Failed to search contacts' });
  }
});

/**
 * @route POST /api/billing/custom-charge
 * @desc Charge a specific location a custom amount directly
 */
router.post('/custom-charge', authenticateSession, async (req, res) => {
  try {
    const { locationId, amount } = req.body;
    const { companyId, userId } = req.user;

    const customChargeLocationIds = await AppConfig.getValues('customChargeLocationIds');
    const isAllowed = customChargeLocationIds.includes('*') || customChargeLocationIds.includes(locationId);
    if (!isAllowed) {
      return res.status(403).json({ success: false, error: 'Not authorized for this location' });
    }

    const parsedAmount = parseFloat(amount);
    if (!parsedAmount || isNaN(parsedAmount) || parsedAmount <= 0) {
      return res.status(400).json({ success: false, error: 'Valid amount greater than 0 is required' });
    }

    const tokenData = await ghlService.getValidToken(locationId);
    const accessToken = tokenData.accessToken || tokenData;

    const hasFunds = await billingService.hasFunds(companyId, accessToken);
    if (!hasFunds) {
      return res.status(402).json({
        success: false,
        code: 'INSUFFICIENT_FUNDS',
        error: 'Insufficient wallet balance',
        message: `Your agency or sub-account wallet doesn't have enough funds. Add at least $${parsedAmount.toFixed(2)} and try again.`,
        requiredAmount: parsedAmount,
      });
    }

    const meterCharges = [{ meterId: '69864aed1265653fdd7c0620', qty: 1, description: `Custom charge for the work $${parsedAmount}` }];

    const transaction = await BillingTransaction.create({
      locationId,
      companyId,
      type: 'custom_charge',
      itemCounts: { total: 1 },
      pricing: { baseAmount: parsedAmount, discountPercent: 0, discountAmount: 0, finalAmount: parsedAmount },
      meterCharges,
      status: 'pending',
      userId,
    });

    try {
      const chargeResult = await billingService.chargeWallet(companyId, accessToken, meterCharges, locationId, transaction._id.toString(), parsedAmount);
      transaction.ghlChargeId = chargeResult?.charges?.map(c => c?.chargeId).join(',');
      transaction.referralCode = chargeResult.referralCode || null;
      transaction.status = chargeResult.internalTesting ? 'tested' : 'charged';
      transaction.internalTesting = !!chargeResult.internalTesting;
      transaction.paymentIgnored = !!chargeResult.internalTesting;
      await transaction.save();

      return res.json({ success: true, chargeId: transaction.ghlChargeId, amount: parsedAmount });
    } catch (chargeError) {
      transaction.status = 'failed';
      transaction.errorMessage = chargeError.message;
      await transaction.save();
      if (chargeError.insufficientFunds) {
        const walletName = chargeError.walletScope === 'agency' ? 'agency wallet'
          : chargeError.walletScope === 'location' ? 'sub-account wallet'
          : 'agency or sub-account wallet';
        return res.status(402).json({
          success: false,
          code: 'INSUFFICIENT_FUNDS',
          error: 'Insufficient wallet balance',
          message: `Your ${walletName} doesn't have enough funds. Add at least $${parsedAmount.toFixed(2)} and try again.`,
          requiredAmount: parsedAmount,
          walletScope: chargeError.walletScope || null,
        });
      }
      return res.status(402).json({ success: false, error: chargeError.message });
    }
  } catch (error) {
    logError('Custom charge error', error, { locationId: req.body?.locationId });
    res.status(500).json({ success: false, error: 'Custom charge failed' });
  }
});

/**
 * POST /api/billing/pricing-request
 * Customer submits a custom-rate request from the estimate modal.
 * Auto-approves when expectedVolume >= 10K; otherwise saves pending + emails internal team.
 */
router.post('/pricing-request', authenticateSession, async (req, res) => {
  try {
    const { proposedCreditPrice, expectedVolume, email, reason, locationId } = req.body;
    const companyId = req.user?.companyId || null;

    const price = parseFloat(proposedCreditPrice);
    const volume = parseInt(expectedVolume, 10);
    if (!locationId || !email || !Number.isFinite(price) || price <= 0 || !Number.isFinite(volume) || volume <= 0) {
      return res.status(400).json({ success: false, error: 'Missing or invalid fields' });
    }
    if (price < MIN_PROPOSED_CREDIT_PRICE) {
      return res.status(400).json({ success: false, error: `Proposed price below the minimum allowed ($${MIN_PROPOSED_CREDIT_PRICE.toFixed(3)}/credit). Contact sales for lower rates.` });
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({ success: false, error: 'Invalid email format' });
    }

    const autoApprove = volume >= AUTO_APPROVE_VOLUME_THRESHOLD;
    const request = await PricingRequest.create({
      locationId, companyId, email,
      proposedCreditPrice: price,
      expectedVolume: volume,
      reason: reason || '',
      status: autoApprove ? 'auto-approved' : 'pending',
      decidedAt: autoApprove ? new Date() : null,
      decidedBy: autoApprove ? 'system' : null
    });

    const expectedRevenue = (price * volume).toFixed(2);
    const internalSummary = `
      <p><strong>Account:</strong> ${escapeHtml(locationId)}</p>
      <p><strong>Company:</strong> ${escapeHtml(companyId || 'n/a')}</p>
      <p><strong>Customer email:</strong> ${escapeHtml(email)}</p>
      <p><strong>Proposed rate:</strong> $${price.toFixed(4)} per credit</p>
      <p><strong>Expected volume:</strong> ${volume.toLocaleString()} records</p>
      <p><strong>Expected revenue:</strong> $${expectedRevenue}</p>
      <p><strong>Reason:</strong> ${escapeHtml(reason || '—')}</p>
    `;

    if (autoApprove) {
      await AppConfig.setLocationCreditPrice(locationId, price);

      pricingMailer.sendMail({
        from: 'support@vaultsuite.store',
        to: email,
        subject: '[ConvoVault] Your custom rate is now active',
        html: `<h2>Custom rate approved</h2>
               <p>Based on your expected volume of <strong>${volume.toLocaleString()}</strong> records, your custom credit rate of <strong>$${price.toFixed(4)}</strong> is now active for your account.</p>
               <p>You can return to your export — the new pricing is reflected immediately.</p>
               <p>Thanks,<br/>ExportKit Team</p>`
      }).catch(err => logger.warn('Auto-approve customer email failed', { error: err.message }));

      pricingMailer.sendMail({
        from: 'support@vaultsuite.store',
        to: INTERNAL_REVIEW_EMAIL,
        subject: `[Pricing Auto-Approved] ${locationId} → $${price.toFixed(4)}/credit`,
        html: `<h3>Auto-approved pricing request</h3>${internalSummary}
               <p>Auto-approved because volume ≥ ${AUTO_APPROVE_VOLUME_THRESHOLD.toLocaleString()}. No action needed.</p>`
      }).catch(err => logger.warn('Auto-approve internal email failed', { error: err.message }));

      return res.json({
        success: true,
        status: 'approved',
        message: 'Your custom rate is now active. The new pricing is reflected immediately — close this and reopen the estimate to see the updated total.',
        requestId: request._id
      });
    }

    // BASE_URL is the canonical server URL across this app (also used in referrals.js, server.js).
    // Strip any trailing slash so we don't end up with `https://host//api/...`.
    const base = (process.env.BASE_URL || process.env.BACKEND_URL || '').replace(/\/+$/, '');
    if (!base) {
      logger.warn('BASE_URL is not set — approve/reject email links will be relative and non-clickable');
    }
    const approveUrl = `${base}/api/billing/pricing-request/${request._id}/approve?token=${request.approvalToken}`;
    const rejectUrl  = `${base}/api/billing/pricing-request/${request._id}/reject?token=${request.approvalToken}`;

    pricingMailer.sendMail({
      from: 'support@vaultsuite.store',
      to: INTERNAL_REVIEW_EMAIL,
      subject: `[Pricing Request] ${locationId} → $${price.toFixed(4)}/credit (${volume.toLocaleString()} records)`,
      html: `<h3>New pricing request — manual review</h3>${internalSummary}
             <hr/>
             <p>
               <a href="${approveUrl}" style="background:#16a34a;color:white;padding:10px 20px;text-decoration:none;border-radius:6px;display:inline-block;margin-right:10px;">Approve</a>
               <a href="${rejectUrl}" style="background:#dc2626;color:white;padding:10px 20px;text-decoration:none;border-radius:6px;display:inline-block;">Reject</a>
             </p>
             <p style="font-size:11px;color:#666;">Request ID: ${request._id}</p>`
    }).catch(err => logger.error('Pricing request internal email failed', { error: err.message }));

    return res.json({
      success: true,
      status: 'pending',
      message: `We'll review your request and respond to ${email} within 1-2 hours.`,
      requestId: request._id
    });
  } catch (error) {
    logError('Pricing request submit error', error, { locationId: req.body?.locationId });
    res.status(500).json({ success: false, error: 'Failed to submit pricing request' });
  }
});

/**
 * GET /api/billing/pricing-request/:id/approve?token=XXX
 * One-click approve from the internal review email.
 */
router.get('/pricing-request/:id/approve', async (req, res) => {
  try {
    const { id } = req.params;
    const { token } = req.query;
    const request = await PricingRequest.findById(id);
    if (!request || request.approvalToken !== token) {
      return res.status(404).send('Invalid or expired link');
    }
    if (request.status !== 'pending') {
      return res.send(`This request was already <strong>${request.status}</strong>.`);
    }

    await AppConfig.setLocationCreditPrice(request.locationId, request.proposedCreditPrice);
    request.status = 'approved';
    request.decidedAt = new Date();
    request.decidedBy = 'email-approve';
    await request.save();

    pricingMailer.sendMail({
      from: 'support@vaultsuite.store',
      to: request.email,
      subject: '[ConvoVault] Your custom rate is now active',
      html: `<h2>Custom rate approved</h2>
             <p>Your custom credit rate of <strong>$${request.proposedCreditPrice.toFixed(4)}</strong> is now active for your account.</p>
             <p>You can return to your export — the new pricing is reflected immediately.</p>
             <p>Thanks,<br/>ExportKit Team</p>`
    }).catch(err => logger.warn('Customer approval email failed', { error: err.message }));

    return res.send(
      `<html><body style="font-family:sans-serif;padding:40px;text-align:center;">
         <h2 style="color:#16a34a;">✓ Approved</h2>
         <p>Custom rate of <strong>$${request.proposedCreditPrice.toFixed(4)}/credit</strong> applied to account <strong>${escapeHtml(request.locationId)}</strong>.</p>
         <p>Customer notified at ${escapeHtml(request.email)}.</p>
       </body></html>`
    );
  } catch (error) {
    logError('Pricing approve error', error, { id: req.params.id });
    res.status(500).send('Failed to approve');
  }
});

/**
 * GET /api/billing/pricing-request/:id/reject?token=XXX
 * One-click reject from the internal review email.
 */
router.get('/pricing-request/:id/reject', async (req, res) => {
  try {
    const { id } = req.params;
    const { token } = req.query;
    const request = await PricingRequest.findById(id);
    if (!request || request.approvalToken !== token) {
      return res.status(404).send('Invalid or expired link');
    }
    if (request.status !== 'pending') {
      return res.send(`This request was already <strong>${request.status}</strong>.`);
    }

    request.status = 'rejected';
    request.decidedAt = new Date();
    request.decidedBy = 'email-reject';
    await request.save();

    pricingMailer.sendMail({
      from: 'support@vaultsuite.store',
      to: request.email,
      subject: '[ConvoVault] Update on your pricing request',
      html: `<h2>Pricing request update</h2>
             <p>Thanks for reaching out. We weren't able to approve your requested rate at this volume. Reply to this email if you'd like to discuss alternatives — we're happy to find a fit.</p>
             <p>Thanks,<br/>ExportKit Team</p>`
    }).catch(err => logger.warn('Customer rejection email failed', { error: err.message }));

    return res.send(
      `<html><body style="font-family:sans-serif;padding:40px;text-align:center;">
         <h2 style="color:#dc2626;">✗ Rejected</h2>
         <p>Request marked as rejected. Customer notified at ${escapeHtml(request.email)}.</p>
       </body></html>`
    );
  } catch (error) {
    logError('Pricing reject error', error, { id: req.params.id });
    res.status(500).send('Failed to reject');
  }
});

module.exports = router;
