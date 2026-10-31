/**
 * Per-tab app-version gate — the SINGLE source of truth for which tabs require a specific app version.
 *
 * HOW IT WORKS
 *   Each entry below gates ONE tab. At render time the UI compares the location's installed
 *   Installation.versionId against `requiredVersionId` (exact `!==` check). If they differ, the tab
 *   shows an "Update the app" message instead of its content. Tabs NOT listed here are never gated —
 *   all existing tabs keep working untouched.
 *
 *   The new token with the new OAuth scopes is issued when the customer re-authorizes (updates the
 *   app in the GHL Marketplace / clicks "Update the app"): GHL's OAuth callback overwrites the stored
 *   token with a fresh one carrying the new scopes, and the UPDATE webhook bumps Installation.versionId
 *   so the gate clears on the next load. The webhook itself does NOT (and cannot) mint new scopes.
 *
 * TO GATE A NEW TAB
 *   1. Ship the new app version in the GHL Marketplace (with its new scopes).
 *   2. Grab the exact `versionId` GHL assigns that version.
 *   3. Add an entry to TAB_REQUIREMENTS below with that versionId.
 *   4. Run:  node scripts/seed-tab-version-requirements.js sync
 *
 * COMMANDS
 *   node scripts/seed-tab-version-requirements.js sync   # upsert every entry below (and REMOVE rows
 *                                                         # whose tabId is no longer in the list)
 *   node scripts/seed-tab-version-requirements.js list   # print the current DB rows
 *
 * ──────────────────────────────────────────────────────────────────────────────────────────────
 *  EDIT THIS LIST. One object per gated tab. tabId must match the Dashboard tab id exactly.
 * ──────────────────────────────────────────────────────────────────────────────────────────────
 */
const TAB_REQUIREMENTS = [
  // One entry per app version that gates tabs. `tabIds` is a LIST — put every tab that version
  // shipped in the same entry. Example (commented out — fill the real versionId, uncomment):
  // {
  //   tabIds: ['yourNewTabA', 'yourNewTabB'],
  //   requiredVersionId: '<the GHL versionId that ships these tabs>',
  //   forceUpdate: true,
  //   reason: 'This feature needs the latest app version.'
  // },
];

require('dotenv').config();
const path = require('path');
process.chdir(path.join(__dirname, '..'));

const database = require('../src/config/database');
const TabVersionRequirement = require('../src/models/TabVersionRequirement');

async function main() {
  const action = (process.argv[2] || 'list').toLowerCase();
  if (!['sync', 'list'].includes(action)) {
    console.error('Usage: node scripts/seed-tab-version-requirements.js <sync|list>');
    process.exit(1);
  }

  await database.connect();

  if (action === 'list') {
    const rows = await TabVersionRequirement.find({}).lean();
    console.log('Gated-tab rules in DB:');
    if (!rows.length) console.log('  (none)');
    else rows.forEach(r => console.log(`  - [${(r.tabIds || []).join(', ')}]  → requiredVersionId=${r.requiredVersionId}  forceUpdate=${r.forceUpdate}${r.reason ? `  (${r.reason})` : ''}`));
    await database.disconnect();
    return;
  }

  // sync: one rule per requiredVersionId. Upsert each entry; delete rows whose version dropped out.
  const keepVersions = TAB_REQUIREMENTS.map(t => t.requiredVersionId);
  for (const t of TAB_REQUIREMENTS) {
    const tabIds = Array.isArray(t.tabIds) ? t.tabIds.filter(Boolean) : [];
    if (!tabIds.length || !t.requiredVersionId) {
      console.warn(`  ⚠ skipping invalid entry (needs tabIds[] + requiredVersionId): ${JSON.stringify(t)}`);
      continue;
    }
    await TabVersionRequirement.findOneAndUpdate(
      { requiredVersionId: t.requiredVersionId },
      {
        $set: {
          tabIds,
          forceUpdate: t.forceUpdate !== false,
          reason: t.reason || null
        }
      },
      { upsert: true, new: true }
    );
    console.log(`  ✓ upserted [${tabIds.join(', ')}] → ${t.requiredVersionId}`);
  }

  const removed = await TabVersionRequirement.deleteMany(
    keepVersions.length ? { requiredVersionId: { $nin: keepVersions } } : {}
  );
  if (removed.deletedCount) console.log(`  ✓ removed ${removed.deletedCount} stale rule(s) no longer in the list`);

  const rows = await TabVersionRequirement.find({}).lean();
  console.log(`\nDone. ${rows.length} gated-tab rule(s) now in DB.`);
  await database.disconnect();
}

main().catch(err => {
  console.error('❌ Failed:', err.message);
  process.exit(1);
});
