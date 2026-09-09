const mongoose = require('mongoose');

/**
 * Simple OAuth Token Model
 */
const oauthTokenSchema = new mongoose.Schema({
  locationId: {
    type: String,
    required: false, // Not required for company-level tokens
    index: true
  },
  
  companyId: {
    type: String,
    required: true,
    index: true
  },

  // Token type: 'location' or 'company'
  tokenType: {
    type: String,
    enum: ['location', 'company'],
    required: true,
    default: 'location'
  },

  // Sub-Account metadata
  locationName: {
    type: String,
    default: null
  },

  locationEmail: {
    type: String,
    default: null
  },

  locationPhone: {
    type: String,
    default: null
  },

  locationAddress: {
    type: String,
    default: null
  },

  locationWebsite: {
    type: String,
    default: null
  },

  locationTimezone: {
    type: String,
    default: null
  },

  accessToken: {
    type: String,
    required: true
  },

  refreshToken: {
    type: String,
    required: true
  },

  expiresAt: {
    type: Date,
    required: true
  },

  isActive: {
    type: Boolean,
    default: true
  },

  // App scope: false/missing = premium ("ExportKit"), true = lite ("Export Messages").
  // Legacy prod docs have NO lite field — premium lookups MUST match those via `lite: { $ne: true }`
  // (never `lite: false` equality). Lite and premium tokens for the same location are SEPARATE rows.
  lite: { type: Boolean, default: false, index: true }
}, {
  timestamps: true
});

// Check if token needs refresh (expires in < 5 minutes)
oauthTokenSchema.methods.needsRefresh = function() {
  const fiveMinutesFromNow = new Date(Date.now() + 5 * 60 * 1000);
  return fiveMinutesFromNow >= this.expiresAt;
};

// Find active token for sub-account.
// opts.lite === true → only lite rows; otherwise premium (lite false OR missing → `$ne: true`).
oauthTokenSchema.statics.findActiveToken = async function(locationId, opts = {}) {
  return await this.findOne({
    locationId,
    isActive: true,
    ...(opts.lite ? { lite: true } : { lite: { $ne: true } })
  });
};

// Find active company token. Same lite-scoping rule as findActiveToken.
oauthTokenSchema.statics.findActiveCompanyToken = async function(companyId, opts = {}) {
  return await this.findOne({
    companyId,
    tokenType: 'company',
    isActive: true,
    ...(opts.lite ? { lite: true } : { lite: { $ne: true } })
  });
};

// Find all sub-account tokens for a company
oauthTokenSchema.statics.findCompanyLocations = async function(companyId) {
  return await this.find({ 
    companyId,
    tokenType: 'location',
    isActive: true 
  });
};

module.exports = mongoose.model('OAuthToken', oauthTokenSchema);

