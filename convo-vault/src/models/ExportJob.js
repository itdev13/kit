const mongoose = require('mongoose');

/**
 * Export Job Model - Track async export progress with batch processing
 * Supports processing millions of records through Lambda chaining
 */
const exportJobSchema = new mongoose.Schema({
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

  // Reference to billing transaction
  billingTransactionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'BillingTransaction',
    required: true
  },

  // Export type: conversations, messages, notes, or tasks
  exportType: {
    type: String,
    enum: ['conversations', 'messages', 'notes', 'tasks', 'opportunities', 'formSubmissions', 'links', 'socialPosts', 'callLogs', 'templates', 'specialTabMessages', 'callTranscriptions', 'contacts', 'customFields', 'customValues', 'tags', 'opportunityStageHistory', 'contactBundle', 'messagesByTag', 'groupMessages', 'internalMessages'],
    required: true
  },

  // Output format
  format: {
    type: String,
    enum: ['csv', 'json'],
    default: 'csv'
  },

  // Export filters (supports both messages and conversations)
  filters: {
    // Common filters
    channel: { type: String, default: null },
    startDate: { type: Date, default: null },
    endDate: { type: Date, default: null },
    contactId: { type: String, default: null },
    // Notes/Tasks multi-contact export
    contactIds: { type: [String], default: [] },
    // Messages export: filter by GHL user(s)
    userIds: { type: [String], default: [] },
    // Conversation-specific filters
    query: { type: String, default: null },
    id: { type: String, default: null },
    conversationId: { type: String, default: null },
    lastMessageType: { type: String, default: null },
    lastMessageDirection: { type: String, default: null },
    status: { type: String, default: null },
    lastMessageAction: { type: String, default: null },
    sortBy: { type: String, default: null },
    // Opportunity-specific filters
    pipelineId: { type: String, default: null },
    pipelineStageId: { type: String, default: null },
    assignedTo: { type: [String], default: null },
    monetaryValueMin: { type: Number, default: null },
    monetaryValueMax: { type: Number, default: null },
    sortKey: { type: String, default: null },
    sortDirection: { type: Number, default: null },
    contactName: { type: String, default: null },
    // Form submission-specific filters
    formId: { type: String, default: null },
    // Template-specific filters
    templateType: { type: String, default: null },
    // Call log-specific filters
    agentId: { type: String, default: null },
    callType: { type: String, default: null },
    actionType: { type: String, default: null },
    direction: { type: String, default: null },
    callSortBy: { type: String, default: null },
    callSort: { type: String, default: null },
    // Notes/Tasks contact name lookup map { contactId: "Name" }
    contactNames: { type: mongoose.Schema.Types.Mixed, default: null },
    // Notes contact meta map { contactId: { email, phone } } — for enriched CSV export
    contactsMeta: { type: mongoose.Schema.Types.Mixed, default: null },
    // Task-specific filters
    dueDate: {
      gt: { type: String, default: null },
      lte: { type: String, default: null }
    },
    businessId: { type: String, default: null },
    completed: { type: Boolean, default: null },
    overdue: { type: Boolean, default: null },
    unAssigned: { type: Boolean, default: null },
    // Tag filter for notes export
    tags: { type: String, default: null }
  },

  // Progress tracking
  totalItems: {
    type: Number,
    default: 0
  },

  processedItems: {
    type: Number,
    default: 0
  },

  // ============ BATCH PROCESSING FIELDS ============

  // Batch configuration
  batchSize: {
    type: Number,
    default: 10000  // Records per Lambda invocation
  },

  currentBatch: {
    type: Number,
    default: 0
  },

  totalBatches: {
    type: Number,
    default: 0
  },

  // Pagination cursor (save between Lambda invocations for resume)
  cursor: {
    type: String,
    default: null
  },

  // Contact iteration cursor (for notes/tasks exports - tracks last processed contact index)
  contactCursor: {
    type: Number,
    default: 0
  },

  // S3 Multipart Upload tracking
  s3Upload: {
    uploadId: { type: String, default: null },
    bucket: { type: String, default: null },
    key: { type: String, default: null },
    parts: [{
      partNumber: Number,
      etag: String,
      size: Number
    }]
  },

  // Resume & retry capability
  lastProcessedAt: {
    type: Date,
    default: null
  },

  retryCount: {
    type: Number,
    default: 0
  },

  maxRetries: {
    type: Number,
    default: 3
  },

  // ============ END BATCH PROCESSING FIELDS ============

  // Job status
  status: {
    type: String,
    enum: ['pending', 'processing', 'completed', 'failed', 'paused'],
    default: 'pending'
  },

  // Final S3 output (after multipart complete)
  s3Key: {
    type: String,
    default: null
  },

  s3Bucket: {
    type: String,
    default: null
  },

  downloadUrl: {
    type: String,
    default: null
  },

  downloadUrlExpiresAt: {
    type: Date,
    default: null
  },

  // Secret token for the public email download link (/billing/download-email/:jobId?token=…).
  // Email links can't carry a session token, so this random token authorizes the redirect.
  downloadToken: {
    type: String,
    default: null
  },

  // Email notification
  notificationEmail: {
    type: String,
    default: null
  },

  emailSent: {
    type: Boolean,
    default: false
  },

  // Lambda execution reference
  lambdaRequestId: {
    type: String,
    default: null
  },

  // Error tracking
  errorMessage: {
    type: String,
    default: null
  },

  // Timing
  startedAt: {
    type: Date,
    default: null
  },

  completedAt: {
    type: Date,
    default: null
  },

  // Post-export billing: charge after Lambda based on actual count (notes/tasks all-contacts)
  postExportBilling: {
    type: Boolean,
    default: false
  },

  // User who initiated
  userId: {
    type: String,
    default: null
  },

  // True when this export belongs to the "Export Messages" (lite) app. Segregates lite vs
  // premium export data in the shared DB.
  lite: {
    type: Boolean,
    default: false,
    index: true
  }

}, {
  timestamps: true
});

// Compound index for queries
exportJobSchema.index({ locationId: 1, createdAt: -1 });
exportJobSchema.index({ status: 1, createdAt: -1 });
exportJobSchema.index({ status: 1, lastProcessedAt: 1 }); // For finding stale jobs

// Get recent jobs for a location
exportJobSchema.statics.getRecentJobs = async function(locationId, limit = 10) {
  return await this.find({ locationId })
    .sort({ createdAt: -1 })
    .limit(limit)
    .populate('billingTransactionId');
};

// Get active (pending/processing) jobs for a location
exportJobSchema.statics.getActiveJobs = async function(locationId) {
  return await this.find({
    locationId,
    status: { $in: ['pending', 'processing'] }
  }).sort({ createdAt: -1 });
};

// Update job progress (called by Lambda)
exportJobSchema.statics.updateProgress = async function(jobId, updates) {
  return await this.findByIdAndUpdate(
    jobId,
    {
      $set: {
        ...updates,
        lastProcessedAt: new Date()
      }
    },
    { new: true }
  );
};

// Find stale jobs (processing but no update for 30 minutes)
exportJobSchema.statics.findStaleJobs = async function() {
  const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);
  return await this.find({
    status: 'processing',
    lastProcessedAt: { $lt: thirtyMinutesAgo }
  });
};

// Calculate progress percentage
exportJobSchema.methods.getProgressPercent = function() {
  if (this.totalItems === 0) return 0;
  return Math.round((this.processedItems / this.totalItems) * 100);
};

module.exports = mongoose.model('ExportJob', exportJobSchema);
