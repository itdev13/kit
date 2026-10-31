import apiClient from './client';

export const billingAPI = {
  /**
   * Get cost estimate for export
   * @param {string} locationId - Location ID
   * @param {string} exportType - 'conversations' or 'messages'
   * @param {Object} filters - Export filters { channel, startDate, endDate, contactId }
   */
  getEstimate: async (locationId, exportType, exportFilters = {}) => {
    const response = await apiClient.post('/billing/estimate', {
      locationId,
      exportType,
      filters:exportFilters
    });
    return response;
  },
  /**
   * Charge wallet and start export
   * @param {string} locationId - Location ID
   * @param {string} exportType - 'conversations' or 'messages'
   * @param {string} format - 'csv' or 'json'
   * @param {Object} filters - Export filters
   * @param {string} notificationEmail - Email for notification (optional)
   */
  chargeAndExport: async (locationId, exportType, format, filters = {}, notificationEmail = null) => {
    const response = await apiClient.post('/billing/charge-and-export', {
      locationId,
      exportType,
      format,
      filters,
      notificationEmail
    });
    return response;
  },

  /**
   * Get export job status
   * @param {string} jobId - Export job ID
   * @param {string} locationId - Location ID (for verification)
   */
  getExportStatus: async (jobId, locationId) => {
    const response = await apiClient.get(`/billing/export-status/${jobId}`, {
      params: { locationId }
    });
    return response;
  },

  /**
   * Get a FRESH presigned download URL for a completed export, generated on the fly.
   * The backend regenerates the S3 URL at click-time (valid while inside the 7-day window),
   * avoiding the stale-signature problem of storing a long-lived URL. Returns { url }.
   * @param {string} jobId - Export job ID
   * @param {string} locationId - Location ID (for verification)
   */
  getDownloadUrl: async (jobId, locationId) => {
    const response = await apiClient.get(`/billing/download/${jobId}`, {
      params: { locationId }
    });
    return response;
  },

  /**
   * Get export history for location with pagination
   * @param {string} locationId - Location ID
   * @param {number} page - Page number (default 1)
   * @param {number} limit - Max number of jobs per page (default 10)
   */
  getExportHistory: async (locationId, page = 1, limit = 10) => {
    const response = await apiClient.get('/billing/export-history', {
      params: { locationId, page, limit }
    });
    return response;
  },

  /**
   * Get pricing information
   */
  getPricing: async (locationId) => {
    const response = await apiClient.get('/billing/pricing', {
      params: locationId ? { locationId } : {}
    });
    return response;
  },

  /**
   * Get pipelines for a location
   * @param {string} locationId - Location ID
   */
  getPipelines: async (locationId) => {
    const response = await apiClient.get('/billing/pipelines', {
      params: { locationId }
    });
    return response;
  },

  /**
   * Get forms for a location
   * @param {string} locationId - Location ID
   */
  getForms: async (locationId) => {
    const response = await apiClient.get('/billing/forms', {
      params: { locationId }
    });
    return response;
  },

  /**
   * Get calendars for a location (appointments calendar dropdown)
   * @param {string} locationId - Location ID
   */
  getCalendars: async (locationId) => {
    const response = await apiClient.get('/billing/calendars', {
      params: { locationId }
    });
    return response;
  },

  /**
   * Search form submissions for a location (preview) — page-based pagination
   */
  searchFormSubmissions: async (locationId, filters = {}, page = 1, limit = 25) => {
    const response = await apiClient.post('/billing/formSubmissions/search', {
      locationId,
      filters,
      page,
      limit
    });
    return response;
  },

  /**
   * Search trigger links for a location (preview) — page-based pagination
   */
  searchLinks: async (locationId, query = '', page = 1, limit = 25) => {
    const response = await apiClient.post('/billing/links/search', {
      locationId,
      query,
      page,
      limit
    });
    return response;
  },

  /**
   * Search opportunities for a location (preview) — cursor-based pagination via searchAfter
   */
  searchOpportunities: async (locationId, filters = {}, searchAfter = null, limit = 20) => {
    const response = await apiClient.post('/billing/opportunities/search', {
      locationId,
      filters,
      searchAfter,
      limit
    });
    return response;
  },

  /**
   * Search tasks for a location (preview) — cursor-based pagination via searchAfter
   */
  searchTasks: async (locationId, filters = {}, searchAfter = null, limit = 25) => {
    const response = await apiClient.post('/billing/tasks/search', {
      locationId,
      filters,
      searchAfter,
      limit
    });
    console.log("response tasks", response);
    return response;
  },

  /**
   * Search templates for a location (preview) — page-based pagination
   */
  searchTemplates: async (locationId, filters = {}, page = 1, limit = 25) => {
    const response = await apiClient.post('/billing/templates/search', {
      locationId,
      filters,
      page,
      limit
    });
    return response;
  },

  searchCallLogs: async (locationId, filters = {}, page = 1, pageSize = 10) => {
    const response = await apiClient.post('/billing/callLogs/search', {
      locationId,
      filters,
      page,
      pageSize
    });
    return response;
  },

  /**
   * Get voice AI agents for a location
   */
  getVoiceAIAgents: async (locationId) => {
    const response = await apiClient.get('/billing/voice-ai-agents', {
      params: { locationId }
    });
    return response;
  },

  /**
   * Search users for a location's company
   */
  searchUsers: async (locationId, query = '') => {
    const response = await apiClient.get('/billing/users', {
      params: { locationId, query }
    });
    return response;
  },

  customCharge: async (locationId, amount) => {
    const response = await apiClient.post('/billing/custom-charge', { locationId, amount });
    return response;
  },

  /**
   * Submit a custom-rate request for this location.
   * Auto-approves at the proposed rate when expectedVolume >= 10000;
   * otherwise saves pending + emails internal team for manual review.
   */
  submitPricingRequest: async ({ locationId, proposedCreditPrice, expectedVolume, email, reason }) => {
    const response = await apiClient.post('/billing/pricing-request', {
      locationId, proposedCreditPrice, expectedVolume, email, reason
    });
    return response;
  },
};
