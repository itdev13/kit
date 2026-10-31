/**
 * API Configuration Constants
 * Centralized API URLs for the application
 */

// Backend API Base URL
export const API_BASE_URL = 'https://convoapi.vaultsuite.store';

// API Endpoints
export const API_URL = `${API_BASE_URL}/api`;

// Frontend URL (for redirects)
export const FRONTEND_URL = 'https://convo.vaultsuite.store';

// This app's GHL marketplace integration id.
export const GHL_APP_ID = '694f93f8a6babf0c821b1356';

// Marketplace host to send a user to for install / reconnect / update. On a white-label (agency)
// account the customer's marketplace lives on the agency's OWN domain, not marketplace.gohighlevel.com.
// We run inside GHL's iframe, so the embedding (parent) page's host IS that white-label domain — read
// it from the referring origin, and fall back to the public marketplace when it isn't available
// (e.g. the page was opened directly, outside the iframe). Only an https host is accepted.
export function getMarketplaceHost() {
  try {
    const ref = typeof document !== 'undefined' ? document.referrer : '';
    if (ref) {
      const u = new URL(ref);
      if (u.protocol === 'https:' && u.hostname) return u.hostname;
    }
  } catch { /* ignore and fall back */ }
  return 'marketplace.gohighlevel.com';
}

// Full marketplace integration URL, white-label aware. Pass a versionId to deep-link to the exact
// version to update to (used by the per-tab "Update the app" gate).
export function buildMarketplaceUrl(versionId) {
  const base = `https://${getMarketplaceHost()}/integration/${GHL_APP_ID}`;
  return versionId ? `${base}/versions/${versionId}` : base;
}

// OAuth Endpoints
export const OAUTH_AUTHORIZE_URL = `https://marketplace.gohighlevel.com/integration/694f93f8a6babf0c821b1356/versions/694f93f8a6babf0c821b1356`;

// API Documentation URL
export const API_DOCS_BASE_URL = `${API_BASE_URL}/api/docs`;

