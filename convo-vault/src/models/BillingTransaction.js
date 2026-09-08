const mongoose = require('mongoose');

/**
 * Billing Transaction Model - Track export charges via GHL Marketplace billing
 */
const billingTransactionSchema = new mongoose.Schema({
  locationId: {
    type: String,
    required: true,
    index: true
  },

  companyId: {
    type: String,
    required: true,
    index: true
  },

  // Transaction type
  type: {
    type: String,
    enum: ['export_conversations', 'export_messages', 'export_notes', 'export_tasks', 'export_opportunities', 'export_formSubmissions', 'export_links', 'export_socialPosts', 'export_callLogs', 'export_templates', 'export_specialTabMessages', 'export_callTranscriptions', 'export_contacts', 'export_customFields', 'export_customValues', 'export_tags', 'export_opportunityStageHistory', 'export_contactBundle', 'export_messagesByTag', 'export_groupMessages', 'export_internalMessages', 'custom_charge', 'import_notes', 'import_contacts', 'import_custom_fields', 'import_custom_values'],
    required: true
  },

  // GHL Billing charge ID(s) - comma separated if multiple meters charged
  ghlChargeId: {
    type: String,
    default: null
  },

  // Reference to the export job
  exportJobId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ExportJob',
    default: null
  },

  // Item counts for billing
  itemCounts: {
    conversations: { type: Number, default: 0 },
    smsMessages: { type: Number, default: 0 },
    whatsappMessages: { type: Number, default: 0 },
    emailMessages: { type: Number, default: 0 },
    notes: { type: Number, default: 0 },
    tasks: { type: Number, default: 0 },
    opportunities: { type: Number, default: 0 },
    formSubmissions: { type: Number, default: 0 },
    links: { type: Number, default: 0 },
    socialPosts: { type: Number, default: 0 },
    callLogs: { type: Number, default: 0 },
    templates: { type: Number, default: 0 },
    total: { type: Number, default: 0 }
  },

  // Pricing breakdown (all amounts in cents)
  pricing: {
    baseAmount: { type: Number, required: true },
    discountPercent: { type: Number, default: 0 },
    discountAmount: { type: Number, default: 0 },
    finalAmount: { type: Number, required: true }
  },

  // Meter charges sent to GHL
  meterCharges: [{
    meterId: String,
    qty: Number,
    description: String
  }],

  // Transaction status
  status: {
    type: String,
    enum: ['pending', 'charged', 'failed', 'refunded', 'tested', 'deferred'],
    default: 'pending'
  },

  // Error message if failed
  errorMessage: {
    type: String,
    default: null
  },

  // User who initiated the transaction
  userId: {
    type: String,
    default: null
  },

  // Internal testing - payment was skipped
  internalTesting: {
    type: Boolean,
    default: false
  },

  paymentIgnored: {
    type: Boolean,
    default: false
  },

  // Referral code if installed via referral
  referralCode: {
    type: String,
    default: null,
    index: true
  },

  // True when this charge belongs to the "Export Messages" (lite) app. Segregates lite vs
  // premium billing in the shared DB (lite charges also bill the lite GHL marketplace app).
  lite: {
    type: Boolean,
    default: false,
    index: true
  }

}, {
  timestamps: true
});

// Compound indexes for common queries
billingTransactionSchema.index({ locationId: 1, createdAt: -1 });
billingTransactionSchema.index({ companyId: 1, status: 1, createdAt: -1 });

// Get recent transactions for a location
billingTransactionSchema.statics.getRecentTransactions = async function(locationId, limit = 20) {
  return await this.find({ locationId })
    .sort({ createdAt: -1 })
    .limit(limit);
};

// Get transactions by status
billingTransactionSchema.statics.getByStatus = async function(locationId, status) {
  return await this.find({ locationId, status })
    .sort({ createdAt: -1 });
};

module.exports = mongoose.model('BillingTransaction', billingTransactionSchema);
