const mongoose = require('mongoose');

/**
 * Installation Schema
 * Stores app installation and uninstallation data from GHL webhooks
 */
const installationSchema = new mongoose.Schema({
  // Installation type
  type: {
    type: String,
    enum: ['INSTALL', 'UNINSTALL'],
    required: true
  },
  
  // App details
  appId: {
    type: String,
    required: true,
    index: true
  },

  // Marketplace app version the location installed/updated to (from the INSTALL/UPDATE webhook).
  // Used by the per-tab upgrade gate: a new tab can require a specific versionId, and locations on
  // a different versionId are shown an "update the app" message when they open that tab.
  versionId: {
    type: String,
    default: null,
    index: true
  },
  
  // Company/Location details
  companyId: {
    type: String,
    index: true
  },
  
  locationId: {
    type: String,
    index: true
  },
  
  userId: {
    type: String,
    index: true
  },
  
  // Plan details
  planId: {
    type: String
  },
  
  // Trial information
  trial: {
    onTrial: {
      type: Boolean,
      default: false
    },
    trialDuration: {
      type: Number
    },
    trialStartDate: {
      type: Date
    }
  },
  
  // Whitelabel information
  isWhitelabelCompany: {
    type: Boolean,
    default: false
  },
  
  whitelabelDetails: {
    domain: {
      type: String
    },
    logoUrl: {
      type: String
    }
  },
  
  companyName: {
    type: String
  },

  // Referral tracking
  referralCode: {
    type: String,
    default: null
  },

  // Installation status
  status: {
    type: String,
    enum: ['active', 'uninstalled'],
    default: 'active',
    index: true
  },
  
  // Timestamps
  installedAt: {
    type: Date
  },
  
  uninstalledAt: {
    type: Date
  },
  
  // Raw webhook data (for debugging)
  rawWebhookData: {
    type: mongoose.Schema.Types.Mixed
  },

  // True when this record belongs to the "Export Messages" (lite) app rather than premium
  // convoVault. Used to segregate installs/exports/billing per app in the shared DB.
  lite: {
    type: Boolean,
    default: false,
    index: true
  }

}, {
  timestamps: true
});

// Index for querying active installations
installationSchema.index({ companyId: 1, locationId: 1, status: 1 });
installationSchema.index({ appId: 1, status: 1 });

// Virtual for installation duration
installationSchema.virtual('installationDuration').get(function() {
  if (this.installedAt && this.uninstalledAt) {
    return Math.floor((this.uninstalledAt - this.installedAt) / 1000 / 60 / 60 / 24); // days
  }
  return null;
});

module.exports = mongoose.model('Installation', installationSchema);

