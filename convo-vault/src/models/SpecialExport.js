const mongoose = require('mongoose');

/**
 * SpecialExport — stores pre-fetched messages for specialTabMessages exports.
 *
 * Flow:
 *   1. Backend fetches all conversations + messages via GHL API
 *   2. Saves them here grouped by exportJobId + locationId
 *   3. Lambda reads from this collection instead of calling GHL API again
 */
const specialExportSchema = new mongoose.Schema({
  exportJobId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ExportJob',
    required: false,
    index: true
  },
  locationId: {
    type: String,
    required: true,
    index: true
  },
  // For chunked exports: all chunk docs share the same groupId (= _id of chunk 0)
  groupId: {
    type: mongoose.Schema.Types.ObjectId,
    default: null,
    index: true
  },
  chunkIndex: {
    type: Number,
    default: 0
  },
  totalChunks: {
    type: Number,
    default: 1
  },
  messages: {
    type: [mongoose.Schema.Types.Mixed],
    default: []
  },
  // Dedicated field for the callTranscriptions export type — keeps these distinct from the
  // specialTabMessages records that live under `messages` and removes any naming ambiguity.
  callTranscriptionsMessages: {
    type: [mongoose.Schema.Types.Mixed],
    default: []
  },
  // Dedicated field for the callRecordings export type (recording URL per call).
  callRecordingsMessages: {
    type: [mongoose.Schema.Types.Mixed],
    default: []
  },
  totalMessages: {
    type: Number,
    default: 0
  },
  totalConversations: {
    type: Number,
    default: 0
  },
  // Opportunity Stage History pricing inputs. We bill (opps + messages), not stage-rows,
  // so the confirm-step needs both counts persisted from /estimate to re-derive the charge
  // without re-walking GHL.
  totalOpportunities: {
    type: Number,
    default: 0
  },
  totalChannelMessages: {
    type: Number,
    default: 0
  },
  // Custom-field column schema for the Opportunity Stage History export. The Lambda emits one CSV
  // column per field, and headers must be known up-front (chunk 0 writes the header before any rows
  // are seen), so we persist the canonical list here at /estimate time. Empty arrays for export
  // types that don't use this.
  contactCustomFieldNames: {
    type: [String],
    default: []
  },
  opportunityCustomFieldNames: {
    type: [String],
    default: []
  },
  // Per-category counts for the `contactBundle` export type. We bill three separate rates
  // (SMS $0.02 / Email $0.04 / Call $0.05) so the confirm step needs the breakdown persisted.
  contactBundleSmsCount: {
    type: Number,
    default: 0
  },
  contactBundleEmailCount: {
    type: Number,
    default: 0
  },
  contactBundleCallCount: {
    type: Number,
    default: 0
  },
  filters: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  status: {
    type: String,
    enum: ['fetching', 'ready', 'exported', 'failed'],
    default: 'fetching'
  },
  errorMessage: {
    type: String,
    default: null
  },
  // True when this belongs to the "Export Messages" (lite) app. Segregates lite vs premium.
  lite: {
    type: Boolean,
    default: false,
    index: true
  }
}, { timestamps: true });

// TTL: auto-delete 5 hours after createdAt. MongoDB's background TTL monitor removes expired
// docs automatically (runs ~every 60s), so no cron is needed.
specialExportSchema.index({ createdAt: 1 }, { expireAfterSeconds: 5 * 60 * 60 });

module.exports = mongoose.model('SpecialExport', specialExportSchema);
