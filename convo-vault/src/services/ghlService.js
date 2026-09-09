const axios = require('axios');
const logger = require('../utils/logger');
const { logError, logWarning } = require('../utils/errorLogger');
const OAuthToken = require('../models/OAuthToken');
const CompanyLocation = require('../models/CompanyLocation');

const nonNullValue=(val)=>{
  return val != null && val != undefined && val != "";
}
/**
 * Simple GHL API Service
 */
class GHLService {
  constructor() {
    this.baseURL = process.env.GHL_API_URL || 'https://services.leadconnectorhq.com';
    this.oauthURL = process.env.GHL_OAUTH_URL || 'https://services.leadconnectorhq.com/oauth';
  }

  /**
   * Exchange code for token
   */
  async getAccessToken(code, isLite = false) {
    try {
      // The auth code is issued for a specific marketplace app, so it MUST be exchanged with
      // that app's client credentials. The lite ("Export Messages") app has its own client;
      // using the premium client here returns 401 UnAuthorized.
      const clientId = isLite ? process.env.GHL_LITE_CLIENT_ID : process.env.GHL_CLIENT_ID;
      const clientSecret = isLite ? process.env.GHL_LITE_CLIENT_SECRET : process.env.GHL_CLIENT_SECRET;
      const params = new URLSearchParams();
      params.append('client_id', clientId);
      params.append('client_secret', clientSecret);
      params.append('grant_type', 'authorization_code');
      params.append('code', code);

      const response = await axios.post(`${this.oauthURL}/token`, params, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      });

      logger.info('Token exchange successful', {
        locationId: response.data.locationId,
        companyId: response.data.companyId
      });

      return {
        accessToken: response.data.access_token,
        refreshToken: response.data.refresh_token,
        expiresIn: response.data.expires_in,
        locationId: response.data.locationId,
        companyId: response.data.companyId,
        // GHL returns the OAuth-authorizing user's id on the token response.
        userId: response.data.userId || null
      };
    } catch (error) {
      logger.error('Token exchange failed:', error.response?.data || error.message);
      throw error;
    }
  }


  /**
   * Refresh token
   */
  async refreshAccessToken(refreshToken, isLite = false) {
    try {
      // Lite tokens were issued by the lite ("Export Messages") app, so they MUST be refreshed
      // with that app's client credentials. Default false = premium, unchanged.
      const clientId = isLite ? process.env.GHL_LITE_CLIENT_ID : process.env.GHL_CLIENT_ID;
      const clientSecret = isLite ? process.env.GHL_LITE_CLIENT_SECRET : process.env.GHL_CLIENT_SECRET;
      const params = new URLSearchParams();
      params.append('client_id', clientId);
      params.append('client_secret', clientSecret);
      params.append('grant_type', 'refresh_token');
      params.append('refresh_token', refreshToken);

      const response = await axios.post(`${this.oauthURL}/token`, params, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      });
      return {
        accessToken: response.data.access_token,
        refreshToken: response.data.refresh_token,
        expiresIn: response.data.expires_in
      };
    } catch (error) {
      logger.error('Token refresh failed:', error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Generate location-level token from company token
   * Required when company-level token can't access location APIs
   */
  async getLocationTokenFromCompany(companyId, locationId, retryCount = 0, opts = {}) {
    const isLite = !!opts.lite;
    const liteFilter = isLite ? { lite: true } : { lite: { $ne: true } };
    try {
      logger.info('Generating location token from company token');

      // Get company token (same app scope)
      let companyToken = await OAuthToken.findOne({
        companyId,
        tokenType: 'company',
        isActive: true,
        ...liteFilter
      });

      if (!companyToken) {
        throw new Error('No company token found');
      }


      // IMPORTANT: Refresh company token if it's expired/expiring
      if (companyToken.needsRefresh()) {
        logger.info('Company token needs refresh before generating location token');
        try {
          const refreshedToken = await this.refreshAccessToken(companyToken.refreshToken, isLite);

          companyToken.accessToken = refreshedToken.accessToken;
          companyToken.refreshToken = refreshedToken.refreshToken;
          companyToken.expiresAt = new Date(Date.now() + refreshedToken.expiresIn * 1000);
          await companyToken.save();

          logger.info('✅ Company token refreshed successfully');
        } catch (refreshError) {
          // Handle "invalid_grant" - refresh token was already used by another process
          if (refreshError.response?.data?.error === 'invalid_grant') {
            logger.info('Company refresh token already used, fetching latest...');

            // Re-fetch latest company token from DB (same app scope)
            const latestCompanyToken = await OAuthToken.findOne({
              companyId,
              tokenType: 'company',
              isActive: true,
              ...liteFilter
            });

            if (latestCompanyToken && latestCompanyToken.accessToken !== companyToken.accessToken) {
              logger.info('Using company token refreshed by another process');
              companyToken.accessToken = latestCompanyToken.accessToken;
              companyToken.refreshToken = latestCompanyToken.refreshToken;
              companyToken.expiresAt = latestCompanyToken.expiresAt;
            } else {
              logger.error('Failed to refresh company token:', refreshError.message);
              throw new Error('Company token expired. Please reconnect your account.');
            }
          } else {
            logger.error('Failed to refresh company token:', refreshError.message);
            throw new Error('Company token expired. Please reconnect your account.');
          }
        }
      }

      // Call GHL API to get location token using the valid company token
      const response = await axios.post(
        `${this.oauthURL}/locationToken`,
        {
          companyId,
          locationId
        },
        {
          headers: {
            'Authorization': `Bearer ${companyToken.accessToken}`,
            'Content-Type': 'application/json',
            'Version': '2021-07-28'
          }
        }
      );

      logger.info('✅ Location token generated successfully');

      return {
        accessToken: response.data.access_token,
        refreshToken: response.data.refresh_token,
        expiresIn: response.data.expires_in
      };
    } catch (error) {
      // If we get 401 and haven't retried yet, refresh company token and retry
      if (error.response?.status === 401 && retryCount === 0) {
        logger.info('🔄 Got 401 generating location token, refreshing company token and retrying...');

        try {
          // Force refresh the company token (same app scope)
          const companyToken = await OAuthToken.findOne({
            companyId,
            tokenType: 'company',
            isActive: true,
            ...liteFilter
          });

          if (!companyToken || !companyToken.refreshToken) {
            throw new Error('No company refresh token available');
          }

          // Check if token was recently refreshed by another process
          const expiresIn = companyToken.expiresAt - Date.now();
          if (expiresIn > 23 * 60 * 60 * 1000) {
            logger.info('Company token was recently refreshed, retrying with new token');
            return await this.getLocationTokenFromCompany(companyId, locationId, retryCount + 1, { lite: isLite });
          }

          try {
            const refreshedToken = await this.refreshAccessToken(companyToken.refreshToken, isLite);

            companyToken.accessToken = refreshedToken.accessToken;
            companyToken.refreshToken = refreshedToken.refreshToken;
            companyToken.expiresAt = new Date(Date.now() + refreshedToken.expiresIn * 1000);
            await companyToken.save();

            logger.info('✅ Company token refreshed after 401, retrying location token generation');
          } catch (refreshErr) {
            // Handle "invalid_grant" - refresh token was already used
            if (refreshErr.response?.data?.error === 'invalid_grant') {
              logger.info('Company refresh token already used, fetching latest...');

              const latestToken = await OAuthToken.findOne({
                companyId,
                tokenType: 'company',
                isActive: true,
                ...liteFilter
              });

              if (!latestToken || latestToken.accessToken === companyToken.accessToken) {
                throw refreshErr;
              }
              logger.info('Using company token refreshed by another process');
            } else {
              throw refreshErr;
            }
          }

          // Retry ONCE
          return await this.getLocationTokenFromCompany(companyId, locationId, retryCount + 1, { lite: isLite });

        } catch (refreshError) {
          logger.error('❌ Company token refresh failed:', refreshError.message);
          const authError = new Error('Your authentication has expired. Please reconnect the ExportKit app to your account.');
          authError.status = 401;
          authError.isClientError = true;
          throw authError;
        }
      }

      // If we get 401 even after refresh, the company token is invalid
      if (error.response?.status === 401) {
        logger.error('Company token is invalid or expired after retry. User needs to reconnect.');
        const authError = new Error('Your authentication has expired. Please reconnect the ExportKit app to your account.');
        authError.status = 401;
        authError.isClientError = true;
        throw authError;
      }
      
      logger.error('Failed to generate location token:', error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Get valid access token (auto-refresh if needed)
   * Handles both location and company tokens
   */
  async getValidToken(locationId, opts = {}) {
    const isLite = !!opts.lite;
    // Lite scoping: lite rows match `lite:true`; premium matches lite false OR missing (`$ne: true`)
    // so legacy prod docs (no lite field) still resolve.
    const liteFilter = isLite ? { lite: true } : { lite: { $ne: true } };
    // STEP 1: Try to find location-specific token first (preferred)
    let tokenDoc = await OAuthToken.findOne({
      locationId,
      tokenType: 'location',
      isActive: true,
      ...liteFilter
    });

    // STEP 2: If no location token exists, find company via CompanyLocation mapping
    if (!tokenDoc) {
      logger.info('No location token found, looking up company for location:', locationId);

      // Look up which company owns this locationId
      const companyLoc = await CompanyLocation.findCompanyByLocation(locationId);
      if (!companyLoc) {
        const error = new Error('Location not found. Please reconnect ExportKit application to your account.');
        error.status = 404;
        error.isClientError = true;
        throw error;
      }

      // Get the company's OAuth token (scoped to the same app so lite/premium don't cross over)
      const companyToken = await OAuthToken.findOne({
        companyId: companyLoc.companyId,
        tokenType: 'company',
        isActive: true,
        ...liteFilter
      });

      if (!companyToken) {
        const error = new Error('Company token expired. Please reconnect ExportKit application to your account.');
        error.status = 401;
        error.isClientError = true;
        throw error;
      }

      // Generate location token from company token
      logger.info('Generating location token from company token for:', locationId);
      const locationToken = await this.getLocationTokenFromCompany(
        companyLoc.companyId,
        locationId,
        0,
        { lite: isLite }
      );

      // Store location-specific token (stamp lite so lite/premium stay separate rows)
      tokenDoc = await OAuthToken.findOneAndUpdate(
        { locationId, tokenType: 'location', ...liteFilter },
        {
          locationId,
          companyId: companyLoc.companyId,
          tokenType: 'location',
          accessToken: locationToken.accessToken,
          refreshToken: locationToken.refreshToken,
          expiresAt: new Date(Date.now() + locationToken.expiresIn * 1000),
          isActive: true,
          lite: isLite
        },
        { upsert: true, new: true }
      );

      logger.info('✅ Location token created and saved to database');
    }

    // STEP 3: Refresh if needed
    if (tokenDoc.needsRefresh()) {
      logger.info('Refreshing token for location:', locationId);

      try {
        const newToken = await this.refreshAccessToken(tokenDoc.refreshToken, isLite);

        tokenDoc.accessToken = newToken.accessToken;
        tokenDoc.refreshToken = newToken.refreshToken;
        tokenDoc.expiresAt = new Date(Date.now() + newToken.expiresIn * 1000);
        await tokenDoc.save();

        logger.info('✅ Token refreshed successfully');
      } catch (refreshErr) {
        // Handle "invalid_grant" - refresh token was already used by another process
        if (refreshErr.response?.data?.error === 'invalid_grant') {
          logger.info('Refresh token already used by another process, fetching latest...');

          // Re-fetch latest token from DB (same app scope)
          const latestToken = await OAuthToken.findActiveToken(locationId, { lite: isLite });
          if (latestToken && latestToken.accessToken !== tokenDoc.accessToken) {
            logger.info('Using token refreshed by another process');
            return latestToken.accessToken;
          }
        }
        throw refreshErr;
      }
    }

    return tokenDoc.accessToken;
  }

  /**
   * Get sub-account details
   */
  async getLocationDetails(locationId, opts = {}) {
    try {
      logger.info('Fetching sub-account details for:', locationId);

      const response = await this.apiRequest(
        'GET',
        `/locations/${locationId}`,
        locationId,
        null,
        null,
        0,
        { lite: opts.lite }
      );

      // Extract relevant sub-account data
      const location = response.location || response;
      
      return {
        locationName: location.name || null,
        locationEmail: location.email || null,
        locationPhone: location.phone || null,
        locationAddress: location.address || null,
        locationWebsite: location.website || null,
        locationTimezone: location.timezone || null
      };
    } catch (error) {
      logger.error('Failed to fetch sub-account details:', error.message);
      // Return null values if fetch fails (non-critical)
      return {
        locationName: null,
        locationEmail: null,
        locationPhone: null,
        locationAddress: null,
        locationWebsite: null,
        locationTimezone: null
      };
    }
  }

  /**
   * Get all sub-accounts for a company (using company-level token)
   */
  async getCompanyLocations(companyId, companyAccessToken) {
    try {
      logger.info('Fetching sub-accounts for company:', companyId);
      
      const response = await axios.get(`${this.baseURL}/locations/search`, {
        headers: {
          'Authorization': `Bearer ${companyAccessToken}`,
          'Content-Type': 'application/json',
          'Version': '2021-07-28'
        },
        params: {
          companyId: companyId,
          limit: 100 // Adjust as needed
        }
      });

      const locations = response.data.locations || [];
      logger.info(`Found ${locations.length} sub-accounts for company`);
      
      return locations.map(loc => ({
        locationId: loc.id,
        locationName: loc.name,
        locationEmail: loc.email || null,
        locationPhone: loc.phone || null,
        locationAddress: loc.address || null,
        locationWebsite: loc.website || null,
        locationTimezone: loc.timezone || null
      }));
    } catch (error) {
      logger.error('Failed to fetch company sub-accounts:', {
        message: error.message,
        status: error.response?.status
      });
      return [];
    }
  }

  /**
   * Make authenticated API request with auto-retry on 401
   * @param {string} method - HTTP method
   * @param {string} endpoint - API endpoint
   * @param {string} locationId - Location ID
   * @param {*} data - Request body
   * @param {*} params - Query params
   * @param {number} retryCount - Internal retry counter
   */
  async apiRequest(method, endpoint, locationId, data = null, params = null, retryCount = 0, opts = {}) {
    try {
    const accessToken = await this.getValidToken(locationId, { lite: opts.lite });
    const config = {
      method,
      url: `${this.baseURL}${endpoint}`,
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        // Some endpoints (e.g. group-chat conversation search with conversationType=5) require a
        // newer API version than the default. Callers can override via opts.version.
        'Version': opts.version || '2021-07-28'
      }
    };

    if (data) config.data = data;
    if (params) config.params = params;
    const response = await axios(config);
    return response.data;

    } catch (error) {
      // Check for HIPAA compliance error (returns 401 but is NOT an auth issue)
      const errorMessage = error.response?.data?.message || error.response?.data?.msg || '';
      if (error.response?.status === 401 && /hipaa/i.test(errorMessage)) {
        const hipaaError = new Error('This account has HIPAA compliance enabled. Message data cannot be accessed via API.');
        hipaaError.status = 403;
        hipaaError.isHipaa = true;
        throw hipaaError;
      }

      // If 401 Unauthorized and haven't retried yet
      if (error.response?.status === 401 && retryCount === 0) {
        logger.info('🔄 Got 401, attempting token refresh and retry...');

        try {
          // CRITICAL: Re-fetch latest token from DB to avoid race condition
          // Another request might have already refreshed the token (same app scope)
          const tokenDoc = await OAuthToken.findActiveToken(locationId, { lite: opts.lite });

          if (!tokenDoc || !tokenDoc.refreshToken) {
            throw new Error('No refresh token available');
          }

          // Check if token was recently refreshed by another process (within last 5 minutes)
          // If expiry is more than 23 hours away, token was just refreshed
          const expiresIn = tokenDoc.expiresAt - Date.now();
          if (expiresIn > 23 * 60 * 60 * 1000) {
            logger.info('Token was recently refreshed by another process, retrying with new token');
            return await this.apiRequest(method, endpoint, locationId, data, params, retryCount + 1, opts);
          }

          logger.info('Refreshing token after 401 error');

          try {
            const newToken = await this.refreshAccessToken(tokenDoc.refreshToken, opts.lite);

            // Update token in database
            tokenDoc.accessToken = newToken.accessToken;
            tokenDoc.refreshToken = newToken.refreshToken;
            tokenDoc.expiresAt = new Date(Date.now() + newToken.expiresIn * 1000);
            await tokenDoc.save();

            logger.info('✅ Token refreshed, retrying API call');
          } catch (refreshErr) {
            // Handle "invalid_grant" - refresh token was already used by another process
            if (refreshErr.response?.data?.error === 'invalid_grant') {
              logger.info('Refresh token already used by another process, fetching latest...');

              // Re-fetch - another process should have updated the token (same app scope)
              const latestToken = await OAuthToken.findActiveToken(locationId, { lite: opts.lite });
              if (latestToken && latestToken.accessToken !== tokenDoc.accessToken) {
                logger.info('Using token refreshed by another process');
                // Continue to retry with the new token
              } else {
                throw refreshErr;
              }
            } else {
              throw refreshErr;
            }
          }

          // Retry the request ONCE
          return await this.apiRequest(method, endpoint, locationId, data, params, retryCount + 1, opts);

        } catch (refreshError) {
          logger.error('❌ Token refresh failed:', refreshError.message);

          // If refresh fails, throw proper error
          throw new Error('Authentication failed. Please reconnect your account.');
        }
      }

      // Handle 429 Rate Limit with exponential backoff (max 3 retries)
      if (error.response?.status === 429 && retryCount < 3) {
        const backoffMs = Math.min(1000 * Math.pow(2, retryCount), 10000); // 1s, 2s, 4s (max 10s)
        logger.warn(`⏳ Rate limited (429), retrying in ${backoffMs}ms (attempt ${retryCount + 1}/3)`, {
          endpoint,
          retryAfter: error.response?.headers?.['retry-after']
        });

        // Use Retry-After header if provided, otherwise use exponential backoff
        const retryAfter = error.response?.headers?.['retry-after'];
        const waitMs = retryAfter ? parseInt(retryAfter) * 1000 : backoffMs;

        await new Promise(resolve => setTimeout(resolve, waitMs));
        return await this.apiRequest(method, endpoint, locationId, data, params, retryCount + 1, opts);
      }

      // Handle transient GHL slowness with a SINGLE backoff retry (read endpoints only).
      // GHL's contacts search can exceed their own 30s server-side limit and return HTTP 400 with
      // body "Request Timeout after 30000ms" (or 502/503/504). A large location can time out
      // repeatedly, so we retry only ONCE (not 3×) — enough to clear a transient blip without
      // turning a consistently-slow query into a 90s hang. Only idempotent reads are retried.
      const ghlMsg = error.response?.data?.message || error.message || '';
      const status = error.response?.status;
      const isTimeoutish =
        error.code === 'ECONNABORTED' ||
        /timeout/i.test(ghlMsg) ||
        status === 502 || status === 503 || status === 504;
      const isReadEndpoint =
        method === 'GET' || /\/search$/.test(endpoint) || endpoint === '/contacts/search';
      if (isTimeoutish && isReadEndpoint && retryCount < 1) {
        logger.warn(`⏳ Transient GHL timeout, retrying once in 2s`, { endpoint, status, message: ghlMsg });
        await new Promise(resolve => setTimeout(resolve, 2000));
        return await this.apiRequest(method, endpoint, locationId, data, params, retryCount + 1, opts);
      }

      // For other errors or after retry failed, throw original error
      logger.error(`API request failed: ${method} ${endpoint}`, {
        status: error.response?.status,
        message: error.response?.data?.message || error.message
      });

      throw error;
    }
  }

  /**
   * Search conversations with advanced filters
   * Reference: https://marketplace.gohighlevel.com/docs/ghl/conversations/search-conversation
   * 
   * Supported GHL API Parameters (verify in docs):
   * - locationId (required)
   * - limit, offset
   * - status (all, read, unread, starred)
   * - sortBy (last_message_date, dateUpdated)
   * - lastMessageType, lastMessageDirection
   * 
   * Note: startDate/endDate support varies by API version
   */
  async searchConversations(locationId, filters = {}) {
    // Build query params with all supported filters
    const params = {
      locationId,
      limit: filters.limit || 20
    };

    // Copy filters, converting dates to timestamps for GHL API
    Object.keys(filters).forEach(key => {
     if (key === 'startDate' || key === 'endDate') {
        const dateValue = filters[key];

        if (dateValue) {
          const dateStr = String(dateValue).trim();

          let date;

          // If already a millisecond timestamp
          if (!isNaN(Number(dateStr)) && !dateStr.includes('T') && !dateStr.includes('-')) {
            date = new Date(Number(dateStr));
          } else {
            date = new Date(dateStr);
          }

          if (!isNaN(date.getTime())) {
            if (key === 'startDate') {
              // Set to 12:00 AM
              date.setHours(0, 0, 0, 0);
            }

            if (key === 'endDate') {
              // Set to 11:59:59.999 PM
              date.setHours(23, 59, 59, 999);
            }

            params[key] = date.getTime(); // Convert to millisecond timestamp
          }
        }
      } else if (filters[key] !== '' && filters[key] !== null && filters[key] !== undefined) {
        params[key] = filters[key];
      }
    });

    logger.info('🔍 Searching conversations with filters', { 
      locationId, 
      params: JSON.stringify(params)
    });

    try {
      // Group/internal chat search (conversationType 5/6) needs a newer API version than the
      // default 2021-07-28 to return results — request v3 when a conversationType is specified.
      const reqOpts = params.conversationType != null ? { version: 'v3' } : {};
      const result = await this.apiRequest(
        'GET',
        '/conversations/search',
        locationId,
        null,
        params,
        0,
        reqOpts
      );

      logger.info('✅ Conversations search successful', {
        count: result.conversations?.length || 0
      });
      
      return result;
      
    } catch (error) {
      logger.error('❌ GHL API rejected conversation search', {
        status: error.response?.status,
        error: error.response?.data,
        sentParams: params
      });
      throw error;
    }
  }

  /**
   * Get conversation by ID
   */
  async getConversation(locationId, conversationId) {
    try {
      const result = await this.apiRequest(
        'GET',
        `/conversations/${conversationId}`,
        locationId
      );
      
      logger.info('✅ Single conversation fetched', {
        conversationId,
        hasType: !!result.type,
        hasLastMessageType: !!result.lastMessageType,
        hasDirection: !!result.lastMessageDirection
      });
      
      return result;
      
    } catch (error) {
      logger.error('❌ Failed to fetch conversation', {
        conversationId,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Get messages for a conversation with pagination support
   */
  async getMessages(locationId, conversationId, options = {}) {
    const params = {
      limit: options.limit || 100
    };

    // Add pagination cursor if provided
    if (options.lastMessageId) {
      params.lastMessageId = options.lastMessageId;
    }

    // Add sorting
    if (options.sortOrder) {
      params.sortOrder = options.sortOrder; // 'asc' or 'desc'
    }

    // Add type filter
    if (options.type) {
      params.type = options.type;
    }
    const result = await this.apiRequest(
      'GET',
      `/conversations/${conversationId}/messages`,
      locationId,
      null,
      params
    );

    return result;
  }

  /**
   * Get a single message by ID. Reference:
   *   https://marketplace.gohighlevel.com/docs/ghl/conversations/get-message
   *   GET /conversations/messages/{messageId}
   *
   * Used for the Opportunity Stage History flow: the list endpoint
   * GET /conversations/{convId}/messages STRIPS the nested `activity` field for type=28 rows,
   * but the single-message endpoint may return the enriched record with activity.data.{id,stage}.
   */
  async getMessageById(locationId, messageId) {
    const result = await this.apiRequest(
      'GET',
      `/conversations/messages/${messageId}`,
      locationId,
      null,
      null
    );
    return result;
  }

  /**
   * Download the transcription for a single call/voicemail message as plain text.
   * Returns a string like "00:01: Hello\n00:03: Hi there\n..." (or empty string if none).
   * Reference: https://marketplace.gohighlevel.com/docs/ghl/conversations/download-message-transcription
   *
   * Note: this endpoint returns text/plain, so we bypass apiRequest's JSON-default config
   * and call axios directly with responseType: 'text'.
   */
  async getMessageTranscription(locationId, messageId) {
    const accessToken = await this.getValidToken(locationId);
    const response = await axios({
      method: 'GET',
      url: `${this.baseURL}/conversations/locations/${locationId}/messages/${messageId}/transcription/download`,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Version: '2021-07-28'
      },
      responseType: 'text'
    });
    return response.data || '';
  }

  /**
   * Export messages with advanced filters
   * Includes conversationId in response and supports cursor pagination
   */
  async exportMessages(locationId, options = {}) {
    try {
      const params = {
        locationId: locationId,
        limit: options.limit || 100
      };

      // Channel filter (omit for all non-email, or specify: SMS, Email, WhatsApp, Call, etc.)
      if (options.channel && options.channel !== 'undefined' && options.channel.trim()) {
        params.channel = options.channel;
      }

      // Cursor for pagination (valid for 2 minutes)
      if (options.cursor && options.cursor !== 'undefined' && options.cursor.trim()) {
        params.cursor = options.cursor;
      }

      if (options.startDate) {
         // Pass as ISO string for messages API
         params.startDate = typeof options.startDate === 'string'
           ? options.startDate
           : new Date(options.startDate).toISOString();
      }

      if (options.endDate) {
          // Pass as ISO string for messages API
          params.endDate = typeof options.endDate === 'string'
            ? options.endDate
            : new Date(options.endDate).toISOString();
      }

      // Contact filter
      if (options.contactId && options.contactId !== 'undefined' && options.contactId.trim()) {
        params.contactId = options.contactId.trim();
      }

      // Conversation filter
      if (options.conversationId && options.conversationId !== 'undefined' && options.conversationId.trim()) {
        params.conversationId = options.conversationId.trim();
      }

      // User filter (one or more) — sent as repeated query: userIds[]=...
      if (Array.isArray(options.userIds) && options.userIds.length > 0) {
        params.userIds = options.userIds.filter(Boolean);
      }

      // Retry on PIT-overload (GHL returns 500 "Search infrastructure is temporarily overloaded...")
      // Why: the user's Search/Export call fails transiently; without retry they have to click again.
      const MAX_ATTEMPTS = 3;
      let lastError;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          return await this.apiRequest(
            'GET',
            '/conversations/messages/export',
            locationId,
            null,
            params,
            0,
            { lite: options.lite }
          );
        } catch (error) {
          lastError = error;
          const msg = error.response?.data?.message || '';
          const isPitOverload = error.response?.status === 500 &&
            (msg.includes('search contexts') || msg.includes('temporarily overloaded'));
          if (!isPitOverload || attempt === MAX_ATTEMPTS) break;
          const delay = 1500 * attempt; // 1.5s, 3s
          logger.warn('PIT overload, retrying exportMessages', { attempt, delay, locationId });
          await new Promise(r => setTimeout(r, delay));
        }
      }
      throw lastError;
    } catch (error) {
      logger.error('Export failed:', error);
      throw error;
    }
  }

  /**
   * Export all messages with automatic pagination
   * Uses max page size (500) to minimize PIT cursor contexts
   * Includes backoff on rate limit errors
   */
  async exportAllMessages(locationId, filters = {}, onProgress = null) {
    const allMessages = [];
    let cursor = null;
    let totalFetched = 0;
    let consecutiveErrors = 0;
    const MAX_CONSECUTIVE_ERRORS = 3;

    try {
      do {
        const options = { ...filters, limit: 500 }; // Max page size to reduce PIT cursors
        if (cursor) options.cursor = cursor;

        try {
          const response = await this.exportMessages(locationId, options);
          consecutiveErrors = 0; // Reset on success

          if (response.messages && response.messages.length > 0) {
            allMessages.push(...response.messages);
            totalFetched += response.messages.length;

            if (onProgress) {
              onProgress(totalFetched, response.total || totalFetched);
            }
          }

          cursor = response.nextCursor || null;

          // Rate limiting: 500ms between pages to avoid PIT context exhaustion
          if (cursor) {
            await new Promise(resolve => setTimeout(resolve, 500));
          }

        } catch (pageError) {
          consecutiveErrors++;

          // If rate limited (429), wait longer and retry the same cursor
          if (pageError.response?.status === 429 && consecutiveErrors <= MAX_CONSECUTIVE_ERRORS) {
            const backoffMs = 2000 * Math.pow(2, consecutiveErrors - 1); // 2s, 4s, 8s
            logger.warn(`⏳ Export pagination rate limited, waiting ${backoffMs}ms before retry (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS})`);
            await new Promise(resolve => setTimeout(resolve, backoffMs));
            continue; // Retry same cursor
          }

          // Max retries exceeded or non-rate-limit error
          throw pageError;
        }

      } while (cursor);

      logger.info(`Export complete: ${totalFetched} messages`);
      return allMessages;

    } catch (error) {
      logger.error('Bulk export failed:', error.message);
      // Return partial results if we have some
      if (allMessages.length > 0) {
        logger.warn(`Returning ${allMessages.length} partial results out of expected total`);
        return allMessages;
      }
      throw error;
    }
  }

  /**
   * Send message
   */
  async sendMessage(locationId, data) {
    return await this.apiRequest(
      'POST',
      '/conversations/messages',
      locationId,
      data
    );
  }

  /**
   * Validate location exists
   * https://marketplace.gohighlevel.com/docs/ghl/locations/get-location
   */
  async validateLocation(locationId) {
    try {
      const response = await this.apiRequest(
        'GET',
        `/locations/${locationId}`,
        locationId
      );
      return !!response.location || !!response;
    } catch (error) {
      logger.error('Location validation failed:', error.message);
      return false;
    }
  }

  /**
   * Upsert contact (create or update)
   * https://marketplace.gohighlevel.com/docs/ghl/contacts/upsert-contact
   */
  async upsertContact(locationId, contactData) {
    try {
      logger.info('Upserting contact', { locationId, email: contactData.email, phone: contactData.phone });
      
      // Add locationId to request body (required by GHL API)
      const requestBody = {
        ...contactData,
        locationId: locationId
      };
      
      const response = await this.apiRequest(
        'POST',
        '/contacts/upsert',
        locationId,
        requestBody
      );

      logger.info('Contact upserted successfully', { contactId: response.contact?.id || response.id });
      return response.contact || response;
    } catch (error) {
      logger.error('Upsert contact failed:', {
        message: error.message,
        status: error.response?.status,
        data: error.response?.data
      });
      throw new Error(`Failed to create contact: ${error.response?.data?.message || error.message}`);
    }
  }

  /**
   * Create a contact (always inserts a new record).
   * https://marketplace.gohighlevel.com/docs/ghl/contacts/create-contact
   *
   * Use this when you want a fresh row per CSV line — duplicates are NOT merged.
   * If you need dedup-by-email/phone, use upsertContact() instead.
   */
  async createContact(locationId, contactData) {
    try {
      const requestBody = { ...contactData, locationId };
      const response = await this.apiRequest('POST', '/contacts/', locationId, requestBody);
      return response.contact || response;
    } catch (error) {
      logger.error('createContact failed:', {
        message: error.message,
        status: error.response?.status,
        data: error.response?.data
      });
      throw new Error(`Failed to create contact: ${error.response?.data?.message || error.message}`);
    }
  }

  /**
   * Create conversation
   * https://marketplace.gohighlevel.com/docs/ghl/conversations/create-conversation
   */
  async createConversation(locationId, conversationData) {
    try {
      logger.info('Creating conversation', { contactId: conversationData.contactId });
      
      const response = await this.apiRequest(
        'POST',
        '/conversations/',
        locationId,
        conversationData
      );

      logger.info('Conversation created successfully', { conversationId: response.conversation?.id || response.id });
      return response.conversation || response;
    } catch (error) {
      logger.error('Create conversation failed:', {
        message: error.message,
        status: error.response?.status,
        data: error.response?.data
      });
      throw new Error(`Failed to create conversation: ${error.response?.data?.message || error.message}`);
    }
  }
  /**
   * Search contacts for a location with pagination
   * GET /contacts/ with startAfterId for cursor-based pagination
   */
  async searchContacts(locationId, options = {}) {
    try {
      const params = {
        locationId,
        limit: options.limit || 100
      };

      if (options.startAfterId) {
        params.startAfterId = options.startAfterId;
      }
      if (options.startAfter) {
        params.startAfter = options.startAfter;
      }
      if (options.query) {
        params.query = options.query;
      }
      if (options.tag) {
        params.tag = options.tag;
      }

      const response = await this.apiRequest(
        'GET',
        '/contacts/',
        locationId,
        null,
        params,
        0,
        { lite: !!options.lite }
      );

      return {
        contacts: response.contacts || [],
        meta: response.meta || {},
        total: response.total || response.meta?.total || response.contacts?.length || 0
      };
    } catch (error) {
      logger.error('Search contacts failed:', error.message);
      throw error;
    }
  }

  /**
   * Advanced contacts search.
   * POST /contacts/search — supports filter expressions and cursor pagination via (startAfter, startAfterId).
   * Reference: https://marketplace.gohighlevel.com/docs/ghl/contacts/search-contacts-advanced
   */
  async searchContactsAdvanced(locationId, options = {}) {
    try {
      const body = {
        locationId,
        pageLimit: Math.min(Math.max(parseInt(options.limit, 10) || 100, 1), 500)
      };

      if (options.startAfter) body.startAfter = options.startAfter;
      if (options.startAfterId) body.startAfterId = options.startAfterId;

      // Build a simple filter array — only include filters the caller provided.
      // Filter shape per GHL docs: { field, operator, value }
      const filters = [];
      if (options.query) {
        body.query = options.query;
      }
      if (options.tag) {
        filters.push({ field: 'tags', operator: 'contains', value: options.tag });
      }
      if (options.assignedTo) {
        filters.push({ field: 'assignedTo', operator: 'eq', value: options.assignedTo });
      }
      if (options.startDate || options.endDate) {
        const range = {};
        if (options.startDate) range.gte = new Date(options.startDate).getTime();
        if (options.endDate) range.lte = new Date(options.endDate).getTime();
        filters.push({ field: 'dateAdded', operator: 'range', value: range });
      }
      if (filters.length) body.filters = filters;

      const response = await this.apiRequest(
        'POST',
        '/contacts/search',
        locationId,
        body
      );

      return {
        contacts: response.contacts || [],
        meta: response.meta || {},
        total: response.total || response.meta?.total || response.contacts?.length || 0
      };
    } catch (error) {
      logger.error('searchContactsAdvanced failed:', error.message);
      throw error;
    }
  }

  /**
   * Create a custom field on a location.
   * POST /locations/:locationId/customFields
   * https://marketplace.gohighlevel.com/docs/ghl/locations/create-custom-field
   */
  async createCustomField(locationId, body) {
    try {
      const response = await this.apiRequest(
        'POST',
        `/locations/${locationId}/customFields`,
        locationId,
        body
      );
      // Response key flips to customFieldFolder when documentType=folder.
      return response.customField || response.customFieldFolder || response;
    } catch (error) {
      logger.error('createCustomField failed:', { locationId, error: error.response?.data || error.message });
      throw error;
    }
  }

  /**
   * Create a custom value on a location.
   * POST /locations/:locationId/customValues
   * https://marketplace.gohighlevel.com/docs/ghl/locations/create-custom-value
   */
  async createCustomValue(locationId, body) {
    try {
      const response = await this.apiRequest(
        'POST',
        `/locations/${locationId}/customValues`,
        locationId,
        body
      );
      return response.customValue || response;
    } catch (error) {
      logger.error('createCustomValue failed:', { locationId, error: error.response?.data || error.message });
      throw error;
    }
  }

  /**
   * List tags for a location.
   * GET /locations/:locationId/tags
   * No query params, no pagination — returns the full list sorted by name asc.
   * https://marketplace.gohighlevel.com/docs/ghl/locations/get-location-tags
   */
  async getLocationTags(locationId) {
    try {
      const response = await this.apiRequest(
        'GET',
        `/locations/${locationId}/tags`,
        locationId
      );
      const tags = response.tags || [];
      return { tags, total: tags.length };
    } catch (error) {
      logger.error('getLocationTags failed:', { locationId, error: error.message });
      throw error;
    }
  }

  /**
   * List custom values for a location.
   * GET /locations/:locationId/customValues
   * documentType: 'document' (default — values only) | 'folder' | 'all'
   * Note: when documentType=folder the GHL response key flips to `customValueFolders`.
   * https://marketplace.gohighlevel.com/docs/ghl/locations/get-custom-values
   */
  async getCustomValues(locationId, documentType = 'all') {
    try {
      const response = await this.apiRequest(
        'GET',
        `/locations/${locationId}/customValues`,
        locationId,
        null,
        { documentType }
      );
      const items = response.customValues || response.customValueFolders || [];
      return { customValues: items, total: items.length };
    } catch (error) {
      logger.error('getCustomValues failed:', { locationId, documentType, error: error.message });
      throw error;
    }
  }

  /**
   * List custom fields for a location.
   * GET /locations/:locationId/customFields
   * model: 'contact' | 'opportunity' | 'all' | 'custom_objects.<key>' (defaults to 'contact' server-side)
   * https://marketplace.gohighlevel.com/docs/ghl/locations/get-custom-fields
   */
  async getCustomFields(locationId, model = 'all') {
    try {
      const response = await this.apiRequest(
        'GET',
        `/locations/${locationId}/customFields`,
        locationId,
        null,
        { model }
      );
      return {
        customFields: response.customFields || response.fields || [],
        total: (response.customFields || response.fields || []).length
      };
    } catch (error) {
      logger.error('getCustomFields failed:', { locationId, model, error: error.message });
      throw error;
    }
  }

  /**
   * Get all notes for a contact
   * GET /contacts/:contactId/notes
   */
  async getContactNotes(locationId, contactId) {
    try {
      const response = await this.apiRequest(
        'GET',
        `/contacts/${contactId}/notes`,
        locationId
      );

      return {
        notes: response.notes || [],
        total: response.notes?.length || 0
      };
    } catch (error) {
      logger.error('Get contact notes failed:', { contactId, error: error.message });
      throw error;
    }
  }

  /**
   * Create a note for a contact
   * POST /contacts/:contactId/notes
   * https://marketplace.gohighlevel.com/docs/ghl/contacts/create-note
   */
  async createNote(locationId, contactId, { body, userId }) {
    try {
      const requestBody = { body };
      if (userId) requestBody.userId = userId;
      const response = await this.apiRequest(
        'POST',
        `/contacts/${contactId}/notes`,
        locationId,
        requestBody
      );
      return response.note || response;
    } catch (error) {
      logger.error('Create note failed:', {
        contactId,
        status: error.response?.status,
        message: error.response?.data?.message || error.message
      });
      throw new Error(`Failed to create note: ${error.response?.data?.message || error.message}`);
    }
  }

  /**
   * Get all tasks for a contact
   * GET /contacts/:contactId/tasks
   */
  async getContactTasks(locationId, contactId) {
    try {
      const response = await this.apiRequest(
        'GET',
        `/contacts/${contactId}/tasks`,
        locationId
      );

      return {
        tasks: response.tasks || [],
        total: response.tasks?.length || 0
      };
    } catch (error) {
      logger.error('Get contact tasks failed:', { contactId, error: error.message });
      throw error;
    }
  }
  /**
   * Search users for a company
   * GET /users/search
   */
  async searchUsers(locationId, options = {}) {
    try {
      const response = await this.apiRequest(
        'GET',
        '/users/search',
        locationId,
        null,
        { companyId: options.companyId, locationId:locationId, query: options.query || '' },
        0,
        { lite: !!options.lite }
      );
      return response.users || [];
    } catch (error) {
      logger.error('Search users failed:', { locationId, error: error.message });
      throw error;
    }
  }


  /**
   * Search tasks for a location
   * GET /locations/:locationId/tasks
   */
  async getLocationTasks(locationId, options = {}) {
    try {
      const body = {
        limit: options.limit || 20,
        skip: options.skip || 0,
        count: true,
      };

      // contactId is always an array in the API
      if (options.contactIds && options.contactIds.length > 0) {
        body.contactId = options.contactIds;
      }
      if (options.assignedTo && options.assignedTo.length > 0) body.assignedTo = options.assignedTo;
      if (nonNullValue(options.unAssigned)) body.unAssigned = options.unAssigned;
      if (nonNullValue(options.completed)) body.completed = options.completed;
      if (nonNullValue(options.overdue)) body.overdue = options.overdue;
      if (options.query) body.query = options.query;
      // dueDate filter: { gt, lte }
      if (options.dueDate) body.dueDate = options.dueDate;
      if (options.sortKey) body.sortKey = options.sortKey;
      if (nonNullValue(options.sortDirection)) body.sortDirection = options.sortDirection;
      // cursor-based pagination
      if (options.searchAfter && options.searchAfter.length > 0) body.searchAfter = options.searchAfter;
      if(options.businessId){
        body.businessId = options.businessId;
      }
      const response = await this.apiRequest(
        'POST',
        `/locations/${locationId}/tasks/search`,
        locationId,
        body
      );

      return {
        tasks: response.tasks || [],
        total: response.count || response.total || 0
      };
    } catch (error) {
      logger.error('Get location tasks failed:', { locationId, error: error.message });
      throw error;
    }
  }

  /**
   * Search opportunities for a location
   * POST /opportunities/search — supports filters array, sort, searchAfter cursor pagination
   */
  async searchOpportunities(locationId, options = {}) {
    try {
      const body = {
        locationId,
        limit: options.limit || 20
      };

      // Pagination: cursor-based (searchAfter) or page-based
      if (options.searchAfter && options.searchAfter.length > 0) {
        body.searchAfter = options.searchAfter;
      } else if (options.page) {
        body.page = options.page;
      }

      if (options.query) body.query = options.query;

      // Build filters array from named options
      const filters = [];
      if (options.pipelineId) filters.push({ field: 'pipeline_id', operator: 'eq', value: options.pipelineId });
      if (options.pipelineStageId) filters.push({ field: 'pipeline_stage_id', operator: 'eq', value: options.pipelineStageId });
      if (options.status) filters.push({ field: 'status', operator: 'eq', value: options.status });
      if (options.assignedTo) filters.push({ field: 'assigned_to', operator: 'eq', value: options.assignedTo });
      if (options.contactId) filters.push({ field: 'contact_id', operator: 'eq', value: options.contactId });
      if (options.contactName) filters.push({ field: 'contact_name', operator: 'contains', value: options.contactName });

      // Monetary value range
      if (nonNullValue(options.monetaryValueMin) || nonNullValue(options.monetaryValueMax)) {
        const range = {};
        if (nonNullValue(options.monetaryValueMin)) range.gte = Number(options.monetaryValueMin);
        if (nonNullValue(options.monetaryValueMax)) range.lte = Number(options.monetaryValueMax);
        if (Object.keys(range).length > 0) filters.push({ field: 'monetary_value', operator: 'range', value: range });
      }

      // Date added range — accepts ms timestamp or ISO string
      if (options.startDate || options.endDate) {
        const range = {};
        if (options.startDate) range.gte = new Date(options.startDate).getTime();
        if (options.endDate) range.lte = new Date(options.endDate).getTime();
        filters.push({ field: 'date_added', operator: 'range', value: range });
      }

      if (filters.length > 0) body.filters = filters;

      // Sort
      if (options.sortField) {
        body.sort = [{ field: options.sortField, direction: options.sortDirection || 'desc' }];
      }

      const response = await this.apiRequest('POST', '/opportunities/search', locationId, body);

      return {
        opportunities: response.opportunities || [],
        total: response.total || 0,
        searchAfter: response.searchAfter || null
      };
    } catch (error) {
      logger.error('Search opportunities failed:', error.message);
      throw error;
    }
  }

  /**
   * Get all pipelines for a location
   * GET /opportunities/pipelines
   */
  async getPipelines(locationId) {
    try {
      const response = await this.apiRequest(
        'GET',
        '/opportunities/pipelines',
        locationId,
        null,
        { locationId }
      );

      return {
        pipelines: response.pipelines || []
      };
    } catch (error) {
      logger.error('Get pipelines failed:', error.message);
      throw error;
    }
  }

  /**
   * Get form submissions for a location
   * GET /forms/submissions
   */
  async getFormSubmissions(locationId, options = {}) {
    try {
      const params = {
        locationId,
        limit: options.limit || 100,
        page: options.page || 1
      };

      if (options.formId) params.formId = options.formId;
      if (options.q) params.q = options.q;
      if (options.startAt) params.startAt = options.startAt;
      if (options.endAt) params.endAt = options.endAt;

      const response = await this.apiRequest(
        'GET',
        '/forms/submissions',
        locationId,
        null,
        params
      );

      return {
        submissions: response.submissions || [],
        meta: response.meta || {},
        total: response.meta?.total || 0
      };
    } catch (error) {
      logger.error('Get form submissions failed:', error.message);
      throw error;
    }
  }

  /**
   * Get all forms for a location
   * GET /forms/
   */
  async getForms(locationId) {
    try {
      const params = {
        locationId,
        limit: 50
      };

      const response = await this.apiRequest(
        'GET',
        '/forms/',
        locationId,
        null,
        params
      );

      return {
        forms: response.forms || [],
        total: response.total || 0
      };
    } catch (error) {
      logger.error('Get forms failed:', error.message);
      throw error;
    }
  }

  /**
   * Search trigger links for a location
   * GET /links/search — supports query, limit, skip
   */
  async getLinks(locationId, options = {}) {
    try {
      const params = {
        locationId,
        limit: options.limit || 25,
        skip: options.skip || 0
      };
      if (options.query) params.query = options.query;

      const response = await this.apiRequest('GET', '/links/search', locationId, null, params);

      return {
        links: response.links || [],
        total: response.totalCount || response.links?.length || 0
      };
    } catch (error) {
      logger.error('Get links failed:', error.message);
      throw error;
    }
  }

  /**
   * Get social media posts for a location
   * POST /social-media-posting/{locationId}/posts/list
   */
  async getSocialPosts(locationId, options = {}) {
    try {
      const body = {};
      if (options.type) body.type = options.type;
      if (options.status) body.status = options.status;
      if (options.accountIds) body.accountIds = options.accountIds;
      if (options.limit) body.limit = options.limit;
      if (options.startAfter) body.startAfter = options.startAfter;

      const response = await this.apiRequest(
        'POST',
        `/social-media-posting/${locationId}/posts/list`,
        locationId,
        body,
        null
      );

      const posts = response.posts || response.data || [];
      return {
        posts,
        total: response.total || posts.length || 0
      };
    } catch (error) {
      logger.error('Get social posts failed:', error.message);
      throw error;
    }
  }
  /**
   * Get templates for a location
   * GET /locations/{locationId}/templates
   */
  async getTemplates(locationId, options = {}) {
    try {
      const params = {
        limit: String(options.limit || 25),
        skip: String(options.skip || 0),
        deleted: false
      };
      if (options.type) params.type = options.type;

      const response = await this.apiRequest(
        'GET',
        `/locations/${locationId}/templates`,
        locationId,
        null,
        params
      );

      return {
        templates: response.templates || [],
        total: response.totalCount || 0
      };
    } catch (error) {
      logger.error('Get templates failed:', error.message);
      throw error;
    }
  }

  /**
   * Get voice AI call logs for a location
   * GET /voice-ai/dashboard/call-logs
   * Note: Uses Version header 2021-04-15
   */
  async getCallLogs(locationId, options = {}) {
    try {
      const params = {
        locationId,
        page: options.page || 1,
        pageSize: options.pageSize || 50
      };

      if (options.agentId) params.agentId = options.agentId;
      if (options.contactId) params.contactId = options.contactId;
      if (options.callType) params.callType = options.callType;
      if (options.direction) params.direction = options.direction;
      if (options.startDate) params.startDate = options.startDate;
      if (options.endDate) params.endDate = options.endDate;
      if (options.actionType) params.actionType = options.actionType;
      if (options.sortBy) params.sortBy = options.sortBy;
      if (options.sort) params.sort = options.sort;

      // Voice AI uses a different API version header
      const accessToken = await this.getValidToken(locationId);
      const response = await axios({
        method: 'GET',
        url: `${this.baseURL}/voice-ai/dashboard/call-logs`,
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'Version': '2021-04-15'
        },
        params
      });

      return {
        callLogs: response.data?.callLogs || [],
        total: response.data?.total || 0,
        page: response.data?.page || 1,
        pageSize: response.data?.pageSize || 100
      };
    } catch (error) {
      logger.error('Get call logs failed:', error.message);
      throw error;
    }
  }
  /**
   * Get voice AI agents for a location
   * GET /voice-ai/agents
   */
  async getVoiceAIAgents(locationId) {
    try {
      const accessToken = await this.getValidToken(locationId);
      const response = await axios({
        method: 'GET',
        url: `${this.baseURL}/voice-ai/agents`,
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'Version': '2021-04-15'
        },
        params: { locationId }
      });

      return {
        agents: response.data?.agents || response.data?.data || [],
      };
    } catch (error) {
      logger.error('Get voice AI agents failed:', error.message);
      throw error;
    }
  }
}

module.exports = new GHLService();

