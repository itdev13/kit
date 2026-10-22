const { S3Client, CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
const axios = require('axios');
const crypto = require('crypto');
const { MongoClient, ObjectId } = require('mongodb');
// Headless-Chrome PDF rendering for the Contact Bundle "Google Doc" export is loaded LAZILY inside
// buildContactBundlePdf() — NOT at module top level. @sparticuz/chromium lives on a Lambda layer;
// requiring it at the top would crash EVERY export (CSV/JSON included) if the layer were ever
// missing. Lazy-loading keeps all other export types working regardless of the PDF deps.

// Public base URL of the convo-vault backend, used to build the email download link that
// regenerates a fresh presigned URL on click. Falls back to the prod host.
const PUBLIC_API_URL = process.env.PUBLIC_API_URL || 'https://convoapi.vaultsuite.store';


// Initialize AWS services
const s3 = new S3Client();
const lambda = new LambdaClient();

// Environment variables
const S3_BUCKET = process.env.S3_BUCKET || 'convo-vault-exports';
const MONGODB_URI = process.env.MONGODB_URI;
const GHL_API_URL = process.env.GHL_API_URL || 'https://services.leadconnectorhq.com';
const GHL_OAUTH_URL = process.env.GHL_OAUTH_URL || 'https://services.leadconnectorhq.com/oauth';
const GHL_CLIENT_ID = process.env.GHL_CLIENT_ID;
const GHL_CLIENT_SECRET = process.env.GHL_CLIENT_SECRET;
// Lite ("Export Messages") app credentials — used to refresh lite jobs' tokens.
const GHL_LITE_CLIENT_ID = process.env.GHL_LITE_CLIENT_ID;
const GHL_LITE_CLIENT_SECRET = process.env.GHL_LITE_CLIENT_SECRET;

// Brevo Email configuration
const BREVO_API_KEY = process.env.BREVO_API_KEY;
const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';
const EMAIL_FROM_NAME = 'VaultSuite';
const EMAIL_FROM_ADDRESS = 'support@vaultsuite.store';

// Batch processing configuration
// Lowered from 5000 → 2000 to cap peak heap per invocation. The OOM (Runtime.OutOfMemory at
// 2048MB) came from materializing a full batch at once: the `records` array + its stringified
// `content` + the `accumulated` (pendingBuffer + content) copy + the .map() intermediate array
// all live simultaneously. Fat records (messages w/ attachments, contacts w/ many custom fields)
// made 5000 exceed 2GB. Fewer records per invocation = smaller peak; the self-invoke chain just
// runs a few more times.
const BATCH_SIZE = 2000;            // Records per Lambda invocation
const API_PAGE_SIZE = 100;          // Records per GHL API call
const API_MESSAGES_PAGE_SIZE = 1000;
const API_CALL_LOGS_PAGE_SIZE = 50; // Max pageSize for Voice AI call logs API
const TIMEOUT_BUFFER_MS = 13 * 60 * 1000;  // 14 min buffer before timeout

// MongoDB client (reused across warm invocations)
let dbClient = null;

/**
 * Sleep helper
 */
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Get MongoDB connection
 */
async function getDb() {
  if (!dbClient) {
    dbClient = new MongoClient(MONGODB_URI);
    await dbClient.connect();
  }
  return dbClient.db();
}

/**
 * Refresh GHL access token
 * Returns both the new access token and new refresh token
 */
async function refreshAccessToken(refreshToken, isLite = false) {
  // Lite tokens were issued by the lite app → refresh with lite creds, else premium.
  const params = new URLSearchParams();
  params.append('client_id', isLite ? GHL_LITE_CLIENT_ID : GHL_CLIENT_ID);
  params.append('client_secret', isLite ? GHL_LITE_CLIENT_SECRET : GHL_CLIENT_SECRET);
  params.append('grant_type', 'refresh_token');
  params.append('refresh_token', refreshToken);

  const response = await axios.post(`${GHL_OAUTH_URL}/token`, params, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  });

  return {
    accessToken: response.data.access_token,
    refreshToken: response.data.refresh_token
  };
}

/**
 * Fetch a single page of conversations
 */
async function fetchConversationsPage(locationId, accessToken, filters, skip) {
  const params = {
    locationId,
    limit: API_PAGE_SIZE,
    skip,
    ...filters
  };

  // Convert date filters to timestamps (start of day / end of day)
  if (params.startDate) {
    const date = new Date(params.startDate);
    date.setHours(0, 0, 0, 0); // 12:00 AM
    params.startDate = date.getTime();
  }
  if (params.endDate) {
    const date = new Date(params.endDate);
    date.setHours(23, 59, 59, 999); // 11:59 PM
    params.endDate = date.getTime();
  }

  const response = await axios.get(`${GHL_API_URL}/conversations/search`, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Version': '2021-07-28'
    },
    params
  });

  return {
    data: response.data.conversations || [],
    hasMore: (response.data.conversations || []).length === API_PAGE_SIZE
  };
}

/**
 * Fetch a single page of messages
 */
async function fetchMessagesPage(locationId, accessToken, filters, cursor) {
  // Only pass valid GHL message export params — exclude internal fields
  const params = {
    locationId,
    limit: API_MESSAGES_PAGE_SIZE,
  };
  if (filters.channel) params.channel = filters.channel;
  if (filters.startDate) params.startDate = filters.startDate;
  if (filters.endDate) params.endDate = filters.endDate;
  if (filters.contactId) params.contactId = filters.contactId;
  if (filters.conversationId) params.conversationId = filters.conversationId;
  if (filters.query) params.query = filters.query;
  if (filters.id) params.id = filters.id;
  if (filters.direction) params.direction = filters.direction;
  if (Array.isArray(filters.userIds) && filters.userIds.length > 0) {
    params.userIds = filters.userIds.filter(Boolean);
  }

  // Convert date filters to ISO strings (start of day / end of day)
  if (params.startDate) {
    const date = new Date(params.startDate);
    date.setHours(0, 0, 0, 0); // 12:00 AM
    params.startDate = date.toISOString();
  }
  if (params.endDate) {
    const date = new Date(params.endDate);
    date.setHours(23, 59, 59, 999); // 11:59 PM
    params.endDate = date.toISOString();
  }

  if (cursor) {
    params.cursor = cursor;
  }

  const response = await axios.get(`${GHL_API_URL}/conversations/messages/export`, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Version': '2021-07-28'
    },
    params
  });

  return {
    data: response.data.messages || [],
    nextCursor: response.data.nextCursor || null
  };
}





/**
 * Fetch all notes for a specific contact
 */
async function fetchNotesForContact(contactId, accessToken) {
  const response = await axios.get(`${GHL_API_URL}/contacts/${contactId}/notes`, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Version': '2021-07-28'
    }
  });
  return response.data.notes || [];
}

function nonNullValue(val){
  return val != null && val != undefined && val != "";
}

/**
 * Fetch all tasks for a specific contact
 */
/**
 * Fetch a page of tasks for a location via location-level search API
 */
/**
 * Fetch a single page of contacts via POST /contacts/search.
 * Cursor pagination: each contact in the response carries its own `searchAfter`
 * array (the ES sort tuple — default sort is date_added desc with _id tiebreaker).
 * The next page's cursor is the LAST contact's searchAfter array.
 */
async function fetchContactsPage(locationId, accessToken, filters, cursor) {
  const PAGE_LIMIT = 500; // OAuth/Marketplace hard cap is 500 per request
  const body = {
    locationId,
    pageLimit: PAGE_LIMIT
  };
  if (Array.isArray(cursor) && cursor.length > 0) {
    body.searchAfter = cursor;
  }

  const f = filters || {};
  if (f.query) body.query = f.query;
  const filterExpr = [];
  if (f.tag) filterExpr.push({ field: 'tags', operator: 'contains', value: f.tag });
  if (f.assignedTo) filterExpr.push({ field: 'assignedTo', operator: 'eq', value: f.assignedTo });
  if (f.startDate || f.endDate) {
    const range = {};
    if (f.startDate) range.gte = new Date(f.startDate).getTime();
    if (f.endDate) range.lte = new Date(f.endDate).getTime();
    filterExpr.push({ field: 'dateAdded', operator: 'range', value: range });
  }
  if (filterExpr.length) body.filters = filterExpr;

  const response = await axios.post(`${GHL_API_URL}/contacts/search`, body, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Version': '2021-07-28'
    }
  });

  const contacts = response.data.contacts || [];

  // Next-page cursor = last contact's `searchAfter` (the ES sort array).
  // Stop paginating when fewer than PAGE_LIMIT returned — that's the last page.
  let nextCursor = null;
  if (contacts.length === PAGE_LIMIT) {
    const last = contacts[contacts.length - 1];
    if (Array.isArray(last?.searchAfter) && last.searchAfter.length > 0) {
      nextCursor = last.searchAfter;
    }
  }

  return { data: contacts, nextCursor };
}

async function fetchTasksPage(locationId, accessToken, skip, filters = {}) {
  const LIMIT = 1000;
  const body = { limit: LIMIT, skip, count: true };

  // contactId is always an array in the API
  if (filters.contactIds && filters.contactIds.length > 0) {
    body.contactId = filters.contactIds;
  }
  if (filters.assignedTo) body.assignedTo = filters.assignedTo;
  if (nonNullValue(filters.completed)) body.completed = filters.completed;
  if (nonNullValue(filters.overdue)) body.overdue = filters.overdue;
  if (filters.query) body.query = filters.query;
  // dueDate filter: { gt, lte }
  if (filters.dueDate) body.dueDate = filters.dueDate;
  if (filters.sortKey) body.sortKey = filters.sortKey;
  if (nonNullValue(filters.sortDirection)) body.sortDirection = filters.sortDirection;
  if (nonNullValue(filters.businessId)) body.businessId = filters.businessId;
  if (nonNullValue(filters.unAssigned)) body.unAssigned = filters.unAssigned;

  const response = await axios.post(`${GHL_API_URL}/locations/${locationId}/tasks/search`, body, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Version': '2021-07-28'
    }
  });

  const tasks = response.data.tasks || [];
  const total = response.data.count || response.data.total || 0;
  return { data: tasks, total, hasMore: tasks.length >= LIMIT };
}

/**
 * Fetch a page of opportunities for a location
 */
async function fetchOpportunitiesPage(locationId, accessToken, page, filters = {}) {
  const body = {
    locationId,
    limit: API_PAGE_SIZE,
    page
  };

  if (filters.query) body.query = filters.query;

  // Build filters array from named options
  const filterArr = [];
  if (filters.pipelineId) filterArr.push({ field: 'pipeline_id', operator: 'eq', value: filters.pipelineId });
  if (filters.pipelineStageId) filterArr.push({ field: 'pipeline_stage_id', operator: 'eq', value: filters.pipelineStageId });
  if (filters.status) filterArr.push({ field: 'status', operator: 'eq', value: filters.status });
  if (filters.assignedTo) filterArr.push({ field: 'assigned_to', operator: 'eq', value: filters.assignedTo });
  if (filters.contactId) filterArr.push({ field: 'contact_id', operator: 'eq', value: filters.contactId });
  if (filters.contactName) filterArr.push({ field: 'contact_name', operator: 'contains', value: filters.contactName });

  // Monetary value range
  if (filters.monetaryValueMin != null || filters.monetaryValueMax != null) {
    const range = {};
    if (filters.monetaryValueMin != null) range.gte = Number(filters.monetaryValueMin);
    if (filters.monetaryValueMax != null) range.lte = Number(filters.monetaryValueMax);
    if (Object.keys(range).length > 0) filterArr.push({ field: 'monetary_value', operator: 'range', value: range });
  }

  // Date added range
  if (filters.startDate || filters.endDate) {
    const range = {};
    if (filters.startDate) range.gte = new Date(filters.startDate).getTime();
    if (filters.endDate) range.lte = new Date(filters.endDate).getTime();
    filterArr.push({ field: 'date_added', operator: 'range', value: range });
  }

  if (filterArr.length > 0) body.filters = filterArr;

  // Sort
  if (filters.sortField) {
    body.sort = [{ field: filters.sortField, direction: filters.sortDirection || 'desc' }];
  }

  const response = await axios.post(`${GHL_API_URL}/opportunities/search`, body, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Version': '2021-07-28'
    }
  });

  const opportunities = response.data.opportunities || [];
  const total = response.data.total || 0;

  return {
    data: opportunities,
    total,
    hasMore: opportunities.length === API_PAGE_SIZE
  };
}

/**
 * Fetch all tags for a location (single-shot — no pagination, no filters).
 * GET /locations/{locationId}/tags
 */
async function fetchTagsAll(locationId, accessToken) {
  const response = await axios.get(`${GHL_API_URL}/locations/${locationId}/tags`, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Version': '2021-07-28'
    }
  });
  const tags = response.data.tags || [];
  return { data: tags, total: tags.length, hasMore: false };
}

/**
 * Fetch all custom values for a location (single-shot — no pagination).
 * GET /locations/{locationId}/customValues?documentType=...
 * Note: when documentType=folder the GHL response key flips to `customValueFolders`.
 */
async function fetchCustomValuesAll(locationId, accessToken, filters = {}) {
  const documentType = filters?.documentType || 'all';
  const response = await axios.get(`${GHL_API_URL}/locations/${locationId}/customValues`, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Version': '2021-07-28'
    },
    params: { documentType }
  });
  const items = response.data.customValues || response.data.customValueFolders || [];
  return { data: items, total: items.length, hasMore: false };
}

/**
 * Fetch all custom fields for a location (single-shot — no pagination).
 * GET /locations/{locationId}/customFields?model=...
 */
async function fetchCustomFieldsAll(locationId, accessToken, filters = {}) {
  const model = filters?.model || 'all';
  const response = await axios.get(`${GHL_API_URL}/locations/${locationId}/customFields`, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Version': '2021-07-28'
    },
    params: { model }
  });
  const fields = response.data.customFields || response.data.fields || [];
  return { data: fields, total: fields.length, hasMore: false };
}

/**
 * Fetch a page of templates for a location
 * GET /locations/{locationId}/templates
 */
async function fetchTemplatesPage(locationId, accessToken, skip, filters = {}) {
  const params = {
    limit: '100',
    skip: String(skip || 0),
    deleted: false
  };
  if (filters.templateType) params.type = filters.templateType;

  const response = await axios.get(`${GHL_API_URL}/locations/${locationId}/templates`, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Version': '2021-07-28'
    },
    params
  });

  const templates = response.data.templates || [];
  const total = response.data.totalCount || 0;

  return {
    data: templates,
    total,
    hasMore: templates.length === 100
  };
}

/**
 * Fetch a page of form submissions for a location
 */
async function fetchFormSubmissionsPage(locationId, accessToken, page, filters = {}) {
  const params = {
    locationId,
    limit: API_PAGE_SIZE,
    page
  };

  if (filters.formId) params.formId = filters.formId;
  if (filters.query) params.q = filters.query;

  // Convert date filters to YYYY-MM-DD format
  if (filters.startDate) {
    const date = new Date(filters.startDate);
    params.startAt = date.toISOString().split('T')[0];
  }
  if (filters.endDate) {
    const date = new Date(filters.endDate);
    params.endAt = date.toISOString().split('T')[0];
  }

  const response = await axios.get(`${GHL_API_URL}/forms/submissions`, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Version': '2021-07-28'
    },
    params
  });

  const submissions = response.data.submissions || [];
  const total = response.data.meta?.total || 0;

  return {
    data: submissions,
    total,
    hasMore: submissions.length === API_PAGE_SIZE
  };
}

/**
 * Fetch a page of trigger links for a location via /links/search
 */
async function fetchLinksPage(locationId, accessToken, skip, filters = {}) {
  const params = {
    locationId,
    limit: 1000,
    skip: skip || 0
  };
  if (filters.query) params.query = filters.query;

  const response = await axios.get(`${GHL_API_URL}/links/search`, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Version': '2021-07-28'
    },
    params
  });

  const links = response.data.links || [];
  const total = response.data.totalCount || links.length;

  return {
    data: links,
    total,
    hasMore: links.length === 1000
  };
}

/**
 * Fetch a page of social media posts for a location
 */
async function fetchSocialPostsPage(locationId, accessToken, skip = 0, filters = {}) {
  const body = {
    limit: API_PAGE_SIZE,
    skip
  };

  if (filters.type) body.type = filters.type;
  if (filters.status) body.status = filters.status;
  if (filters.accountIds) body.accountIds = filters.accountIds;

  const response = await axios.post(`${GHL_API_URL}/social-media-posting/${locationId}/posts/list`, body, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Version': '2021-07-28'
    }
  });

  const posts = response.data.posts || response.data.data || [];

  return {
    data: posts,
    total: response.data.total || posts.length,
    hasMore: posts.length === API_PAGE_SIZE
  };
}

/**
 * Fetch a page of voice AI call logs for a location
 * Note: Uses Version header 2021-04-15
 */
async function fetchCallLogsPage(locationId, accessToken, page = 1, filters = {}) {
  const params = {
    locationId,
    page,
    pageSize: API_CALL_LOGS_PAGE_SIZE
  };

  if (filters.agentId) params.agentId = filters.agentId;
  if (filters.contactId) params.contactId = filters.contactId;
  if (filters.callType) params.callType = filters.callType;
  if (filters.actionType) params.actionType = filters.actionType;
  if (filters.direction) params.direction = filters.direction;
  if (filters.callSortBy) params.sortBy = filters.callSortBy;
  if (filters.callSort) params.sort = filters.callSort;

  // Convert date filters
  if (filters.startDate) {
    const date = new Date(filters.startDate);
    date.setHours(0, 0, 0, 0);
    params.startDate = date.toISOString();
  }
  if (filters.endDate) {
    const date = new Date(filters.endDate);
    date.setHours(23, 59, 59, 999);
    params.endDate = date.toISOString();
  }

  const response = await axios.get(`${GHL_API_URL}/voice-ai/dashboard/call-logs`, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Version': '2021-04-15'
    },
    params
  });

  const callLogs = response.data.callLogs || [];
  const total = response.data.total || 0;

  return {
    data: callLogs,
    total,
    hasMore: callLogs.length === API_CALL_LOGS_PAGE_SIZE
  };
}

/**
 * Escape CSV value
 */
function escapeCsv(val) {
  if (val === null || val === undefined) return '';
  const str = String(val).replace(/"/g, '""').replace(/\n/g, ' ').replace(/\r/g, '');
  return `"${str}"`;
}

/**
 * Format date to readable string (ISO format)
 */
function formatDate(val) {
  if (!val) return '';
  try {
    const date = new Date(val);
    if (isNaN(date.getTime())) return '';
    return date.toISOString();
  } catch {
    return '';
  }
}

/**
 * Convert conversations to CSV format
 */
function conversationsToCSV(conversations, includeHeader = true) {
  const header = includeHeader
    ? 'ID,ContactID,ContactName,ContactEmail,ContactPhone,Type,LastMessageType,LastMessageDate,UnreadCount,DateAdded\n'
    : '';

  const rows = conversations.map(conv => {
    return [
      escapeCsv(conv.id),
      escapeCsv(conv.contactId),
      escapeCsv(conv.contactName || conv.fullName),
      escapeCsv(conv.email),
      escapeCsv(conv.phone),
      escapeCsv(conv.type),
      escapeCsv(conv.lastMessageType),
      escapeCsv(formatDate(conv.lastMessageDate)),
      escapeCsv(conv.unreadCount || 0),
      escapeCsv(formatDate(conv.dateAdded))
    ].join(',');
  }).join('\n');

  return header + rows + (rows.length > 0 ? '\n' : '');
}

/**
 * Convert messages to CSV format
 * @param {Array} messages - Messages to convert
 * @param {boolean} includeHeader - Include CSV header row
 * @param {string} channelFilter - Channel filter (Email, SMS, Call, Facebook, Instagram, WhatsApp, etc.)
 */
function messagesToCSV(messages, includeHeader = true, channelFilter = '') {
  const isEmailExport = channelFilter === 'Email';

  // Different headers based on channel type
  let header = '';
  if (includeHeader) {
    if (isEmailExport) {
      // Email-specific columns with Subject, CC, BCC
      header = 'Date,ConversationID,ContactID,UserID,ConversationProviderId,MessageType,Direction,Status,From,To,Subject,CC,BCC,Message,Attachments,Source\n';
    } else {
      // Default for SMS, WhatsApp, Facebook, Instagram, Call, etc. - includes meta fields
      header = 'Date,ConversationID,ContactID,UserID,ConversationProviderId,MessageType,Direction,Status,From,To,Message,Attachments,Source,CallDuration,CallStatus,FacebookPage,InstagramPage\n';
    }
  }

  const rows = messages.map(msg => {
    const direction = msg.direction || msg?.meta?.email?.direction || 'outbound';
    const isEmail = msg.messageType === 'TYPE_EMAIL' || msg.messageType === 'TYPE_CAMPAIGN_EMAIL' || msg.messageType === 'TYPE_CUSTOM_EMAIL' || msg.messageType === 'TYPE_CUSTOM_PROVIDER_EMAIL';

    // For emails, get email-specific fields from meta
    const emailMeta = msg.meta?.email || {};
    const subject = emailMeta.subject || msg?.subject || '';
    const cc = emailMeta.cc || msg?.cc || '';
    const bcc = emailMeta.bcc || msg?.bcc || '';

    // From/To: for emails use email addresses, for others use phone numbers
    const from = (isEmail ? emailMeta.from || msg.from : msg.from) || '';
    let to = (isEmail ? emailMeta.to || msg.to : msg.to) || '';
    if(Array.isArray(to)){
      to = to?.join(";");
    }

    // Attachments as semicolon-separated URLs
    const attachments = Array.isArray(msg.attachments) ? msg.attachments.join('; ') : '';

    // Source (workflow, bulk_actions, campaign, api, app)
    const source = msg.source || '';

    // Meta fields for non-email exports
    const callDuration = msg.meta?.callDuration || '';
    const callStatus = msg.meta?.callStatus || '';
    const fbPage = msg.meta?.fb?.page_name || '';
    const igPage = msg.meta?.ig?.page_name || '';

    // Build row based on export type
    if (isEmailExport) {
      return [
        escapeCsv(formatDate(msg.dateAdded)),
        escapeCsv(msg.conversationId),
        escapeCsv(msg.contactId),
        escapeCsv(msg.userId || ''),
        escapeCsv(msg.conversationProviderId || ''),
        escapeCsv(msg.messageType || msg.type),
        escapeCsv(direction),
        escapeCsv(msg.status),
        escapeCsv(from),
        escapeCsv(to),
        escapeCsv(subject),
        escapeCsv(cc),
        escapeCsv(bcc),
        escapeCsv(msg.body),
        escapeCsv(attachments),
        escapeCsv(source)
      ].join(',');
    } else {
      // Default for all other channels - includes meta fields
      return [
        escapeCsv(formatDate(msg.dateAdded)),
        escapeCsv(msg.conversationId),
        escapeCsv(msg.contactId),
        escapeCsv(msg.userId || ''),
        escapeCsv(msg.conversationProviderId || ''),
        escapeCsv(msg.messageType || msg.type),
        escapeCsv(direction),
        escapeCsv(msg.status),
        escapeCsv(from),
        escapeCsv(to),
        escapeCsv(msg.body),
        escapeCsv(attachments),
        escapeCsv(source),
        escapeCsv(callDuration),
        escapeCsv(callStatus),
        escapeCsv(fbPage),
        escapeCsv(igPage)
      ].join(',');
    }
  }).join('\n');

  return header + rows + (rows.length > 0 ? '\n' : '');
}


/**
 * Convert call transcriptions to CSV format.
 * Records are pre-fetched objects: { messageId, conversationId, contactId, userId, direction, status, dateAdded, callDuration, callStatus, transcript, segments }
 */
/**
 * Convert contacts to CSV format
 */
function contactsToCSV(contacts, includeHeader = true) {
  const header = includeHeader
    ? 'ID,FirstName,LastName,Name,Email,AdditionalEmails,Phone,CompanyName,Website,Source,Type,Tags,AssignedTo,Address1,City,State,Country,PostalCode,Timezone,DateOfBirth,Gender,DND,DateAdded,DateUpdated,CustomFields\n'
    : '';
  const rows = contacts.map(c => {
    const tags = Array.isArray(c.tags) ? c.tags.join('; ') : '';
    const additionalEmails = Array.isArray(c.additionalEmails)
      ? c.additionalEmails.map(e => e?.email || '').filter(Boolean).join('; ')
      : '';
    const customFields = Array.isArray(c.customFields)
      ? c.customFields.map(f => `${f.id}=${typeof f.value === 'object' ? JSON.stringify(f.value) : f.value}`).join('; ')
      : '';
    return [
      escapeCsv(c.id || ''),
      escapeCsv(c.firstName || c.firstNameRaw || ''),
      escapeCsv(c.lastName || c.lastNameRaw || ''),
      escapeCsv(c.name || c.contactName || ''),
      escapeCsv(c.email || ''),
      escapeCsv(additionalEmails),
      escapeCsv(c.phone || ''),
      escapeCsv(c.companyName || ''),
      escapeCsv(c.website || ''),
      escapeCsv(c.source || ''),
      escapeCsv(c.type || ''),
      escapeCsv(tags),
      escapeCsv(c.assignedTo || ''),
      escapeCsv(c.address1 || ''),
      escapeCsv(c.city || ''),
      escapeCsv(c.state || ''),
      escapeCsv(c.country || ''),
      escapeCsv(c.postalCode || ''),
      escapeCsv(c.timezone || ''),
      escapeCsv(c.dateOfBirth || ''),
      escapeCsv(c.gender || ''),
      escapeCsv(c.dnd ? 'true' : 'false'),
      escapeCsv(formatDate(c.dateAdded)),
      escapeCsv(formatDate(c.dateUpdated)),
      escapeCsv(customFields)
    ].join(',');
  }).join('\n');
  return header + rows + (rows.length > 0 ? '\n' : '');
}

function callTranscriptionsToCSV(records, includeHeader = true) {
  const header = includeHeader
    ? 'Date,ConversationID,ContactID,MessageID,MessageType,UserID,Direction,Status,CallDuration,CallStatus,Transcript\n'
    : '';
  const rows = records.map(r => [
    escapeCsv(formatDate(r.dateAdded)),
    escapeCsv(r.conversationId || ''),
    escapeCsv(r.contactId || ''),
    escapeCsv(r.messageId || ''),
    escapeCsv(r.messageType || ''),
    escapeCsv(r.userId || ''),
    escapeCsv(r.direction || ''),
    escapeCsv(r.status || ''),
    escapeCsv(r.callDuration || ''),
    escapeCsv(r.callStatus || ''),
    escapeCsv(r.transcript || '')
  ].join(',')).join('\n');

  return header + rows + (rows.length > 0 ? '\n' : '');
}

/**
 * Call Recordings — one row per recorded call with the recording download URL.
 */
function callRecordingsToCSV(records, includeHeader = true) {
  const header = includeHeader
    ? 'Date,ConversationID,ContactID,MessageID,MessageType,UserID,Direction,Status,AttachmentURL\n'
    : '';
  const rows = records.map(r => [
    escapeCsv(formatDate(r.dateAdded)),
    escapeCsv(r.conversationId || ''),
    escapeCsv(r.contactId || ''),
    escapeCsv(r.messageId || ''),
    escapeCsv(r.messageType || ''),
    escapeCsv(r.userId || ''),
    escapeCsv(r.direction || ''),
    escapeCsv(r.status || ''),
    escapeCsv(r.attachmentUrl || '')
  ].join(',')).join('\n');

  return header + rows + (rows.length > 0 ? '\n' : '');
}

/**
 * Contact Bundle — one CSV row per message, already sorted by dateAdded ASC in the walker.
 * Categories: sms / email / call (used for billing; surfaced as the `Category` column for QA).
 *
 * The `Body` column holds the human-readable text for every category — for calls we prefer the
 * transcription text (the real value the customer asked for) over GHL's placeholder body. The
 * separate `Transcription` column was redundant and has been dropped.
 */
function contactBundleToCSV(records, includeHeader = true) {
  const header = includeHeader
    ? 'ContactID,ConversationID,MessageID,Category,Channel,Direction,DateAdded,From,To,Subject,Body,Status,DurationSeconds\n'
    : '';
  const rows = records.map(r => {
    // For call rows: prefer transcription text (what the customer is paying $0.05/each for).
    // Fall back to the call's body field only if transcription is empty.
    const bodyOrTranscript = r.category === 'call'
      ? (r.transcription || r.body || '')
      : (r.body || '');
    return [
      escapeCsv(r.contactId || ''),
      escapeCsv(r.conversationId || ''),
      escapeCsv(r.messageId || ''),
      escapeCsv(r.category || ''),
      escapeCsv(r.channel || ''),
      escapeCsv(r.direction || ''),
      escapeCsv(r.dateAdded || ''),
      escapeCsv(r.from || ''),
      escapeCsv(r.to || ''),
      escapeCsv(r.subject || ''),
      escapeCsv(bodyOrTranscript),
      escapeCsv(r.status || ''),
      escapeCsv(r.durationSeconds != null ? String(r.durationSeconds) : '')
    ].join(',');
  }).join('\n');
  return header + rows + (rows.length > 0 ? '\n' : '');
}

/**
 * Build the Contact Bundle (Google Doc) .docx Buffer from ALL contactBundle records.
 *
 * Google Docs collapses by heading style, so the structure mirrors the bundle hierarchy:
 *   Heading 1  = each contact (ContactID)
 *   Heading 2  = each channel/conversation group within that contact
 *   body       = each message (date / direction / from / to, then body or call transcript)
 *
 * Records use the SAME field shape as contactBundleToCSV:
 *   { contactId, conversationId, messageId, category, channel, direction, dateAdded,
 *     from, to, subject, body, status, durationSeconds, transcription }
 *
 * A .docx is a binary zip and cannot be streamed in text chunks — it is built as ONE complete
 * file in memory and returned as a Buffer for a single S3 PutObject.
 */
// HTML-escape helper for the PDF template.
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Build a GHL-style conversation HTML document from the bundle records.
// Build a GHL-inbox-style conversation HTML document from the bundle records, then rendered to PDF.
// Layout mirrors the HighLevel Conversations view: avatars with initials, date separators, channel
// badges, inbound (left/grey) vs outbound (right/blue) bubbles, big inline images for attachments,
// and call rows shown with their transcript.
function buildContactBundleHtml(records) {
  const byContact = new Map();
  for (const r of records) {
    const cid = r.contactId || 'unknown';
    if (!byContact.has(cid)) byContact.set(cid, []);
    byContact.get(cid).push(r);
  }

  const initials = (name) => {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    return ((parts[0][0] || '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
  };
  const isImageUrl = (u) => /\.(png|jpe?g|gif|webp|bmp|svg)(\?|$)/i.test(String(u || ''));
  // Account timezone (stamped on rows by the backend) — render all times in the sub-account's zone.
  const tz = records.find(r => r && r.timezone)?.timezone || undefined;
  const tzOpts = (o) => (tz ? { ...o, timeZone: tz } : o);
  const dayKey = (d) => {
    const t = new Date(d);
    if (isNaN(t)) return '';
    try { return t.toLocaleDateString('en-CA', tzOpts({})); } catch { return t.toISOString().slice(0, 10); }
  };
  const dayLabel = (d) => { const t = new Date(d); return isNaN(t) ? '' : t.toLocaleDateString('en-US', tzOpts({ month: 'short', day: 'numeric' })); };
  const timeLabel = (d) => { const t = new Date(d); return isNaN(t) ? '' : t.toLocaleTimeString('en-US', tzOpts({ hour: 'numeric', minute: '2-digit' })); };
  // Call duration HH:MM:SS style: <60s → "Ns"; <60min → "Mm Ss"; ≥60min → "Hh Mm Ss".
  const formatDuration = (secs) => {
    const s = parseInt(secs, 10);
    if (!Number.isFinite(s) || s <= 0) return '';
    if (s < 60) return `${s}s`;
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    if (s < 3600) return `${m}m ${sec}s`;
    return `${h}h ${m}m ${sec}s`;
  };

  let sections = '';
  for (const [contactId, rows] of byContact) {
    const meta = rows[0] || {};
    const name = esc(meta.contactName || contactId);

    // Header block (mirrors Clifford's sample).
    let header =
      '<div class="export-head">' +
        '<div class="eh-title">Conversation Export for <span class="eh-name">' + name + '</span> ' +
          '<span class="eh-id">(' + esc(contactId) + ')</span></div>' +
        (meta.contactEmail ? '<div class="eh-sub">Email: ' + esc(meta.contactEmail) + '</div>' : '') +
        (meta.contactPhone ? '<div class="eh-sub">Phone: ' + esc(meta.contactPhone) + '</div>' : '') +
        '<div class="eh-sub">Exported at ' + esc(new Date().toLocaleString('en-US', tzOpts({}))) + '</div>' +
      '</div>';

    // Inbox header bar (GHL-style).
    let inbox = '<div class="inbox">' +
      '<div class="inbox-bar"><div class="ib-av">' + esc(initials(meta.contactName || contactId)) + '</div>' +
      '<div class="ib-name">' + name + '</div></div>' +
      '<div class="thread">';

    let lastDay = null;
    for (const r of rows) {
      // Date separator pill when the day changes.
      const dk = dayKey(r.dateAdded);
      if (dk && dk !== lastDay) {
        lastDay = dk;
        inbox += '<div class="daysep"><span>\u{1F4C5} ' + esc(dayLabel(r.dateAdded)) + '</span></div>';
      }

      const outbound = String(r.direction || '').toLowerCase() === 'outbound';
      const side = outbound ? 'out' : 'in';
      // Outbound: show the sending user's name (fallback to "Team"); inbound: the contact.
      const senderName = outbound ? (r.senderName || 'Team') : (meta.contactName || contactId);
      const avInit = esc(initials(senderName));
      const channel = esc(r.channel || r.category || '');
      const isCall = r.category === 'call' || /call/i.test(channel);

      // Bubble content.
      let inner = '';
      if (channel) inner += '<div class="badge">☎︎ ' + channel + '</div>';
      inner += '<div class="sender">' + esc(senderName) + '</div>';
      if (r.subject) inner += '<div class="subj">' + esc(r.subject) + '</div>';

      if (isCall) {
        const dur = formatDuration(r.durationSeconds);
        inner += '<div class="callrow">\u{1F4DE} Call' + (r.status ? ' ' + esc(r.status) : ' completed') + (dur ? ' · ' + esc(dur) : '') + '</div>';
        const t = r.transcription || '';
        if (t) inner += '<div class="transcript"><div class="tr-h">Transcript</div>' + esc(t).replace(/\r?\n/g, '<br>') + '</div>';
      } else {
        const body = esc(r.body || '').replace(/\r?\n/g, '<br>');
        if (body) inner += '<div class="body">' + body + '</div>';
      }

      // Attachments — BIG inline images when image URLs; otherwise a link. Shown for ALL rows
      // (including calls — a call may carry its recording/voicemail as an attachment).
      const atts = Array.isArray(r.attachments) ? r.attachments.filter(Boolean) : [];
      for (const url of atts) {
        if (isImageUrl(url)) {
          inner += '<div class="att-img"><img src="' + esc(url) + '" /></div>';
        } else {
          inner += '<div class="att"><a href="' + esc(url) + '">\u{1F4CE} ' + esc(url) + '</a></div>';
        }
      }
      if (!inner) inner = '<div class="body empty">(no content)</div>';

      inbox +=
        '<div class="row ' + side + '">' +
          '<div class="av">' + avInit + '</div>' +
          '<div class="bcol">' +
            '<div class="bubble">' + inner + '</div>' +
            '<div class="time">' + esc(timeLabel(r.dateAdded)) + '</div>' +
          '</div>' +
        '</div>';
    }
    inbox += '</div></div>';

    sections += '<section class="contact">' + header + inbox + '</section>';
  }

  return '<!doctype html><html><head><meta charset="utf-8"><style>' +
    '*{box-sizing:border-box;} body{font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2937;margin:0;padding:20px;font-size:13px;background:#fff;}' +
    '.contact{margin-bottom:34px;page-break-inside:auto;}' +
    '.export-head{margin-bottom:12px;}' +
    '.eh-title{font-size:16px;font-weight:600;color:#111827;}' +
    '.eh-name{color:#2563eb;} .eh-id{color:#6b7280;font-weight:400;font-size:12px;}' +
    '.eh-sub{color:#6b7280;font-size:12px;margin-top:2px;}' +
    '.inbox{border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;}' +
    '.inbox-bar{display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid #eef0f3;background:#fafbfc;}' +
    '.ib-av{width:30px;height:30px;border-radius:50%;background:#fcd34d;color:#78350f;font-weight:700;font-size:12px;display:flex;align-items:center;justify-content:center;}' +
    '.ib-name{font-weight:600;color:#111827;}' +
    '.thread{padding:16px;background:#fff;}' +
    '.daysep{text-align:center;margin:16px 0;}' +
    '.daysep span{background:#f1f5f9;color:#64748b;font-size:11px;padding:4px 12px;border-radius:999px;}' +
    '.row{display:flex;align-items:flex-end;gap:8px;margin:12px 0;}' +
    '.row.out{flex-direction:row-reverse;}' +
    '.av{width:28px;height:28px;border-radius:50%;flex:0 0 28px;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;color:#fff;background:#60a5fa;}' +
    '.row.in .av{background:#fcd34d;color:#78350f;}' +
    '.bcol{max-width:74%;display:flex;flex-direction:column;}' +
    '.row.out .bcol{align-items:flex-end;}' +
    '.bubble{padding:9px 12px;border-radius:14px;line-height:1.45;background:#f1f5f9;}' +
    '.row.in .bubble{border-bottom-left-radius:4px;}' +
    '.row.out .bubble{background:#dbeafe;border-bottom-right-radius:4px;}' +
    '.badge{display:inline-block;background:#ecfdf5;color:#047857;font-size:10px;font-weight:600;padding:2px 8px;border-radius:6px;margin-bottom:5px;}' +
    '.sender{font-size:10px;font-weight:700;color:#475569;margin-bottom:3px;}' +
    '.subj{font-weight:600;margin-bottom:3px;}' +
    '.body{white-space:normal;word-break:break-word;}' +
    '.body.empty{color:#9ca3af;font-style:italic;}' +
    '.callrow{font-weight:600;color:#065f46;}' +
    '.transcript{margin-top:6px;background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:8px 10px;font-size:12px;color:#374151;}' +
    '.transcript .tr-h{font-weight:700;color:#2563eb;margin-bottom:4px;}' +
    '.att{margin-top:5px;font-size:11px;} .att a{color:#1155cc;text-decoration:none;}' +
    '.att-img{margin-top:8px;} .att-img img{max-width:100%;width:420px;border-radius:10px;border:1px solid #e5e7eb;}' +
    '.time{font-size:10px;color:#9ca3af;margin:3px 4px 0;}' +
    '</style></head><body>' + sections + '</body></html>';
}
async function buildContactBundlePdf(records) {
  const html = buildContactBundleHtml(records);
  // Lazy-load the heavy PDF deps only when a PDF export actually runs (they live on a Lambda layer).
  // Both @sparticuz/chromium and puppeteer-core ship as ES modules, so a plain require() fails under
  // the Node runtime. Use dynamic import() and unwrap the default export for each.
  const chromium = (await import('@sparticuz/chromium')).default;
  const puppeteer = (await import('puppeteer-core')).default;
  let browser;
  try {
    // @sparticuz/chromium v153 no longer exposes `headless`/`defaultViewport` as top-level props
    // (they are undefined). Pass an explicit headless value and let puppeteer use its default viewport.
    browser = await puppeteer.launch({
      args: [...chromium.args, '--no-sandbox', '--disable-setuid-sandbox'],
      executablePath: await chromium.executablePath(),
      headless: true
    });
    const page = await browser.newPage();
    // Wait for images to load, but cap it — a dead attachment URL must not hang the render.
    try {
      await page.setContent(html, { waitUntil: 'networkidle0', timeout: 45000 });
    } catch (e) {
      // Timed out waiting for some resource (e.g. a slow/broken image) — render what we have.
      log('Contact Bundle PDF: setContent networkidle timed out, rendering anyway', { error: e.message });
    }
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '16mm', bottom: '16mm', left: '14mm', right: '14mm' }
    });
    return pdf;
  } finally {
    if (browser) { try { await browser.close(); } catch (e) { /* ignore */ } }
  }
}


/**
 * Convert notes to CSV format
 */
function notesToCSV(notes, includeHeader = true) {
  const header = includeHeader
    ? 'NoteID,ContactID,ContactName,ContactEmail,ContactPhone,Body,BodyText,UserID,DateAdded,Relations\n'
    : '';

  const serializeRelations = (relations) => {
    if (!Array.isArray(relations) || relations.length === 0) return '';
    return relations.map(r => `${r.objectKey}:${r.recordId}`).join('|');
  };

  const rows = notes.map(note => {
    return [
      escapeCsv(note.id),
      escapeCsv(note.contactId),
      escapeCsv(note.contactName || ''),
      escapeCsv(note.contactEmail || ''),
      escapeCsv(note.contactPhone || ''),
      escapeCsv(note.body || ''),
      escapeCsv(note.bodyText || ''),
      escapeCsv(note.userId || ''),
      escapeCsv(formatDate(note.dateAdded)),
      escapeCsv(serializeRelations(note.relations))
    ].join(',');
  }).join('\n');

  return header + rows + (rows.length > 0 ? '\n' : '');
}

/**
 * Convert tasks to CSV format
 */
function tasksToCSV(tasks, includeHeader = true) {
  const header = includeHeader
    ? 'TaskID,ContactID,ContactName,Title,Body,DueDate,Completed,AssignedTo\n'
    : '';

  const rows = tasks.map(task => {
    return [
      escapeCsv(task._id),
      escapeCsv(task.contactId),
      escapeCsv(task.contactName || ''),
      escapeCsv(task.title || ''),
      escapeCsv(task.bodyText || task.body || ''),
      escapeCsv(task.dueDate ? formatDate(task.dueDate) : ''),
      escapeCsv(nonNullValue(task.completed)  ? (task.completed ? 'Yes' : 'No') : ''),
      escapeCsv(task.assignedTo || ''),
    ].join(',');
  }).join('\n');

  return header + rows + (rows.length > 0 ? '\n' : '');
}

/**
 * Convert opportunities to CSV format
 */
function opportunitiesToCSV(opportunities, includeHeader = true) {
  const header = includeHeader
    ? 'OpportunityID,Name,MonetaryValue,PipelineId,PipelineStageId,Status,Source,ContactId,ContactName,ContactEmail,ContactPhone,AssignedTo,LostReasonId,CreatedAt,UpdatedAt,LastStatusChangeAt,LastStageChangeAt\n'
    : '';

  const rows = opportunities.map(opp => {
    const contact = opp.contact || {};
    return [
      escapeCsv(opp.id),
      escapeCsv(opp.name),
      escapeCsv(opp.monetaryValue || 0),
      escapeCsv(opp.pipelineId),
      escapeCsv(opp.pipelineStageId),
      escapeCsv(opp.status),
      escapeCsv(opp.source || ''),
      escapeCsv(opp.contactId),
      escapeCsv(contact.name || contact.contactName || ''),
      escapeCsv(contact.email || ''),
      escapeCsv(contact.phone || ''),
      escapeCsv(opp.assignedTo || ''),
      escapeCsv(opp.lostReasonId || ''),
      escapeCsv(formatDate(opp.createdAt)),
      escapeCsv(formatDate(opp.updatedAt)),
      escapeCsv(formatDate(opp.lastStatusChangeAt)),
      escapeCsv(formatDate(opp.lastStageChangeAt))
    ].join(',');
  }).join('\n');

  return header + rows + (rows.length > 0 ? '\n' : '');
}

/**
 * Convert form submissions to CSV format
 */
function formSubmissionsToCSV(submissions, includeHeader = true) {
  const header = includeHeader
    ? 'SubmissionID,FormID,ContactID,Name,Email,CreatedAt,OtherFields\n'
    : '';

  const rows = submissions.map(sub => {
    // Flatten 'others' object into a readable string
    let otherFields = '';
    if (sub.others && typeof sub.others === 'object') {
      otherFields = Object.entries(sub.others)
        .filter(([key]) => !key.startsWith('event'))
        .map(([key, val]) => `${key}: ${val}`)
        .join('; ');
    }

    return [
      escapeCsv(sub.id),
      escapeCsv(sub.formId),
      escapeCsv(sub.contactId),
      escapeCsv(sub.name || ''),
      escapeCsv(sub.email || ''),
      escapeCsv(formatDate(sub.createdAt)),
      escapeCsv(otherFields)
    ].join(',');
  }).join('\n');

  return header + rows + (rows.length > 0 ? '\n' : '');
}

/**
 * Convert links to CSV format
 */
function linksToCSV(links, includeHeader = true) {
  const header = includeHeader
    ? 'LinkID,Name,RedirectTo,FieldKey,dateAdded,dateUpdated\n'
    : '';

  const rows = links.map(link => {
    return [
      escapeCsv(link._id),
      escapeCsv(link.name),
      escapeCsv(link.redirectTo || ''),
      escapeCsv("{{trigger_link."+link._id+"}}"),
      escapeCsv(formatDate(link.dateAdded)),
      escapeCsv(formatDate(link.dateUpdated))
    ].join(',');
  }).join('\n');

  return header + rows + (rows.length > 0 ? '\n' : '');
}

/**
 * Convert tags to CSV format
 */
function tagsToCSV(tags, includeHeader = true) {
  const header = includeHeader
    ? 'ID,Name,LocationID\n'
    : '';

  const rows = tags.map(t => {
    return [
      escapeCsv(t.id || t._id || ''),
      escapeCsv(t.name || ''),
      escapeCsv(t.locationId || '')
    ].join(',');
  }).join('\n');

  return header + rows + (rows.length > 0 ? '\n' : '');
}

/**
 * Convert custom values to CSV format
 */
function customValuesToCSV(values, includeHeader = true) {
  const header = includeHeader
    ? 'ID,Name,FieldKey,Value,DocumentType,ParentID,LocationID\n'
    : '';

  const rows = values.map(v => {
    return [
      escapeCsv(v.id || v._id || ''),
      escapeCsv(v.name || ''),
      escapeCsv(v.fieldKey || ''),
      escapeCsv(v.value || ''),
      escapeCsv(v.documentType || ''),
      escapeCsv(v.parentId || ''),
      escapeCsv(v.locationId || '')
    ].join(',');
  }).join('\n');

  return header + rows + (rows.length > 0 ? '\n' : '');
}

/**
 * Convert custom fields to CSV format
 */
function customFieldsToCSV(fields, includeHeader = true) {
  const header = includeHeader
    ? 'ID,Name,FieldKey,DataType,Model,Position,Placeholder,PicklistOptions,DateAdded\n'
    : '';

  const rows = fields.map(f => {
    const opts = Array.isArray(f.picklistOptions)
      ? f.picklistOptions.map(o => (typeof o === 'string' ? o : (o?.label || o?.value || ''))).filter(Boolean).join('; ')
      : '';
    return [
      escapeCsv(f.id || f._id || ''),
      escapeCsv(f.name || ''),
      escapeCsv(f.fieldKey || ''),
      escapeCsv(f.dataType || ''),
      escapeCsv(f.model || ''),
      escapeCsv(f.position ?? ''),
      escapeCsv(f.placeholder || ''),
      escapeCsv(opts),
      escapeCsv(formatDate(f.dateAdded))
    ].join(',');
  }).join('\n');

  return header + rows + (rows.length > 0 ? '\n' : '');
}

/**
 * Convert templates to CSV format
 */
function templatesToCSV(templates, includeHeader = true) {
  const header = includeHeader
    ? 'TemplateID,Name,Type,Subject,Body,HTML,Attachments,LocationID,OriginID,DateAdded,DateUpdated\n'
    : '';

  const rows = templates.map(t => {
    const tpl = t.template || {};
    // Email: subject, html, attachments; SMS/WhatsApp: body
    const subject = tpl.subject || '';
    const body = tpl.body || '';
    const html = tpl.html || '';

    // Attachments: prefer template.attachments (emails), fallback to urlAttachments
    const attachments = Array.isArray(tpl.attachments) && tpl.attachments.length > 0
      ? tpl.attachments
      : Array.isArray(t.urlAttachments) && t.urlAttachments.length > 0
        ? t.urlAttachments
        : [];
    const attachmentList = attachments.join('; ');

    return [
      escapeCsv(t._id || t.id || ''),
      escapeCsv(t.name || ''),
      escapeCsv(t.type || ''),
      escapeCsv(subject),
      escapeCsv(body),
      escapeCsv(html),
      escapeCsv(attachmentList),
      escapeCsv(t.locationId || ''),
      escapeCsv(t.originId || ''),
      escapeCsv(formatDate(t.dateAdded)),
      escapeCsv(formatDate(t.dateUpdated))
    ].join(',');
  }).join('\n');

  return header + rows + (rows.length > 0 ? '\n' : '');
}

/**
 * Convert social posts to CSV format
 */
function socialPostsToCSV(posts, includeHeader = true) {
  const header = includeHeader
    ? 'PostID,Summary,Type,Status,Platforms,ScheduledAt,PublishedAt,CreatedAt,UpdatedAt\n'
    : '';

  const rows = posts.map(post => {
    const platforms = Array.isArray(post.accountIds) ? post.accountIds.join('; ') : (post.platforms || '');
    return [
      escapeCsv(post.id || post._id),
      escapeCsv(post.summary || post.content || ''),
      escapeCsv(post.type || ''),
      escapeCsv(post.status || ''),
      escapeCsv(platforms),
      escapeCsv(formatDate(post.scheduledAt || post.scheduleDate)),
      escapeCsv(formatDate(post.publishedAt || post.publishDate)),
      escapeCsv(formatDate(post.createdAt)),
      escapeCsv(formatDate(post.updatedAt))
    ].join(',');
  }).join('\n');

  return header + rows + (rows.length > 0 ? '\n' : '');
}

/**
 * Convert call logs to CSV format
 */
function callLogsToCSV(callLogs, includeHeader = true) {
  const header = includeHeader
    ? 'CallID,ContactID,AgentID,FromNumber,CallType,CallStatus,Duration,Summary,CreatedAt,TrialCall,WorkflowID,MessageID,ExtractedData,CallActions,Transcript,Translation\n'
    : '';

  const rows = callLogs.map(log => {
    // Flatten extractedData into readable key=value pairs
    let extractedData = '';
    if (log.extractedData && typeof log.extractedData === 'object') {
      extractedData = Object.entries(log.extractedData)
        .map(([key, val]) => `${key}=${val}`)
        .join('; ');
    }

    // Full action details: actionType | actionName | executedAt | key params
    const actions = Array.isArray(log.executedCallActions)
      ? log.executedCallActions.map(a => {
          const parts = [`[${a.actionType || 'UNKNOWN'}] ${a.actionName || ''}`];
          if (a.executedAt) parts.push(`executed: ${formatDate(a.executedAt)}`);
          // Include key action parameters
          const params = a.actionParameters || {};
          if (params.transferToValue) parts.push(`transferTo: ${params.transferToValue}`);
          if (params.messageBody) parts.push(`message: ${params.messageBody}`);
          if (params.workflowId) parts.push(`workflowId: ${params.workflowId}`);
          if (params.calendarId) parts.push(`calendarId: ${params.calendarId}`);
          if (params.description) parts.push(`desc: ${params.description}`);
          if (params.apiDetails?.url) parts.push(`url: ${params.apiDetails.url}`);
          return parts.join(' | ');
        }).join(' ;; ')
      : '';

    const translation = log.translation?.transcript || '';
    return [
      escapeCsv(log.id || log._id),
      escapeCsv(log.contactId || ''),
      escapeCsv(log.agentId || ''),
      escapeCsv(log.fromNumber || ''),
      escapeCsv(log.callType || ''),
      escapeCsv(log.callStatus || ''),
      escapeCsv(log.duration != null ? log.duration + ' sec' : ''),
      escapeCsv(log.summary || ''),
      escapeCsv(formatDate(log.createdAt)),
      escapeCsv(log.trialCall ? 'Yes' : 'No'),
      escapeCsv(log.workflowId || ''),
      escapeCsv(log.messageId || ''),
      escapeCsv(extractedData),
      escapeCsv(actions),
      escapeCsv(log.transcript || ''),
      escapeCsv(translation)
    ].join(',');
  }).join('\n');

  return header + rows + (rows.length > 0 ? '\n' : '');
}

/**
 * Convert live chat messages to CSV format
 */
/**
 * Opportunity Stage History — fully flattened for analytics ingestion.
 *
 * Each input record is one (opportunity × stage_session) emitted by the billing-route walker.
 * Output shape:
 *   - One CSV row per *message*, with stage metadata (ContactID, OpportunityID, PipelineName,
 *     StageName, EnteredAt, LeftAt, TimeInStageSeconds, CurrentStage, Deleted, GhostOpportunity)
 *     repeated on every row.
 *   - Stages with no messages still emit one CSV row with empty message columns, so stage
 *     history isn't lost when a stage had no conversation activity.
 *   - Each contact custom field becomes a column named `Contact CF: <fieldName>`.
 *   - Each opportunity custom field becomes a column named `Opp CF: <fieldName>`.
 *
 * The custom-field column schema must be known up-front (chunk 0 writes the header before any
 * row in any chunk is seen), so the canonical name lists are persisted on the SpecialExport doc
 * during /estimate and passed in here as `contactCfNames` + `opportunityCfNames`.
 */
// Numeric → human-readable channel mapping. Used by the OSH CSV writer to surface a readable
// value in the MessageChannel column when GHL returns only the numeric `type` (e.g. 20 → CUSTOM_SMS).
// Source: GHL's MessageType enum (kept here to avoid an extra import in the Lambda).
const GHL_MESSAGE_TYPE_NAMES = {
  1: 'CALL', 2: 'SMS', 3: 'EMAIL',
  4: 'SMS_REVIEW_REQUEST', 5: 'WEBCHAT', 6: 'SMS_NO_SHOW_REQUEST',
  7: 'CAMPAIGN_SMS', 8: 'CAMPAIGN_CALL', 9: 'CAMPAIGN_EMAIL',
  10: 'CAMPAIGN_VOICEMAIL', 11: 'FACEBOOK', 12: 'CAMPAIGN_FACEBOOK',
  13: 'CAMPAIGN_MANUAL_CALL', 14: 'CAMPAIGN_MANUAL_SMS', 15: 'GMB',
  16: 'CAMPAIGN_GMB', 17: 'REVIEW', 18: 'INSTAGRAM', 19: 'WHATSAPP',
  20: 'CUSTOM_SMS', 21: 'CUSTOM_EMAIL', 22: 'CUSTOM_PROVIDER_SMS',
  23: 'CUSTOM_PROVIDER_EMAIL', 24: 'IVR_CALL',
  25: 'ACTIVITY_CONTACT', 26: 'ACTIVITY_INVOICE', 27: 'ACTIVITY_PAYMENT',
  28: 'ACTIVITY_OPPORTUNITY', 29: 'LIVE_CHAT', 30: 'LIVE_CHAT_INFO_MESSAGE',
  31: 'ACTIVITY_APPOINTMENT', 32: 'FACEBOOK_COMMENT', 33: 'INSTAGRAM_COMMENT',
  34: 'CUSTOM_CALL', 35: 'GROUP_SMS', 36: 'INTERNAL_CHAT',
  37: 'INTERNAL_COMMENT', 38: 'ACTIVITY_EMPLOYEE_ACTION_LOG',
  40: 'EXTERNAL_HUBSPOT', 41: 'TIKTOK', 42: 'TIKTOK_COMMENT',
  43: 'RCS', 44: 'ACTIVITY_WHATSAPP', 45: 'SMS_REACTION',
  50: 'FORM_SUBMISSION', 60: 'FACEBOOK_MARKETING_MESSAGE', 100: 'NO_SHOW'
};
// Resolve any of {numeric type, string messageType, channel} to a friendly label. Falls back
// to the raw value when we don't recognise it (better to surface "99" than swallow it).
const friendlyMessageChannel = (m) => {
  if (m.channel) return String(m.channel);
  const mt = m.messageType;
  if (typeof mt === 'string' && mt.startsWith('TYPE_')) return mt.replace(/^TYPE_/, '');
  if (typeof mt === 'string' && mt) return mt;
  const t = m.type;
  if (typeof t === 'number' && GHL_MESSAGE_TYPE_NAMES[t]) return GHL_MESSAGE_TYPE_NAMES[t];
  if (t != null) return String(t);
  return '';
};

function opportunityStageHistoryToCSV(rows, includeHeader = true, contactCfNames = [], opportunityCfNames = []) {
  const baseColumns = [
    'ContactID', 'OpportunityID', 'MonetaryValue', 'PipelineName', 'StageName',
    'EnteredAt', 'LeftAt', 'TimeInStageSeconds', 'CurrentStage', 'Deleted', 'GhostOpportunity',
    'MessageTimestamp', 'MessageBody', 'MessageDirection', 'MessageChannel',
    'MessageID', 'ConversationID', 'IsCall'
  ];
  const contactCfColumns = contactCfNames.map(n => `Contact CF: ${n}`);
  const opportunityCfColumns = opportunityCfNames.map(n => `Opp CF: ${n}`);
  const allColumns = [...baseColumns, ...contactCfColumns, ...opportunityCfColumns];

  const header = includeHeader
    ? allColumns.map(c => escapeCsv(c)).join(',') + '\n'
    : '';

  const csvLines = [];
  for (const r of rows) {
    // Stage-level fields, evaluated once per input row.
    // Column order must match `baseColumns` above.
    const stageCells = [
      escapeCsv(r.contactId || ''),
      escapeCsv(r.opportunityId || ''),
      // Snapshot of opp.monetaryValue at export time. Ghost opps (rows synthesized from activity
      // events for deleted opps) don't carry this — left blank.
      escapeCsv(r.monetaryValue != null ? String(r.monetaryValue) : ''),
      escapeCsv(r.pipelineName || ''),
      escapeCsv(r.stageName || ''),
      escapeCsv(r.enteredAt || ''),
      escapeCsv(r.leftAt || ''),
      escapeCsv(r.durationSeconds != null ? String(r.durationSeconds) : ''),
      escapeCsv(r.currentStage ? 'true' : 'false'),
      escapeCsv(r.deleted ? 'true' : 'false'),
      escapeCsv(r.ghostOpportunity ? 'true' : 'false')
    ];

    // Custom-field cells (look up by field name, blank when missing).
    const contactCfs = r.contactCustomFields || {};
    const opportunityCfs = r.opportunityCustomFields || {};
    const contactCfCells = contactCfNames.map(n => escapeCsv(contactCfs[n] != null ? String(contactCfs[n]) : ''));
    const opportunityCfCells = opportunityCfNames.map(n => escapeCsv(opportunityCfs[n] != null ? String(opportunityCfs[n]) : ''));

    const msgs = Array.isArray(r.messages) ? r.messages : [];

    if (msgs.length === 0) {
      // Stage had no messages — still emit one row so the stage history shows up.
      const emptyMessageCells = ['', '', '', '', '', '', ''].map(escapeCsv);
      csvLines.push([...stageCells, ...emptyMessageCells, ...contactCfCells, ...opportunityCfCells].join(','));
      continue;
    }

    // One CSV row per message — stage metadata repeated.
    for (const m of msgs) {
      const messageCells = [
        escapeCsv(m.dateAdded || ''),
        escapeCsv(m.body || ''),
        escapeCsv(m.direction || ''),
        // Prefer the string type when present (TYPE_SMS / TYPE_EMAIL / …); fall back to the
        // numeric type code from /conversations/messages/export (e.g. 20).
        escapeCsv(friendlyMessageChannel(m)),
        escapeCsv(m.messageId || ''),
        escapeCsv(m.conversationId || ''),
        escapeCsv(m.isCall ? 'true' : 'false')
      ];
      csvLines.push([...stageCells, ...messageCells, ...contactCfCells, ...opportunityCfCells].join(','));
    }
  }

  const body = csvLines.join('\n');
  return header + body + (body.length > 0 ? '\n' : '');
}

function specialMessagesToCSV(messages, includeHeader = true) {
  const header = includeHeader
    ? 'Date,ConversationID,ContactID,MessageType,Direction,Status,From,To,Message,Attachments,Source\n'
    : '';

  const rows = messages.map(msg => {
    const direction = msg.direction || 'outbound';
    return [
      escapeCsv(formatDate(msg.dateAdded)),
      escapeCsv(msg.conversationId || ''),
      escapeCsv(msg.contactId || ''),
      escapeCsv(msg.messageType || msg.type || ''),
      escapeCsv(direction),
      escapeCsv(msg.status || ''),
      escapeCsv(msg.meta?.email?.from || msg.from || ''),
      escapeCsv(msg.meta?.email?.to?.join('; ') || msg.to || msg.phone || ''),
      escapeCsv(msg.body || msg.message || ''),
      escapeCsv((msg.attachments || []).map(a => a.url || a).join('; ')),
      escapeCsv(msg.source || '')
    ].join(',');
  }).join('\n');

  return header + rows + (rows.length > 0 ? '\n' : '');
}

/**
 * Stringify an array of records into a comma-joined JSON fragment WITHOUT building an
 * intermediate array of N stringified copies (which `data.map(JSON.stringify).join(',')` does).
 * Appending to one accumulator keeps peak memory to ~one copy instead of two.
 */
function joinStringified(data) {
  let out = '';
  for (let i = 0; i < data.length; i++) {
    out += (i === 0 ? '' : ',') + JSON.stringify(data[i]);
  }
  return out;
}

/**
 * Convert to JSON format
 */
function toJSON(data, exportType, isFirst, isLast) {
  if (isFirst && isLast) {
    // Single batch - return complete JSON
    return JSON.stringify({
      [exportType]: data,
      exportedAt: new Date().toISOString(),
      totalCount: data.length
    }, null, 2);
  } else if (isFirst) {
    // First batch - open JSON array
    return `{"${exportType}":[` + joinStringified(data);
  } else if (isLast) {
    // Last batch - close JSON array
    const items = data.length > 0 ? ',' + joinStringified(data) : '';
    return items + `],"exportedAt":"${new Date().toISOString()}"}`;
  } else {
    // Middle batch - just data with leading comma
    return ',' + joinStringified(data);
  }
}

/**
 * Update job progress in database
 */
async function updateJob(db, jobId, updates) {
  await db.collection('exportjobs').updateOne(
    { _id: new ObjectId(jobId) },
    {
      $set: {
        ...updates,
        lastProcessedAt: new Date()
      }
    }
  );
}

/**
 * Send email notification with download link using Brevo API
 */
async function sendEmail(email, downloadUrl, jobDetails) {
  if (!BREVO_API_KEY) {
    console.log('BREVO_API_KEY not configured, skipping email notification');
    return false;
  }

  try {
    const emailData = {
      sender: {
        name: EMAIL_FROM_NAME,
        email: EMAIL_FROM_ADDRESS
      },
      to: [{ email: email }],
      subject: `Your ${
        jobDetails.exportType === 'conversations' ? 'Conversations' :
        jobDetails.exportType === 'notes' ? 'Notes' :
        jobDetails.exportType === 'tasks' ? 'Tasks' :
        jobDetails.exportType === 'opportunities' ? 'Opportunities' :
        jobDetails.exportType === 'formSubmissions' ? 'Form Submissions' :
        jobDetails.exportType === 'links' ? 'Links' :
        jobDetails.exportType === 'socialPosts' ? 'Social Posts' :
        jobDetails.exportType === 'callLogs' ? 'Call Logs' :
        jobDetails.exportType === 'templates' ? 'Templates' :
        jobDetails.exportType === 'customFields' ? 'Custom Fields' :
        jobDetails.exportType === 'customValues' ? 'Custom Values' :
        jobDetails.exportType === 'tags' ? 'Tags' :
        jobDetails.exportType === 'specialTabMessages' ? 'Special Messages' :
        jobDetails.exportType === 'messagesByTag' ? 'Messages by Tag' :
        jobDetails.exportType === 'groupMessages' ? 'Group Messages' :
        jobDetails.exportType === 'internalMessages' ? 'Internal Messages' :
        jobDetails.exportType === 'callTranscriptions' ? 'Call Transcriptions' :
        jobDetails.exportType === 'callRecordings' ? 'Call Recordings' :
        jobDetails.exportType === 'opportunityStageHistory' ? 'Opportunity Stage History' :
        jobDetails.exportType === 'contactBundleDoc' ? 'Contact Bundle (Google Doc)' :
        jobDetails.exportType === 'contacts' ? 'Contacts' : 'Messages'
      } Export is Ready`,
      htmlContent: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #10B981;">Your Export is Ready!</h2>
          <p>Your ${jobDetails.exportType} export has been completed successfully.</p>

          <div style="background: #F3F4F6; padding: 15px; border-radius: 8px; margin: 20px 0;">
            <p><strong>Export Details:</strong></p>
            <ul style="margin: 10px 0;">
              <li>Type: ${jobDetails.exportType}</li>
              <li>Format: ${jobDetails.format.toUpperCase()}</li>
              <li>Total Items: ${jobDetails.totalItems.toLocaleString()}</li>
            </ul>
          </div>

          <p>
            <a href="${downloadUrl}"
               style="display: inline-block; background: #10B981; color: white; padding: 12px 24px;
                      text-decoration: none; border-radius: 6px; font-weight: bold;">
              Download Export
            </a>
          </p>

          <p style="color: #6B7280; font-size: 14px; margin-top: 20px;">
            This download link will expire in 7 days.
          </p>

          <hr style="border: none; border-top: 1px solid #E5E7EB; margin: 30px 0;">

          <p style="color: #9CA3AF; font-size: 12px;">
            This email was sent by VaultSuite. If you didn't request this export, please ignore this email.
          </p>
        </div>
      `
    };

    const response = await axios.post(BREVO_API_URL, emailData, {
      headers: {
        'accept': 'application/json',
        'api-key': BREVO_API_KEY,
        'content-type': 'application/json'
      }
    });

    console.log('Email sent successfully to:', email, 'MessageId:', response.data?.messageId);
    return true;
  } catch (error) {
    console.error('Failed to send email:', error.response?.data || error.message);
    return false;
  }
}


/**
 * Extract exportJobId from event (handles both normal and durable execution formats)
 */
function extractExportJobId(event) {
  // Direct invocation format
  if (event.exportJobId) {
    return event.exportJobId;
  }

  // Durable execution format - payload is nested
  if (event.InitialExecutionState?.Operations?.[0]?.ExecutionDetails?.InputPayload) {
    try {
      const payload = JSON.parse(event.InitialExecutionState.Operations[0].ExecutionDetails.InputPayload);
      return payload.exportJobId;
    } catch (e) {
      console.error('Failed to parse durable execution payload:', e.message);
    }
  }

  return undefined;
}

/**
 * Main Lambda handler with batch processing
 */
exports.handler = async (event, context) => {
  console.log('Lambda invoked with event:', JSON.stringify(event, null, 2));

  const exportJobId = extractExportJobId(event);

  // Logger with job ID prefix for easy tracing
  const log = (msg, data = null) => {
    const prefix = `[Job:${exportJobId}]`;
    if (data) {
      console.log(prefix, msg, JSON.stringify(data));
    } else {
      console.log(prefix, msg);
    }
  };

  const logError = (msg, data = null) => {
    const prefix = `[Job:${exportJobId}]`;
    if (data) {
      console.error(prefix, msg, JSON.stringify(data));
    } else {
      console.error(prefix, msg);
    }
  };

  log('Lambda started');

  if (!exportJobId) {
    console.error('No exportJobId found in event');
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing exportJobId' }) };
  }

  const db = await getDb();

  // Load job from database
  const job = await db.collection('exportjobs').findOne({
    _id: new ObjectId(exportJobId)
  });

  if (!job) {
    logError('Job not found');
    return { statusCode: 404, body: JSON.stringify({ error: 'Job not found' }) };
  }

  log('Job loaded', { status: job.status, processedItems: job.processedItems, totalItems: job.totalItems, cursor: job.cursor });

  if (job.status === 'completed') {
    log('Job already completed, skipping');
    return { statusCode: 200, body: JSON.stringify({ message: 'Already completed' }) };
  }

  if (job.status === 'failed' && job.retryCount >= job.maxRetries) {
    log('Job failed and max retries exceeded');
    return { statusCode: 400, body: JSON.stringify({ error: 'Max retries exceeded' }) };
  }

  // Fetch OAuth token from oauthtokens collection, SCOPED TO THIS JOB'S APP.
  // Lite ("Export Messages") jobs must use the lite token; premium jobs match lite false OR
  // missing (`$ne: true`) so legacy tokens still match. Prevents a lite job grabbing the premium
  // token (or vice versa) when a location has both apps, and pairs with lite-cred refresh below.
  const isLiteJob = !!job.lite;
  const liteFilter = isLiteJob ? { lite: true } : { lite: { $ne: true } };
  const oauthToken = await db.collection('oauthtokens').findOne({
    locationId: job.locationId,
    tokenType: 'location',
    isActive: true,
    ...liteFilter
  });

  log('OAuth token found for location:', job.locationId);

  if (!oauthToken || !oauthToken.refreshToken) {
    logError('No valid OAuth token found for location:', job.locationId);
    await updateJob(db, exportJobId, {
      status: 'failed',
      errorMessage: 'No valid OAuth token found. Please reconnect your account.'
    });
    return { statusCode: 401, body: JSON.stringify({ error: 'No valid OAuth token found' }) };
  }

  // Token state from OAuthToken collection
  let accessToken = oauthToken.accessToken;
  let refreshToken = oauthToken.refreshToken;

  /**
   * Refresh token and update OAuthToken collection
   * IMPORTANT: Re-reads token from DB to avoid race conditions with concurrent requests
   * Refresh tokens are one-time use - if another process refreshed first, we use their result
   */
  async function refreshAndUpdateToken() {
    log('Refreshing access token...');

    // CRITICAL: Re-read latest token from DB to avoid race condition
    // Another Lambda or API request might have already refreshed it
    const latestToken = await db.collection('oauthtokens').findOne({ _id: oauthToken._id });
    log('Checking latest token from DB for refresh');

    if (!latestToken) {
      throw new Error('OAuth token not found in database');
    }

    if (latestToken.expiresAt > new Date(Date.now() + 23 * 60 * 60 * 1000)) {
      // Token expires in more than 23 hours, meaning it was just refreshed
      log('Token was recently refreshed by another process, using latest');
      accessToken = latestToken.accessToken;
      refreshToken = latestToken.refreshToken;
      return accessToken;
    }

    // Use the latest refresh token from DB, not our local copy
    const currentRefreshToken = latestToken.refreshToken;

    try {
      // Refresh with the job's app credentials (lite vs premium).
      const tokenData = await refreshAccessToken(currentRefreshToken, isLiteJob);
      accessToken = tokenData.accessToken;
      refreshToken = tokenData.refreshToken;

      // Update tokens in OAuthToken collection (single source of truth)
      await db.collection('oauthtokens').updateOne(
        { _id: oauthToken._id },
        {
          $set: {
            accessToken: tokenData.accessToken,
            refreshToken: tokenData.refreshToken,
            expiresAt: new Date(Date.now() + 23 * 60 * 60 * 1000) // 24 hours
          }
        }
      );
      log('Tokens refreshed and saved');
      return accessToken;

    } catch (refreshError) {
      // Handle "invalid_grant" - refresh token was already used by another process
      if (refreshError.response?.data?.error === 'invalid_grant') {
        log('Refresh token already used, fetching latest from DB...');

        // Re-fetch token - another process should have updated it
        const updatedToken = await db.collection('oauthtokens').findOne({ _id: oauthToken._id });

        if (updatedToken && updatedToken.accessToken !== latestToken.accessToken) {
          // Another process did refresh successfully, use their tokens
          accessToken = updatedToken.accessToken;
          refreshToken = updatedToken.refreshToken;
          log('Using token refreshed by another process');
          return accessToken;
        }
      }

      // Re-throw if we can't recover
      throw refreshError;
    }
  }

  try {

    // === CONTACT BUNDLE (GOOGLE DOC): dedicated single-file .docx path ===
    // A .docx is a BINARY zip and cannot be streamed in text chunks like the CSV path. We read
    // ALL record chunks for this job up front, build one complete .docx Buffer in memory, and
    // PutObject it directly (never touching the multipart/append machinery). Then we finalize the
    // job, clean up the chunk docs, and send the completion email — mirroring the CSV finalize.
    if (job.exportType === 'contactBundleDoc') {
      log('Contact Bundle (Google Doc): building .docx from all chunks');

      // Locate the root SpecialExport doc (chunk 0 carries exportJobId; siblings share groupId).
      let rootExport = await db.collection('specialexports').findOne({
        exportJobId: new ObjectId(exportJobId),
        status: 'ready'
      });
      if (!rootExport) {
        rootExport = await db.collection('specialexports').findOne({
          locationId: job.locationId,
          status: 'ready',
          chunkIndex: { $in: [0, null] }
        }, { sort: { createdAt: -1 } });
      }
      if (!rootExport) {
        throw new Error('No pre-fetched records found in specialexports for this contactBundleDoc job');
      }

      // Records live in the `messages` field (same chunk path as contactBundle).
      const groupId = rootExport._id;
      const totalChunks = rootExport.totalChunks || 1;
      const allRecords = [...(rootExport.messages || [])];
      if (totalChunks > 1) {
        const siblings = await db.collection('specialexports')
          .find({ groupId, status: 'ready' })
          .sort({ chunkIndex: 1 })
          .toArray();
        for (const s of siblings) {
          if (String(s._id) === String(groupId)) continue; // skip root (already included)
          allRecords.push(...(s.messages || []));
        }
      }

      log('Contact Bundle (Google Doc): records assembled', { totalChunks, recordCount: allRecords.length });

      // Output is a PDF (rendered from a GHL-style HTML template via headless Chrome) regardless of
      // the requested format.
      const docS3Key = `exports/${job.companyId}/${job.locationId}/${exportJobId}.pdf`;
      const docFilename = `${job.exportType}_export.pdf`;
      const PDF_CONTENT_TYPE = 'application/pdf';

      const docBuffer = await buildContactBundlePdf(allRecords);

      await s3.send(new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: docS3Key,
        Body: docBuffer,
        ContentType: PDF_CONTENT_TYPE,
        ContentDisposition: `attachment; filename="${docFilename}"`
      }));
      log('Contact Bundle (Google Doc): .pdf uploaded via putObject', { size: docBuffer.length });

      const downloadUrl = await getSignedUrl(s3, new GetObjectCommand({
        Bucket: S3_BUCKET,
        Key: docS3Key
      }), { expiresIn: 7 * 24 * 60 * 60 });
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      const downloadToken = job.downloadToken || crypto.randomBytes(24).toString('hex');

      const processedItems = allRecords.length;
      await updateJob(db, exportJobId, {
        status: 'completed',
        s3Key: docS3Key,
        s3Bucket: S3_BUCKET,
        downloadUrl,
        downloadUrlExpiresAt: expiresAt,
        downloadToken,
        processedItems,
        completedAt: new Date(),
        totalBatches: 1
      });

      // Clean up chunk docs (TTL index is the safety net if this delete fails).
      try {
        const { deletedCount } = await db.collection('specialexports').deleteMany({
          $or: [{ _id: groupId }, { groupId }]
        });
        log('Contact Bundle (Google Doc): SpecialExport cleanup', { deletedCount });
      } catch (cleanupErr) {
        log('Contact Bundle (Google Doc): cleanup failed (TTL will handle it)', { error: cleanupErr.message });
      }

      let emailSent = false;
      if (job.notificationEmail) {
        const emailDownloadUrl = `${PUBLIC_API_URL}/api/billing/download-email/${exportJobId}?token=${downloadToken}`;
        emailSent = await sendEmail(job.notificationEmail, emailDownloadUrl, {
          exportType: job.exportType,
          format: 'docx',
          totalItems: processedItems
        });
        await updateJob(db, exportJobId, { emailSent });
      }

      log('Contact Bundle (Google Doc): export completed', { processedItems, emailSent });
      return {
        statusCode: 200,
        body: JSON.stringify({
          success: true,
          message: 'Export completed',
          processedItems,
          totalBatches: 1,
          downloadUrl,
          emailSent
        })
      };
    }

    // Initialize or get S3 multipart upload
    let uploadId = job.s3Upload?.uploadId;
    let parts = job.s3Upload?.parts || [];
    const s3Key = job.s3Upload?.key || `exports/${job.companyId}/${job.locationId}/${exportJobId}.${job.format}`;

    // Generate filename based on export type and channel filter
    const channelFilter = job.filters?.channel || '';
    const channelPrefix = channelFilter ? `${channelFilter.toLowerCase()}_` : '';
    const exportFilename = `${channelPrefix}${job.exportType}_export.${job.format}`;

    if (!uploadId) {
      // Start new multipart upload
      log('Starting S3 multipart upload...');
      const multipart = await s3.send(new CreateMultipartUploadCommand({
        Bucket: S3_BUCKET,
        Key: s3Key,
        ContentType: job.format === 'json' ? 'application/json' : 'text/csv',
        ContentDisposition: `attachment; filename="${exportFilename}"`
      }));

      uploadId = multipart.UploadId;
      log('Multipart upload started', { uploadId });

      // Save to DB
      await updateJob(db, exportJobId, {
        's3Upload.uploadId': uploadId,
        's3Upload.bucket': S3_BUCKET,
        's3Upload.key': s3Key,
        's3Upload.parts': [],
        status: 'processing',
        startedAt: job.startedAt || new Date()
      });
    }

    // Fetch batch of records
    let cursor = job.cursor;
    let skip = job.exportType === 'conversations' ? (job.processedItems || 0) : 0;
    let records = [];
    let recordsFetched = 0;
    let hasMoreData = true;
    // Custom-field column schema for opportunityStageHistory. Populated inside the SpecialExport
    // branch (from rootExport.contactCustomFieldNames / opportunityCustomFieldNames) and consumed
    // when we call opportunityStageHistoryToCSV. Empty for other export types.
    let oshContactCfNames = [];
    let oshOpportunityCfNames = [];

    log('Starting batch', { cursor, skip, alreadyProcessed: job.processedItems || 0 });

    if (job.exportType === 'notes') {
      if (job.filters?.contactId) {
        // === NOTES: Single contact ===
        let items;
        try {
          items = await fetchNotesForContact(job.filters.contactId, accessToken);
        } catch (fetchError) {
          if (fetchError.response?.status === 401) {
            await refreshAndUpdateToken();
            items = await fetchNotesForContact(job.filters.contactId, accessToken);
          } else { throw fetchError; }
        }
        const singleName = (job.filters.contactNames || {})[job.filters.contactId] || '';
        const singleMeta = (job.filters.contactsMeta || {})[job.filters.contactId] || {};
        items.forEach(item => {
          item.contactId = job.filters.contactId;
          item.contactName = singleName;
          item.contactEmail = singleMeta.email || '';
          item.contactPhone = singleMeta.phone || '';
        });
        records.push(...items);
        hasMoreData = false;
        cursor = null;
      } else if (job.filters?.contactIds?.length > 0) {
        // === NOTES: Multiple contacts — process 50 per Lambda invocation ===
        const CONTACTS_PER_BATCH = 50;
        const allContactIds = job.filters.contactIds;
        const startIndex = cursor ? parseInt(cursor) : 0;
        const endIndex = Math.min(startIndex + CONTACTS_PER_BATCH, allContactIds.length);
        const batchContactIds = allContactIds.slice(startIndex, endIndex);

        log('Notes multi-contact batch starting', { totalContactIds: allContactIds.length, startIndex, endIndex, batchSize: batchContactIds.length });

        let processedCount = 0;
        let skippedCount = 0;
        for (const cId of batchContactIds) {
          if (context.getRemainingTimeInMillis() < TIMEOUT_BUFFER_MS) { hasMoreData = true; break; }
          let items;
          try {
            items = await fetchNotesForContact(cId, accessToken);
          } catch (fetchError) {
            if (fetchError.response?.status === 401) {
              await refreshAndUpdateToken();
              try {
                items = await fetchNotesForContact(cId, accessToken);
              } catch (retryError) {
                log('Failed to fetch notes after token refresh, skipping contact', { contactId: cId, error: retryError.message });
                skippedCount++;
                continue;
              }
            } else if (fetchError.response?.status === 429) {
              // Rate limited — wait and retry up to 3 times
              let retryItems = null;
              for (let r = 0; r < 3; r++) {
                await sleep(2000 * (r + 1));
                try {
                  retryItems = await fetchNotesForContact(cId, accessToken);
                  break;
                } catch (retryErr) {
                  if (r === 2) log('Rate limit retry exhausted, skipping contact', { contactId: cId });
                }
              }
              if (!retryItems) { skippedCount++; continue; }
              items = retryItems;
            } else {
              log('Failed to fetch notes, skipping contact', { contactId: cId, status: fetchError.response?.status, error: fetchError.message });
              skippedCount++;
              continue;
            }
          }
          const cName = (job.filters.contactNames || {})[cId] || '';
          const cMeta = (job.filters.contactsMeta || {})[cId] || {};
          items.forEach(item => {
            item.contactId = cId;
            item.contactName = cName;
            item.contactEmail = cMeta.email || '';
            item.contactPhone = cMeta.phone || '';
          });
          records.push(...items);
          processedCount++;
          await sleep(150);
        }

        // Check if more contacts remain
        if (endIndex < allContactIds.length) {
          hasMoreData = true;
          cursor = String(endIndex);
        } else {
          hasMoreData = false;
          cursor = null;
        }
        log('Notes multi-contact batch done', { totalContactIds: allContactIds.length, startIndex, endIndex, processed: processedCount, skipped: skippedCount, notesFound: records.length, hasMore: hasMoreData });
      } else {
        // No contactId or contactIds — should not happen (backend resolves tags to contactIds)
        log('Notes export with no contacts — skipping');
        hasMoreData = false;
        cursor = null;
      }

    } else if (job.exportType === 'tasks') {
      // === TASKS: Location-level skip-based API (limit 1000 per page) ===
      let skip = cursor ? parseInt(cursor) : 0;

      while (recordsFetched < BATCH_SIZE && hasMoreData) {
        if (context.getRemainingTimeInMillis() < TIMEOUT_BUFFER_MS) { break; }

        let pageResult;
        try {
          pageResult = await fetchTasksPage(job.locationId, accessToken, skip, job.filters || {});
        } catch (fetchError) {
          if (fetchError.response?.status === 401) {
            await refreshAndUpdateToken();
            pageResult = await fetchTasksPage(job.locationId, accessToken, skip, job.filters || {});
          } else { throw fetchError; }
        }

        // Enrich tasks with contactName from contactNames map if available
        const contactNamesMap = job.filters?.contactNames || {};
        pageResult.data.forEach(task => {
          if (!task.contactName && task.contactId) {
            task.contactName = contactNamesMap[task.contactId] || '';
          }
        });

        records.push(...pageResult.data);
        recordsFetched += pageResult.data.length;
        skip += pageResult.data.length;

        log('Fetched tasks batch', { pageRecords: pageResult.data.length, batchTotal: recordsFetched, skip, hasMore: pageResult.hasMore });

        if (!pageResult.hasMore) { hasMoreData = false; }
        if (hasMoreData && recordsFetched < BATCH_SIZE) { await sleep(100); }
      }

      cursor = hasMoreData ? String(skip) : null;

    } else if (job.exportType === 'opportunities') {
      // === OPPORTUNITIES: Page-based pagination ===
      let page = cursor ? parseInt(cursor) : 1;

      while (recordsFetched < BATCH_SIZE && hasMoreData) {
        const remaining = context.getRemainingTimeInMillis();
        if (remaining < TIMEOUT_BUFFER_MS) {
          log('Approaching timeout, saving progress', { remainingMs: remaining });
          break;
        }

        let pageResult;
        try {
          pageResult = await fetchOpportunitiesPage(job.locationId, accessToken, page, job.filters || {});
        } catch (fetchError) {
          if (fetchError.response?.status === 401) {
            log('Got 401, refreshing token and retrying...');
            await refreshAndUpdateToken();
            pageResult = await fetchOpportunitiesPage(job.locationId, accessToken, page, job.filters || {});
          } else {
            throw fetchError;
          }
        }

        records.push(...pageResult.data);
        recordsFetched += pageResult.data.length;
        page++;

        log('Fetched opportunities page', { pageRecords: pageResult.data.length, batchTotal: recordsFetched, page, hasMore: pageResult.hasMore });

        if (pageResult.data.length < API_PAGE_SIZE) {
          hasMoreData = false;
        }

        if (hasMoreData && recordsFetched < BATCH_SIZE) {
          await sleep(100);
        }
      }

      // Store current page as cursor for next Lambda invocation
      cursor = hasMoreData ? String(page) : null;

    } else if (job.exportType === 'formSubmissions') {
      // === FORM SUBMISSIONS: Page-based pagination ===
      let page = cursor ? parseInt(cursor) : 1;

      while (recordsFetched < BATCH_SIZE && hasMoreData) {
        const remaining = context.getRemainingTimeInMillis();
        if (remaining < TIMEOUT_BUFFER_MS) {
          log('Approaching timeout, saving progress', { remainingMs: remaining });
          break;
        }

        let pageResult;
        try {
          pageResult = await fetchFormSubmissionsPage(job.locationId, accessToken, page, job.filters || {});
        } catch (fetchError) {
          if (fetchError.response?.status === 401) {
            log('Got 401, refreshing token and retrying...');
            await refreshAndUpdateToken();
            pageResult = await fetchFormSubmissionsPage(job.locationId, accessToken, page, job.filters || {});
          } else {
            throw fetchError;
          }
        }

        records.push(...pageResult.data);
        recordsFetched += pageResult.data.length;
        page++;

        log('Fetched form submissions page', { pageRecords: pageResult.data.length, batchTotal: recordsFetched, page });

        if (pageResult.data.length < API_PAGE_SIZE) {
          hasMoreData = false;
        }

        if (hasMoreData && recordsFetched < BATCH_SIZE) {
          await sleep(100);
        }
      }

      cursor = hasMoreData ? String(page) : null;

    } else if (job.exportType === 'links') {
      // === LINKS: Page-based pagination via /links/search (limit 1000) ===
      let currentSkip = cursor ? parseInt(cursor) : 0;
      let hasMoreData_inner = true;

      while (hasMoreData_inner && records.length < BATCH_SIZE) {
        if (context.getRemainingTimeInMillis() < TIMEOUT_BUFFER_MS) {
          hasMoreData = true;
          break;
        }

        let pageResult;
        try {
          pageResult = await fetchLinksPage(job.locationId, accessToken, currentSkip, job.filters || {});
        } catch (fetchError) {
          if (fetchError.response?.status === 401) {
            log('Got 401, refreshing token and retrying...');
            await refreshAndUpdateToken();
            pageResult = await fetchLinksPage(job.locationId, accessToken, currentSkip, job.filters || {});
          } else {
            throw fetchError;
          }
        }

        records.push(...pageResult.data);
        recordsFetched += pageResult.data.length;
        currentSkip += pageResult.data.length;

        if (!pageResult.hasMore) {
          hasMoreData_inner = false;
          hasMoreData = false;
        } else if (records.length >= BATCH_SIZE) {
          hasMoreData = true;
        }

        if (hasMoreData_inner && records.length < BATCH_SIZE) {
          await sleep(100);
        }
      }

      cursor = hasMoreData ? String(currentSkip) : null;

      log('Fetched links batch', { fetched: records.length, skip: currentSkip });

    } else if (job.exportType === 'socialPosts') {
      // === SOCIAL POSTS: Skip-based pagination ===
      let currentSkip = cursor ? parseInt(cursor) : 0;

      while (recordsFetched < BATCH_SIZE && hasMoreData) {
        const remaining = context.getRemainingTimeInMillis();
        if (remaining < TIMEOUT_BUFFER_MS) {
          log('Approaching timeout, saving progress', { remainingMs: remaining });
          break;
        }

        let pageResult;
        try {
          pageResult = await fetchSocialPostsPage(job.locationId, accessToken, currentSkip, job.filters || {});
        } catch (fetchError) {
          if (fetchError.response?.status === 401) {
            log('Got 401, refreshing token and retrying...');
            await refreshAndUpdateToken();
            pageResult = await fetchSocialPostsPage(job.locationId, accessToken, currentSkip, job.filters || {});
          } else {
            throw fetchError;
          }
        }

        records.push(...pageResult.data);
        recordsFetched += pageResult.data.length;
        currentSkip += pageResult.data.length;

        log('Fetched social posts page', { pageRecords: pageResult.data.length, batchTotal: recordsFetched, skip: currentSkip });

        if (pageResult.data.length < API_PAGE_SIZE) {
          hasMoreData = false;
        }

        if (hasMoreData && recordsFetched < BATCH_SIZE) {
          await sleep(100);
        }
      }

      cursor = hasMoreData ? String(currentSkip) : null;

    } else if (job.exportType === 'callLogs') {
      // === CALL LOGS: Page-based pagination ===
      let page = cursor ? parseInt(cursor) : 1;

      while (recordsFetched < BATCH_SIZE && hasMoreData) {
        const remaining = context.getRemainingTimeInMillis();
        if (remaining < TIMEOUT_BUFFER_MS) {
          log('Approaching timeout, saving progress', { remainingMs: remaining });
          break;
        }

        let pageResult;
        try {
          pageResult = await fetchCallLogsPage(job.locationId, accessToken, page, job.filters || {});
        } catch (fetchError) {
          if (fetchError.response?.status === 401) {
            log('Got 401, refreshing token and retrying...');
            await refreshAndUpdateToken();
            pageResult = await fetchCallLogsPage(job.locationId, accessToken, page, job.filters || {});
          } else {
            throw fetchError;
          }
        }

        records.push(...pageResult.data);
        recordsFetched += pageResult.data.length;
        page++;

        log('Fetched call logs page', { pageRecords: pageResult.data.length, batchTotal: recordsFetched, page });

        if (pageResult.data.length < API_CALL_LOGS_PAGE_SIZE) {
          hasMoreData = false;
        }

        if (hasMoreData && recordsFetched < BATCH_SIZE) {
          await sleep(100);
        }
      }

      cursor = hasMoreData ? String(page) : null;

    } else if (job.exportType === 'customFields') {
      // === CUSTOM FIELDS: single-shot list, no pagination ===
      let pageResult;
      try {
        pageResult = await fetchCustomFieldsAll(job.locationId, accessToken, job.filters || {});
      } catch (fetchError) {
        if (fetchError.response?.status === 401) {
          log('Got 401 on custom fields fetch, refreshing token and retrying');
          await refreshAndUpdateToken();
          pageResult = await fetchCustomFieldsAll(job.locationId, accessToken, job.filters || {});
        } else {
          throw fetchError;
        }
      }
      records.push(...pageResult.data);
      recordsFetched += pageResult.data.length;
      hasMoreData = false;
      cursor = null;

    } else if (job.exportType === 'customValues') {
      // === CUSTOM VALUES: single-shot list, no pagination ===
      let pageResult;
      try {
        pageResult = await fetchCustomValuesAll(job.locationId, accessToken, job.filters || {});
      } catch (fetchError) {
        if (fetchError.response?.status === 401) {
          log('Got 401 on custom values fetch, refreshing token and retrying');
          await refreshAndUpdateToken();
          pageResult = await fetchCustomValuesAll(job.locationId, accessToken, job.filters || {});
        } else {
          throw fetchError;
        }
      }
      records.push(...pageResult.data);
      recordsFetched += pageResult.data.length;
      hasMoreData = false;
      cursor = null;

    } else if (job.exportType === 'tags') {
      // === TAGS: single-shot list, no pagination, no filters ===
      let pageResult;
      try {
        pageResult = await fetchTagsAll(job.locationId, accessToken);
      } catch (fetchError) {
        if (fetchError.response?.status === 401) {
          log('Got 401 on tags fetch, refreshing token and retrying');
          await refreshAndUpdateToken();
          pageResult = await fetchTagsAll(job.locationId, accessToken);
        } else {
          throw fetchError;
        }
      }
      records.push(...pageResult.data);
      recordsFetched += pageResult.data.length;
      hasMoreData = false;
      cursor = null;

    } else if (job.exportType === 'templates') {
      // === TEMPLATES: Skip-based pagination (limit 100) ===
      let currentSkip = cursor ? parseInt(cursor) : 0;
      let hasMoreData_inner = true;

      while (hasMoreData_inner && records.length < BATCH_SIZE) {
        if (context.getRemainingTimeInMillis() < TIMEOUT_BUFFER_MS) {
          hasMoreData = true;
          break;
        }

        let pageResult;
        try {
          pageResult = await fetchTemplatesPage(job.locationId, accessToken, currentSkip, job.filters || {});
        } catch (fetchError) {
          if (fetchError.response?.status === 401) {
            log('Got 401, refreshing token and retrying...');
            await refreshAndUpdateToken();
            pageResult = await fetchTemplatesPage(job.locationId, accessToken, currentSkip, job.filters || {});
          } else {
            throw fetchError;
          }
        }

        records.push(...pageResult.data);
        recordsFetched += pageResult.data.length;
        currentSkip += pageResult.data.length;

        log('Fetched templates page', { pageRecords: pageResult.data.length, batchTotal: recordsFetched, skip: currentSkip });

        if (!pageResult.hasMore) {
          hasMoreData_inner = false;
          hasMoreData = false;
        } else if (records.length >= BATCH_SIZE) {
          hasMoreData = true;
        }

        if (hasMoreData_inner && records.length < BATCH_SIZE) {
          await sleep(100);
        }
      }

      cursor = hasMoreData ? String(currentSkip) : null;

    } else if (job.exportType === 'contacts') {
      // === CONTACTS: cursor pagination via searchAfter array (ES sort tuple) ===
      // The cursor is persisted as a JSON string between Lambda invocations.
      let contactsCursor = null;
      if (cursor) {
        try { contactsCursor = JSON.parse(cursor); } catch { contactsCursor = null; }
      }

      while (recordsFetched < BATCH_SIZE && hasMoreData) {
        if (context.getRemainingTimeInMillis() < TIMEOUT_BUFFER_MS) {
          log('Approaching timeout, saving progress', { remainingMs: context.getRemainingTimeInMillis() });
          break;
        }

        let pageResult;
        try {
          pageResult = await fetchContactsPage(job.locationId, accessToken, job.filters || {}, contactsCursor);
        } catch (fetchError) {
          if (fetchError.response?.status === 401) {
            log('Got 401 on contacts fetch, refreshing token and retrying');
            await refreshAndUpdateToken();
            pageResult = await fetchContactsPage(job.locationId, accessToken, job.filters || {}, contactsCursor);
          } else {
            throw fetchError;
          }
        }

        const page = pageResult.data || [];
        records.push(...page);
        recordsFetched = records.length;

        if (pageResult.nextCursor) {
          contactsCursor = pageResult.nextCursor;
        } else {
          hasMoreData = false;
          contactsCursor = null;
          break;
        }
      }

      cursor = contactsCursor ? JSON.stringify(contactsCursor) : null;
      hasMoreData = !!cursor;

    } else if (job.exportType === 'specialTabMessages' || job.exportType === 'messagesByTag' || job.exportType === 'groupMessages' || job.exportType === 'internalMessages' || job.exportType === 'callTranscriptions' || job.exportType === 'callRecordings' || job.exportType === 'opportunityStageHistory' || job.exportType === 'contactBundle' || job.exportType === 'contactBundleDoc') {
      // === SPECIAL MESSAGES / CALL TRANSCRIPTIONS: Read pre-fetched records from chunked specialexports ===
      // Chunk 0 is the "root" doc (has exportJobId). Remaining chunks share groupId = root._id.
      // Each chunk holds up to CHUNK_SIZE (5000) messages, matching BATCH_SIZE so one invocation = one chunk.
      const CHUNK_SIZE = 5000;
      const startIdx = job.processedItems || 0;
      const chunkIndex = Math.floor(startIdx / CHUNK_SIZE);

      // Find root doc (chunk 0) via exportJobId or fallback
      let rootExport = await db.collection('specialexports').findOne({
        exportJobId: new ObjectId(exportJobId),
        status: 'ready'
      });
      if (!rootExport) {
        rootExport = await db.collection('specialexports').findOne({
          locationId: job.locationId,
          status: 'ready',
          chunkIndex: { $in: [0, null] }
        }, { sort: { createdAt: -1 } });
      }

      if (!rootExport) {
        throw new Error('No pre-fetched messages found in specialexports for this job');
      }

      // For callTranscriptions, the records live under `callTranscriptionsMessages`;
      // specialTabMessages still uses `messages`.
      const recordsField = job.exportType === 'callTranscriptions' ? 'callTranscriptionsMessages'
        : job.exportType === 'callRecordings' ? 'callRecordingsMessages'
        : 'messages';
      const rootRecords = rootExport[recordsField] || [];
      const totalMessages = rootExport.totalMessages || rootRecords.length;
      const groupId = rootExport._id; // chunk 0 _id is the groupId for all other chunks

      // For opportunityStageHistory the CSV columns include one column per contact / opportunity
      // custom field — pick those up from the root SpecialExport doc so chunk 0 emits the right
      // header and every chunk lays out cells in the same column order.
      if (job.exportType === 'opportunityStageHistory') {
        oshContactCfNames = Array.isArray(rootExport.contactCustomFieldNames) ? rootExport.contactCustomFieldNames : [];
        oshOpportunityCfNames = Array.isArray(rootExport.opportunityCustomFieldNames) ? rootExport.opportunityCustomFieldNames : [];
      }

      // Load the correct chunk
      let chunkDoc;
      if (chunkIndex === 0) {
        chunkDoc = rootExport;
      } else {
        chunkDoc = await db.collection('specialexports').findOne({
          groupId,
          chunkIndex,
          status: 'ready'
        });
        if (!chunkDoc) {
          throw new Error(`Chunk ${chunkIndex} not found for specialExport group ${groupId}`);
        }
      }

      const chunkRecords = chunkDoc[recordsField] || [];
      const localOffset = startIdx % CHUNK_SIZE;
      records = chunkRecords.slice(localOffset);
      recordsFetched = records.length;
      const nextIdx = startIdx + recordsFetched;
      hasMoreData = nextIdx < totalMessages;
      cursor = hasMoreData ? String(nextIdx) : null;

      log('SpecialExport batch read', {
        exportType: job.exportType, recordsField,
        startIdx, chunkIndex, localOffset, batchSize: records.length,
        totalMessages, hasMoreData
      });

    } else {
      // === CONVERSATIONS/MESSAGES: Standard pagination ===
      while (recordsFetched < BATCH_SIZE && hasMoreData) {
        // Check if approaching timeout
        const remaining = context.getRemainingTimeInMillis();
        if (remaining < TIMEOUT_BUFFER_MS) {
          log('Approaching timeout, saving progress', { remainingMs: remaining });
          break;
        }

        // Check if we've already fetched all items (avoid extra API call when count matches exactly)
        if (job.totalItems > 0) {
          const totalProcessed = (job.processedItems || 0) + recordsFetched;
          if (totalProcessed >= job.totalItems) {
            log('Reached totalItems count, stopping fetch', { totalProcessed, totalItems: job.totalItems });
            hasMoreData = false;
            cursor = null;
            break;
          }
        }

        // Fetch page based on export type, with 401 retry
        let pageResult;
        try {
          if (job.exportType === 'conversations') {
            pageResult = await fetchConversationsPage(job.locationId, accessToken, job.filters || {}, skip);
          } else {
            pageResult = await fetchMessagesPage(job.locationId, accessToken, job.filters || {}, cursor);
          }
        } catch (fetchError) {
          if (fetchError.response?.status === 401) {
            log('Got 401, refreshing token and retrying...');
            await refreshAndUpdateToken();

            if (job.exportType === 'conversations') {
              pageResult = await fetchConversationsPage(job.locationId, accessToken, job.filters || {}, skip);
            } else {
              pageResult = await fetchMessagesPage(job.locationId, accessToken, job.filters || {}, cursor);
            }
          } else if (fetchError.response?.status === 400 && cursor) {
            // 400 likely means expired/invalid cursor — retry without cursor
            log('Got 400 with cursor, retrying without cursor (fresh start)', { cursor });
            cursor = null;
            if (job.exportType === 'conversations') {
              pageResult = await fetchConversationsPage(job.locationId, accessToken, job.filters || {}, 0);
            } else {
              pageResult = await fetchMessagesPage(job.locationId, accessToken, job.filters || {}, null);
            }
          } else {
            throw fetchError;
          }
        }

        if (job.exportType === 'conversations') {
          hasMoreData = pageResult.hasMore;
          skip += pageResult.data.length;
          if (pageResult.data.length < API_PAGE_SIZE) {
            hasMoreData = false;
          }

        } else {
          // Messages: the cursor is the ONLY source of truth for "more data".
          // GHL's message export runs on Elasticsearch shards; when a shard times out it can
          // return a SHORT page (< API_MESSAGES_PAGE_SIZE) while STILL handing back a valid
          // nextCursor. Treating a short page as "done" (the old behavior) silently dropped the
          // remaining messages. So we keep paginating until GHL stops giving us a cursor.
          const sentCursor = cursor;            // the cursor we just sent (before overwrite)
          cursor = pageResult.nextCursor;
          hasMoreData = !!cursor;

          // An empty page is suspicious — zero data is usually a transient shard failure, not the
          // real end. Confirm with ONE retry before stopping. Two cases:
          //   (a) empty + GHL returned a nextCursor → retry that nextCursor.
          //   (b) empty + NO nextCursor            → retry the SAME cursor we just sent (sentCursor),
          //       since GHL gave us nothing to advance with but the blip may clear.
          // If the retry returns data we continue from its nextCursor; if it's empty again we
          // accept the end (stops infinite loops).
          if (pageResult.data.length === 0) {
            const retryCursor = cursor || sentCursor;
            if (retryCursor) {
              log('Empty page — retrying once to confirm end', { retryCursor, usedNextCursor: !!cursor });
              await sleep(500);
              let retry;
              try {
                retry = await fetchMessagesPage(job.locationId, accessToken, job.filters || {}, retryCursor);
              } catch (retryErr) {
                if (retryErr.response?.status === 401) {
                  await refreshAndUpdateToken();
                  retry = await fetchMessagesPage(job.locationId, accessToken, job.filters || {}, retryCursor);
                } else {
                  throw retryErr;
                }
              }

              if (retry.data.length > 0) {
                // Transient blip — absorb the retry's data and continue.
                records.push(...retry.data);
                recordsFetched += retry.data.length;
                cursor = retry.nextCursor;
                hasMoreData = !!cursor;
                log('Retry recovered data', { recovered: retry.data.length, cursor, hasMoreData });
              } else {
                // Two empty pages in a row — accept this as the true end.
                log('Retry also empty — stopping pagination', {});
                hasMoreData = false;
                cursor = null;
              }
            } else {
              // No cursor at all to retry with — genuinely done.
              hasMoreData = false;
              cursor = null;
            }
          }
        }

        records.push(...pageResult.data);
        recordsFetched += pageResult.data.length;

        log('Fetched page', { pageRecords: pageResult.data.length, batchTotal: recordsFetched, cursor, hasMoreData });

        // Rate limiting (GHL: 100 req/10 sec)
        if (hasMoreData && recordsFetched < BATCH_SIZE) {
          await sleep(100);
        }
      }
    }

    log('Batch complete', { processedItems: job.processedItems,  batchRecords: records.length, cursor: cursor, hasMore: hasMoreData || !!cursor });

    // Convert to format and upload
    const hasPendingBuffer = !!(job.s3Upload?.pendingBuffer);
    const isFirstContent = parts.length === 0 && !hasPendingBuffer;
    const isLastPart = !hasMoreData && !cursor;
    let useSimpleUpload = false;  // Flag to skip multipart finalization

    if (records.length > 0 || (isFirstContent && isLastPart && records.length === 0)) {
      // Handle empty export case
      if (records.length === 0) {
        log('Empty export, creating empty file');
      }
      let content;
      if (job.format === 'json') {
        content = toJSON(records, job.exportType, isFirstContent, isLastPart);
      } else if (job.exportType === 'conversations') {
        content = conversationsToCSV(records, isFirstContent);
      } else if (job.exportType === 'notes') {
        content = notesToCSV(records, isFirstContent);
      } else if (job.exportType === 'tasks') {
        content = tasksToCSV(records, isFirstContent);
      } else if (job.exportType === 'opportunities') {
        content = opportunitiesToCSV(records, isFirstContent);
      } else if (job.exportType === 'formSubmissions') {
        content = formSubmissionsToCSV(records, isFirstContent);
      } else if (job.exportType === 'links') {
        content = linksToCSV(records, isFirstContent);
      } else if (job.exportType === 'socialPosts') {
        content = socialPostsToCSV(records, isFirstContent);
      } else if (job.exportType === 'callLogs') {
        content = callLogsToCSV(records, isFirstContent);
      } else if (job.exportType === 'templates') {
        content = templatesToCSV(records, isFirstContent);
      } else if (job.exportType === 'customFields') {
        content = customFieldsToCSV(records, isFirstContent);
      } else if (job.exportType === 'customValues') {
        content = customValuesToCSV(records, isFirstContent);
      } else if (job.exportType === 'tags') {
        content = tagsToCSV(records, isFirstContent);
      } else if (job.exportType === 'specialTabMessages' || job.exportType === 'messagesByTag' || job.exportType === 'groupMessages' || job.exportType === 'internalMessages') {
        content = specialMessagesToCSV(records, isFirstContent);
      } else if (job.exportType === 'opportunityStageHistory') {
        content = opportunityStageHistoryToCSV(records, isFirstContent, oshContactCfNames, oshOpportunityCfNames);
      } else if (job.exportType === 'callTranscriptions') {
        content = callTranscriptionsToCSV(records, isFirstContent);
      } else if (job.exportType === 'callRecordings') {
        content = callRecordingsToCSV(records, isFirstContent);
      } else if (job.exportType === 'contactBundle') {
        content = contactBundleToCSV(records, isFirstContent);
      } else if (job.exportType === 'contacts') {
        content = contactsToCSV(records, isFirstContent);
      } else {
        content = messagesToCSV(records, isFirstContent, job.filters?.channel || '');
      }

      const contentSize = Buffer.byteLength(content);

      // If truly a single-batch export (no buffer, no parts), use putObject directly
      // This avoids S3 multipart upload issues with small files (< 5MB)
      if (isFirstContent && isLastPart && !hasPendingBuffer) {
        log('Single batch export, using putObject directly', { contentSize });

        // Abort the multipart upload we started (if any)
        if (uploadId) {
          try {
            await s3.send(new AbortMultipartUploadCommand({
              Bucket: S3_BUCKET,
              Key: s3Key,
              UploadId: uploadId
            }));
            log('Aborted unused multipart upload');
          } catch (abortErr) {
            // Ignore abort errors
            log('Could not abort multipart upload (may not exist yet)', { error: abortErr.message });
          }
        }

        // Upload directly with putObject
        await s3.send(new PutObjectCommand({
          Bucket: S3_BUCKET,
          Key: s3Key,
          Body: content,
          ContentType: job.format === 'json' ? 'application/json' : 'text/csv',
          ContentDisposition: `attachment; filename="${exportFilename}"`
        }));

        log('File uploaded with putObject');
        useSimpleUpload = true;

      } else {
        // Multi-batch: use multipart upload
        // S3 requires each part (except last) to be >= 5MB
        const MIN_PART_SIZE = 5 * 1024 * 1024; // 5MB

        // Accumulate content with any pending buffer from previous batches
        const pendingBuffer = job.s3Upload?.pendingBuffer || '';
        const accumulated = pendingBuffer + content;
        const accumulatedSize = Buffer.byteLength(accumulated);

        if (!isLastPart && accumulatedSize < MIN_PART_SIZE) {
          // Not enough data yet and more batches coming - buffer it
          log('Buffering content for next batch', { accumulatedSize, minRequired: MIN_PART_SIZE });
          await updateJob(db, exportJobId, {
            's3Upload.pendingBuffer': accumulated
          });
        } else if (isLastPart && parts.length === 0) {
          // All data fits in buffer + this batch, and no parts uploaded yet
          // Use putObject instead of multipart (total data < 5MB)
          log('Total export under 5MB, using putObject', { accumulatedSize });

          // Abort the multipart upload
          if (uploadId) {
            try {
              await s3.send(new AbortMultipartUploadCommand({
                Bucket: S3_BUCKET,
                Key: s3Key,
                UploadId: uploadId
              }));
            } catch (abortErr) {
              log('Could not abort multipart upload', { error: abortErr.message });
            }
          }

          await s3.send(new PutObjectCommand({
            Bucket: S3_BUCKET,
            Key: s3Key,
            Body: accumulated,
            ContentType: job.format === 'json' ? 'application/json' : 'text/csv',
            ContentDisposition: `attachment; filename="${exportFilename}"`
          }));

          log('File uploaded with putObject (buffered)');
          useSimpleUpload = true;

          // Clear the pending buffer
          await updateJob(db, exportJobId, {
            's3Upload.pendingBuffer': ''
          });
        } else {
          // Enough data or last part with existing parts - upload as multipart part
          const partNumber = parts.length + 1;

          const uploadResult = await s3.send(new UploadPartCommand({
            Bucket: S3_BUCKET,
            Key: s3Key,
            UploadId: uploadId,
            PartNumber: partNumber,
            Body: accumulated
          }));

          parts.push({
            partNumber,
            etag: uploadResult.ETag,
            size: accumulatedSize
          });

          log('Uploaded part', { partNumber, size: accumulatedSize });

          // Clear the pending buffer
          await updateJob(db, exportJobId, {
            's3Upload.pendingBuffer': ''
          });
        }
      }
    }

    // Update progress in DB
    const processedItems = (job.processedItems || 0) + records.length;
    const currentBatch = (job.currentBatch || 0) + 1;

    // Update totalItems if processedItems exceeds it (initial count was an estimate)
    const totalItems = job.totalItems;

    log('Updating progress', { processedItems, totalItems, currentBatch, prevProcessed: job.processedItems || 0, recordsThisBatch: records.length });

    await updateJob(db, exportJobId, {
      cursor: cursor,
      processedItems,
      totalItems,
      currentBatch,
      's3Upload.parts': parts
    });

    // Check if more data exists
    if (hasMoreData || cursor) {
      // More data - invoke next Lambda
      log('Invoking next Lambda', { processedItems, totalItems, cursor, hasMoreData });

      await lambda.send(new InvokeCommand({
        FunctionName: context.functionName,
        InvocationType: 'Event',  // Async
        Qualifier: '$LATEST',     // Required for durable functions
        Payload: JSON.stringify({ exportJobId })
      }));

      return {
        statusCode: 200,
        body: JSON.stringify({
          success: true,
          message: 'Batch complete, next Lambda invoked',
          processedItems,
          batch: currentBatch
        })
      };

    } else {
      // No more data - finalize
      log('All data fetched, finalizing...');

      // Flush any remaining pending buffer as the final part
      // Re-read from DB in case buffer was updated during this invocation
      const freshJob = await db.collection('exportjobs').findOne({ _id: new ObjectId(exportJobId) });
      const remainingBuffer = freshJob?.s3Upload?.pendingBuffer || '';
      if (!useSimpleUpload && remainingBuffer) {
        const partNumber = parts.length + 1;
        const uploadResult = await s3.send(new UploadPartCommand({
          Bucket: S3_BUCKET,
          Key: s3Key,
          UploadId: uploadId,
          PartNumber: partNumber,
          Body: remainingBuffer
        }));
        parts.push({
          partNumber,
          etag: uploadResult.ETag,
          size: Buffer.byteLength(remainingBuffer)
        });
        log('Flushed remaining buffer as final part', { partNumber, size: Buffer.byteLength(remainingBuffer) });
      }

      // Complete multipart upload (only if we didn't use simple putObject)
      if (!useSimpleUpload && parts.length > 0) {
        await s3.send(new CompleteMultipartUploadCommand({
          Bucket: S3_BUCKET,
          Key: s3Key,
          UploadId: uploadId,
          MultipartUpload: {
            Parts: parts.map(p => ({
              PartNumber: p.partNumber,
              ETag: p.etag
            }))
          }
        }));

        log('Multipart upload completed');
      } else if (useSimpleUpload) {
        log('Skipping multipart completion (used putObject)');
      }

      // Generate signed download URL (7 days)
      const downloadUrl = await getSignedUrl(s3, new GetObjectCommand({
        Bucket: S3_BUCKET,
        Key: s3Key
      }), { expiresIn: 7 * 24 * 60 * 60 });

      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

      // Secret token authorizing the public email download link (email links carry no session).
      // Preserve a pre-set token when present (Call Recordings sets it at job creation so the CSV's
      // per-row proxy links are already signed with it — regenerating here would break those links).
      const downloadToken = job.downloadToken || crypto.randomBytes(24).toString('hex');

      // Update job as completed
      await updateJob(db, exportJobId, {
        status: 'completed',
        s3Key,
        s3Bucket: S3_BUCKET,
        downloadUrl,
        downloadUrlExpiresAt: expiresAt,
        downloadToken,
        completedAt: new Date(),
        totalBatches: currentBatch
      });

      // Clean up all chunk docs for this specialTabMessages / callTranscriptions export.
      // Root doc is matched by exportJobId; sibling chunks share groupId = root._id.
      // TTL index is the safety net if this delete fails.
      if (job.exportType === 'specialTabMessages' || job.exportType === 'callTranscriptions' || job.exportType === 'callRecordings') {
        try {
          const rootDoc = await db.collection('specialexports').findOne(
            { exportJobId: new ObjectId(exportJobId) },
            { projection: { _id: 1 } }
          );
          if (rootDoc) {
            const { deletedCount } = await db.collection('specialexports').deleteMany({
              $or: [
                { _id: rootDoc._id },
                { groupId: rootDoc._id }
              ]
            });
            log('SpecialExport cleanup', { deletedCount });
          }
        } catch (cleanupErr) {
          log('SpecialExport cleanup failed (TTL will handle it)', { error: cleanupErr.message });
        }
      }

      // Send email notification. The link points at the backend's public email-download route
      // (regenerates a fresh presigned URL on click) instead of the stored S3 URL, which dies
      // within hours because it's signed with short-lived STS creds.
      let emailSent = false;
      if (job.notificationEmail) {
        const emailDownloadUrl = `${PUBLIC_API_URL}/api/billing/download-email/${exportJobId}?token=${downloadToken}`;
        emailSent = await sendEmail(job.notificationEmail, emailDownloadUrl, {
          exportType: job.exportType,
          format: job.format,
          totalItems: processedItems
        });

        await updateJob(db, exportJobId, { emailSent });
      }

      log('Export completed', { processedItems, totalBatches: currentBatch, emailSent });

      return {
        statusCode: 200,
        body: JSON.stringify({
          success: true,
          message: 'Export completed',
          processedItems,
          totalBatches: currentBatch,
          downloadUrl,
          emailSent
        })
      };
    }

  } catch (error) {
    logError('Export batch failed', { error: error.message, stack: error.stack });

    const updateFields = {};

    // If 400 error, reset cursor so retry starts fresh (cursor likely expired)
    if (error.response?.status === 400) {
      updateFields.cursor = null;
      log('Resetting cursor due to 400 error');
    }

    // Increment retry count
    const retryCount = (job.retryCount || 0) + 1;
    updateFields.retryCount = retryCount;

    if (retryCount < (job.maxRetries || 3)) {
      // Retry - invoke self again
      log('Retrying...', { attempt: retryCount + 1, maxRetries: job.maxRetries || 3 });

      await updateJob(db, exportJobId, updateFields);

      // Wait a bit before retry
      await sleep(5000);

      await lambda.send(new InvokeCommand({
        FunctionName: context.functionName,
        InvocationType: 'Event',
        Qualifier: '$LATEST',
        Payload: JSON.stringify({ exportJobId })
      }));

      return {
        statusCode: 200,
        body: JSON.stringify({
          success: false,
          message: 'Error occurred, retrying...',
          retryCount,
          error: error.message
        })
      };

    } else {
      // Max retries exceeded - abort multipart upload and fail
      logError('Max retries exceeded, failing job');

      // Try to abort multipart upload
      if (job.s3Upload?.uploadId) {
        try {
          await s3.send(new AbortMultipartUploadCommand({
            Bucket: S3_BUCKET,
            Key: job.s3Upload.key,
            UploadId: job.s3Upload.uploadId
          }));
          log('Multipart upload aborted');
        } catch (abortError) {
          logError('Failed to abort multipart upload', { error: abortError.message });
        }
      }

      await updateJob(db, exportJobId, {
        status: 'failed',
        errorMessage: error.message,
        completedAt: new Date()
      });

      return {
        statusCode: 500,
        body: JSON.stringify({
          success: false,
          error: error.message
        })
      };
    }
  }
};
