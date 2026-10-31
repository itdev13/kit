const mongoose = require('mongoose');

/**
 * Per-tab app-version gate. OPT-IN: only tabs that have a row here are gated.
 *
 * When you ship NEW tab(s) that require a newer marketplace app version, add a row (tabIds is a
 * LIST — one row can gate several tabs shipped by the same version):
 *   { tabIds: ['tabA', 'tabB'], requiredVersionId: '<the versionId that ships them>', forceUpdate: true }
 *
 * At render time the UI checks the location's installed Installation.versionId against the tab's
 * requiredVersionId. If they are NOT equal, the tab shows an "update the app" message instead of its
 * content (the tab stays visible/clickable — the gate happens when the tab is opened).
 *
 * EXISTING tabs are never affected: a tab with no row here is always shown normally. Seed rows
 * yourself (admin endpoint or directly in Mongo) only for new tabs that need the gate.
 */
const tabVersionRequirementSchema = new mongoose.Schema(
  {
    // The Dashboard tab ids gated by this rule (e.g. ['callRecordings', 'contactBundleDoc']).
    // One rule can cover several tabs that a single app version shipped together.
    tabIds: { type: [String], required: true, index: true },
    // The marketplace versionId the user must be on to use these tabs. Compared with `!==`.
    requiredVersionId: { type: String, required: true },
    // true  → fully gate: show the upgrade message instead of the tab.
    // false → soft: tab still works, but the UI may show an upgrade hint (UI decides).
    forceUpdate: { type: Boolean, default: true },
    // Optional note shown in the upgrade message / for your own reference.
    reason: { type: String, default: null }
  },
  { timestamps: true }
);

module.exports = mongoose.model('TabVersionRequirement', tabVersionRequirementSchema);
