const express = require('express');
const router = express.Router();
const ghlService = require('../services/ghlService');
const logger = require('../utils/logger');
const { logError, getUserFriendlyMessage } = require('../utils/errorLogger');
const { authenticateSession } = require('../middleware/auth');
const { sanitizeLimit, isValidDate } = require('../utils/sanitize');

/**
 * BONUS FEATURE: Advanced Message Export
 * Export messages with conversation context and advanced filters
 */

/**
 * @route GET /api/export/messages
 * @desc Export messages with advanced filtering and pagination
 * Includes conversationId in response for better context
 */
router.get('/messages', authenticateSession, async (req, res) => {
  try {
    const {
      locationId,
      channel,         // SMS, Email, WhatsApp, Call, etc. (optional)
      startDate,       // ISO date string
      endDate,         // ISO date string
      contactId,       // Specific contact
      conversationId,  // Specific conversation
      cursor,          // For pagination
      limit,           // Messages per page
      userIds          // Filter by GHL user(s); repeated query: userIds=a&userIds=b
    } = req.query;

    if (!locationId) {
      return res.status(400).json({
        success: false,
        error: 'locationId is required'
      });
    }

    // Validate date formats (accepts ISO 8601 strings or millisecond timestamps)
    if (startDate && !isValidDate(startDate)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid startDate format. Use ISO 8601 format or millisecond timestamp.'
      });
    }

    if (endDate && !isValidDate(endDate)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid endDate format. Use ISO 8601 format or millisecond timestamp.'
      });
    }

    // PREVIEW ENDPOINT — sample only.
    // This route powers the in-app preview grid. It is deliberately capped to a SINGLE page and
    // ignores any pagination cursor, so neither the UI nor a scripted caller can walk the cursor
    // to pull the whole dataset for free. The full, paginated fetch is the paid export (Lambda),
    // which is unaffected by this route. Cap the page at 50 regardless of the requested limit.
    const PREVIEW_LIMIT = 50;
    const sanitizedLimit = Math.min(sanitizeLimit(limit, 50, 500), PREVIEW_LIMIT);

    logger.info('Advanced message export (preview)', {
      locationId,
      channel,
      conversationId,
      hasDateFilter: !!(startDate && endDate),
      limit: sanitizedLimit
    });

    // Build export options. NOTE: cursor is intentionally NOT applied — preview is page-1 only.
    const options = { limit: sanitizedLimit };
    if (channel) options.channel = channel;
    if (startDate) {
      const start = new Date(startDate);
      start.setHours(0, 0, 0, 0); // 12:00 AM
      options.startDate = start.getTime();
    }
    if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999); // 11:59 PM
      options.endDate = end.getTime();
    }
    if (contactId) options.contactId = contactId;
    if (conversationId) options.conversationId = conversationId; // Add conversationId filter
    if (userIds) {
      options.userIds = Array.isArray(userIds) ? userIds : [userIds];
    }
    // cursor intentionally dropped — preview is locked to page 1 (anti-scrape).
    // Lite ("Export Messages") app sends X-App: lite → use the lite GHL token for this location,
    // otherwise the premium-scoped lookup finds no token for a lite-only location and 401s.
    if (req.get('X-App') === 'lite') options.lite = true;
    // Export messages using advanced endpoint
    const result = await ghlService.exportMessages(locationId, options);

    const messages = result.messages || [];

    res.json({
      success: true,
      message: 'Messages exported successfully',
      data: {
        total: result.total || messages.length,  // Use API total if available
        loaded: messages.length,
        messages: messages.map(msg => ({
          id: msg.id,
          conversationId: msg.conversationId,  // ← Important for context!
          contactId: msg.contactId,
          userId: msg.userId || null,
          type: msg.type,
          body: msg.body,
          direction: msg.direction || msg?.meta?.email?.direction || "outbound",
          status: msg.status,
          dateAdded: msg.dateAdded,
          attachments: msg.attachments || [],
          meta: msg.meta
        })),
        pagination: {
          // Preview is page-1 only. We expose hasMore purely so the UI can show the
          // "Export to download all" prompt — but we do NOT return a usable cursor, so the
          // dataset can't be walked by repeatedly calling this endpoint.
          nextCursor: null,
          hasMore: !!result.nextCursor
        }
      },
      meta: {
        locationId,
        filters: options,
        exportedAt: new Date().toISOString()
      }
    });

  } catch (error) {
    logError('Export messages error', error, { 
      locationId: req.query?.locationId,
      filters: req.query 
    });
    
    const statusCode = error.status || error.response?.status || 500;
    
    res.status(statusCode).json({
      success: false,
      error: 'Failed to export messages',
      message: getUserFriendlyMessage(error)
    });
  }
});

/**
 * @route GET /api/export/contacts
 * @desc List contacts for the dashboard preview, paginated.
 *       Backed by POST /contacts/search (advanced).
 */
router.get('/contacts', authenticateSession, async (req, res) => {
  try {
    const {
      locationId,
      query,
      tag,
      assignedTo,
      startDate,
      endDate,
      startAfter,
      startAfterId,
      limit
    } = req.query;

    if (!locationId) {
      return res.status(400).json({ success: false, error: 'locationId is required' });
    }

    if (startDate && !isValidDate(startDate)) {
      return res.status(400).json({ success: false, error: 'Invalid startDate format' });
    }
    if (endDate && !isValidDate(endDate)) {
      return res.status(400).json({ success: false, error: 'Invalid endDate format' });
    }

    const sanitizedLimit = sanitizeLimit(limit, 100, 500);

    const result = await ghlService.searchContactsAdvanced(locationId, {
      limit: sanitizedLimit,
      query: query || undefined,
      tag: tag || undefined,
      assignedTo: assignedTo || undefined,
      startDate: startDate || undefined,
      endDate: endDate || undefined,
      startAfter: startAfter || undefined,
      startAfterId: startAfterId || undefined
    });

    const contacts = result.contacts || [];

    res.json({
      success: true,
      data: {
        total: result.total || contacts.length,
        loaded: contacts.length,
        contacts: contacts.map(c => ({
          id: c.id,
          name: c.name || c.contactName || `${c.firstName || ''} ${c.lastName || ''}`.trim(),
          firstName: c.firstName || '',
          lastName: c.lastName || '',
          email: c.email || '',
          phone: c.phone || '',
          companyName: c.companyName || '',
          tags: c.tags || [],
          source: c.source || '',
          type: c.type || '',
          assignedTo: c.assignedTo || '',
          dateAdded: c.dateAdded,
          dateUpdated: c.dateUpdated,
          city: c.city || '',
          state: c.state || '',
          country: c.country || ''
        })),
        pagination: {
          startAfter: result.meta?.startAfter || null,
          startAfterId: result.meta?.startAfterId || null,
          hasMore: !!result.meta?.startAfterId
        }
      },
      meta: {
        locationId,
        exportedAt: new Date().toISOString()
      }
    });
  } catch (error) {
    logError('Export contacts list error', error, { locationId: req.query?.locationId });
    const statusCode = error.status || error.response?.status || 500;
    res.status(statusCode).json({
      success: false,
      error: 'Failed to fetch contacts',
      message: getUserFriendlyMessage(error)
    });
  }
});

/**
 * @route GET /api/export/messages/all
 * @desc Export ALL messages with automatic pagination
 * Handles cursor-based pagination automatically
 */
router.get('/messages/all', authenticateSession, async (req, res) => {
  // DISABLED (anti-scrape). This route returned the ENTIRE message dataset in one response with no
  // billing — a free full export. No UI uses it (real exports go through billing → Lambda), so it
  // is closed off. Callers must use the paid export flow instead.
  logger.warn('Blocked /export/messages/all (disabled — use the paid export flow)', {
    locationId: req.query?.locationId,
    userId: req.user?.userId || req.session?.userId
  });
  return res.status(410).json({
    success: false,
    error: 'This endpoint is no longer available. Please use the Export feature to download your data.'
  });

  // eslint-disable-next-line no-unreachable
  try {
    const { locationId, channel, startDate, endDate, contactId } = req.query;

    if (!locationId) {
      return res.status(400).json({
        success: false,
        error: 'locationId is required'
      });
    }

    logger.info('Bulk export started for sub-account', { locationId });

    const filters = {};
    if (channel) filters.channel = channel;
    if (startDate) filters.startDate = startDate;
    if (endDate) filters.endDate = endDate;
    if (contactId) filters.contactId = contactId;
    if (req.get('X-App') === 'lite') filters.lite = true; // lite app → lite GHL token

    // Export all messages (handles pagination automatically)
    const allMessages = await ghlService.exportAllMessages(
      locationId, 
      filters,
      (fetched, total) => {
        logger.info(`Progress: ${fetched}/${total || '?'} messages`);
      }
    );

    // Group by conversation for better context
    const byConversation = {};
    allMessages.forEach(msg => {
      const convId = msg.conversationId || 'unknown';
      if (!byConversation[convId]) {
        byConversation[convId] = [];
      }
      byConversation[convId].push(msg);
    });

    res.json({
      success: true,
      message: 'Bulk export completed',
      data: {
        totalMessages: allMessages.length,
        totalConversations: Object.keys(byConversation).length,
        messages: allMessages,
        byConversation: byConversation
      },
      meta: {
        locationId,
        filters,
        exportedAt: new Date().toISOString()
      }
    });

  } catch (error) {
    logError('Bulk export error', error, { 
      locationId: req.query?.locationId 
    });
    
    const statusCode = error.status || error.response?.status || 500;
    
    res.status(statusCode).json({
      success: false,
      error: 'Failed to bulk export',
      message: getUserFriendlyMessage(error)
    });
  }
});

/**
 * @route GET /api/export/csv
 * @desc Export messages as CSV format
 */
router.get('/csv', authenticateSession, async (req, res) => {
  try {
    const { locationId, channel, startDate, endDate } = req.query;

    if (!locationId) {
      return res.status(400).json({
        success: false,
        error: 'locationId is required'
      });
    }

    const filters = {};
    if (channel) filters.channel = channel;
    if (startDate) filters.startDate = startDate;
    if (endDate) filters.endDate = endDate;

    // Export all messages for sub-account
    const messages = await ghlService.exportAllMessages(locationId, filters);

    // Convert to CSV format
    const csvHeaders = 'Date,ConversationID,ContactID,UserID,Type,Direction,Status,Message\n';
    const csvRows = messages.map(msg => {
      const date = new Date(msg.dateAdded).toISOString();
      const message = (msg.body || '').replace(/"/g, '""').replace(/\n/g, ' ');
      return `"${date}","${msg.conversationId}","${msg.contactId}","${msg.userId || ''}","${msg.type}","${msg.direction}","${msg.status}","${message}"`;
    }).join('\n');

    const csv = csvHeaders + csvRows;

    // Send as downloadable file
    const filename = `messages_${locationId}_${Date.now()}.csv`;
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);

  } catch (error) {
    logError('CSV export error', error, { 
      locationId: req.query?.locationId,
      filters: req.query 
    });
    
    const statusCode = error.status || error.response?.status || 500;
    
    res.status(statusCode).json({
      success: false,
      error: getUserFriendlyMessage(error)
    });
  }
});

module.exports = router;

