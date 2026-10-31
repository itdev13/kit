#!/usr/bin/env node
/**
 * Resolve GHL contactIds from a CSV of firstName,lastName,phone,email.
 * Used as step 1 before Call Transcriptions (needs filters.contactIds).
 *
 * Usage:
 *   node resolve-contact-ids-from-csv.js \
 *     --csv T7_774_contacts_for_transcripts.csv \
 *     --locationId <id> \
 *     --token <oauthJwt>
 *
 * Or env:
 *   LOCATION_ID=... GHL_TOKEN=... node resolve-contact-ids-from-csv.js
 *
 * Output (../local-exports/):
 *   <csvBasename>_contact_ids.csv
 *   <csvBasename>_contact_ids.json
 *   <csvBasename>_contact_ids_summary.json
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const GHL_API = 'https://services.leadconnectorhq.com';
const VERSION = '2021-07-28';

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--') && i + 1 < argv.length) {
      out[a.slice(2)] = argv[++i];
    }
  }
  return out;
}

const args = parseArgs(process.argv);
const csvPath = path.resolve(
  args.csv || path.join(__dirname, 'T7_774_contacts_for_transcripts.csv')
);
const locationId = args.locationId || process.env.LOCATION_ID;
const token = args.token || process.env.GHL_TOKEN;
const concurrency = Math.max(1, parseInt(args.concurrency || process.env.CONCURRENCY || '3', 10));

if (!locationId || !token) {
  console.error(
    'Missing --locationId / --token (or LOCATION_ID / GHL_TOKEN). Share the token + locationId to run.'
  );
  process.exit(1);
}
if (!fs.existsSync(csvPath)) {
  console.error('CSV not found:', csvPath);
  process.exit(1);
}

const OUT_DIR = path.resolve(__dirname, '..', 'local-exports');
fs.mkdirSync(OUT_DIR, { recursive: true });
const base = path.basename(csvPath, path.extname(csvPath));
const OUT_CSV = path.join(OUT_DIR, `${base}_contact_ids.csv`);
const OUT_JSON = path.join(OUT_DIR, `${base}_contact_ids.json`);
const OUT_SUMMARY = path.join(OUT_DIR, `${base}_contact_ids_summary.json`);
const OUT_IDS_ONLY = path.join(OUT_DIR, `${base}_contact_ids_only.json`);

const client = axios.create({
  baseURL: GHL_API,
  headers: {
    Authorization: `Bearer ${token}`,
    Version: VERSION,
    Accept: 'application/json',
    'Content-Type': 'application/json'
  },
  timeout: 60000
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(fn, maxRetries = 6) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = err.response?.status;
      const is429 = status === 429;
      const is5xx = status >= 500 && status < 600;
      if ((is429 || is5xx) && attempt < maxRetries) {
        const delay = Math.min(30000, Math.pow(2, attempt) * 1500) + Math.floor(Math.random() * 400);
        console.warn(`  retry ${attempt + 1}/${maxRetries} after ${status} (${delay}ms)`);
        await sleep(delay);
      } else {
        throw err;
      }
    }
  }
}

/** Minimal CSV parser (handles quoted fields with commas). */
function parseCsv(text) {
  const rows = [];
  let i = 0;
  const len = text.length;
  let row = [];
  let field = '';
  let inQuotes = false;

  while (i < len) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ',') {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
      i++;
      continue;
    }
    field += c;
    i++;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function escapeCsv(val) {
  const s = val == null ? '' : String(val);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Digits-only phone for comparison (keeps country code if present). */
function digitsPhone(phone) {
  return String(phone || '').replace(/\D/g, '');
}

function phonesMatch(a, b) {
  const da = digitsPhone(a);
  const db = digitsPhone(b);
  if (!da || !db) return false;
  if (da === db) return true;
  // US: compare last 10 digits
  if (da.length >= 10 && db.length >= 10) {
    return da.slice(-10) === db.slice(-10);
  }
  return false;
}

function emailsMatch(a, b) {
  const ea = String(a || '').trim().toLowerCase();
  const eb = String(b || '').trim().toLowerCase();
  return ea && eb && ea === eb;
}

function pickBestContact(candidates, phone, email) {
  if (!candidates.length) return null;
  const phoneHits = candidates.filter((c) => phonesMatch(c.phone, phone));
  const emailHits = candidates.filter((c) => emailsMatch(c.email, email));

  if (phone && phoneHits.length === 1) return { contact: phoneHits[0], method: 'phone' };
  if (email && emailHits.length === 1) return { contact: emailHits[0], method: 'email' };
  if (phone && email) {
    const both = candidates.filter(
      (c) => phonesMatch(c.phone, phone) && emailsMatch(c.email, email)
    );
    if (both.length === 1) return { contact: both[0], method: 'phone+email' };
  }
  if (phoneHits.length === 1) return { contact: phoneHits[0], method: 'phone' };
  if (emailHits.length === 1) return { contact: emailHits[0], method: 'email' };
  if (phoneHits.length > 1) return { contact: null, method: 'ambiguous_phone', candidates: phoneHits };
  if (emailHits.length > 1) return { contact: null, method: 'ambiguous_email', candidates: emailHits };
  if (candidates.length === 1) return { contact: candidates[0], method: 'query_single' };
  return { contact: null, method: 'ambiguous', candidates };
}

/** GET /contacts/lookup — exact phone/email when available. */
async function lookupContact({ phone, email }) {
  const params = { locationId };
  if (phone) params.phone = phone;
  if (email) params.email = email;
  if (!params.phone && !params.email) return null;

  try {
    const res = await withRetry(() => client.get('/contacts/lookup', { params }));
    const c = res.data?.contact || res.data?.contacts?.[0] || null;
    return c;
  } catch (err) {
    // 404 / 422 = no match — not fatal
    const status = err.response?.status;
    if (status === 404 || status === 422 || status === 400) return null;
    throw err;
  }
}

/** GET /contacts/?query= — fallback fuzzy search. */
async function searchByQuery(query) {
  if (!query) return [];
  const res = await withRetry(() =>
    client.get('/contacts/', {
      params: { locationId, query, limit: 20 }
    })
  );
  return res.data?.contacts || [];
}

async function resolveRow(row, index) {
  const { firstName, lastName, phone, email } = row;
  const out = {
    row: index + 1,
    firstName,
    lastName,
    phone,
    email,
    contactId: '',
    contactName: '',
    matchMethod: '',
    status: 'not_found',
    error: ''
  };

  if (!phone && !email) {
    out.status = 'skipped_no_phone_email';
    return out;
  }

  try {
    // 1) Prefer exact lookup by phone, then email
    let contact = null;
    let method = '';

    if (phone) {
      contact = await lookupContact({ phone });
      if (contact) method = 'lookup_phone';
    }
    if (!contact && email) {
      contact = await lookupContact({ email });
      if (contact) method = 'lookup_email';
    }

    // 2) Fallback: search by phone digits / email / name
    if (!contact) {
      const queries = [];
      if (phone) queries.push(phone, digitsPhone(phone).slice(-10));
      if (email) queries.push(email);
      const name = [firstName, lastName].filter(Boolean).join(' ').trim();
      if (name && name.toLowerCase() !== 'wireless caller') queries.push(name);

      let candidates = [];
      for (const q of queries) {
        const hits = await searchByQuery(q);
        candidates.push(...hits);
        if (hits.length) break;
      }
      // de-dupe by id
      const byId = new Map();
      for (const c of candidates) {
        if (c?.id) byId.set(c.id, c);
      }
      candidates = [...byId.values()];

      const picked = pickBestContact(candidates, phone, email);
      if (picked?.contact) {
        contact = picked.contact;
        method = picked.method;
      } else if (picked?.method) {
        out.status = picked.method.startsWith('ambiguous') ? 'ambiguous' : 'not_found';
        out.matchMethod = picked.method;
        out.error = picked.candidates
          ? `candidates=${picked.candidates.map((c) => c.id).join(',')}`
          : '';
        return out;
      }
    }

    if (contact?.id) {
      out.contactId = contact.id;
      out.contactName =
        [contact.firstName, contact.lastName].filter(Boolean).join(' ') ||
        contact.name ||
        '';
      out.matchMethod = method || 'lookup';
      out.status = 'found';
    } else {
      out.status = 'not_found';
    }
  } catch (err) {
    out.status = 'error';
    out.error = err.response?.data?.message || err.message || String(err);
  }

  return out;
}

async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
      if ((i + 1) % 25 === 0 || i + 1 === items.length) {
        const found = results.filter((r) => r?.status === 'found').length;
        console.log(`  progress ${i + 1}/${items.length} (found ${found})`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

async function main() {
  console.log('Resolve contactIds from CSV');
  console.log({ csv: csvPath, locationId, concurrency, outDir: OUT_DIR });

  const raw = fs.readFileSync(csvPath, 'utf8');
  const table = parseCsv(raw);
  if (!table.length) {
    console.error('Empty CSV');
    process.exit(1);
  }

  const header = table[0].map((h) => h.trim());
  const col = (name) => {
    const i = header.findIndex((h) => h.toLowerCase() === name.toLowerCase());
    return i;
  };
  const iFirst = col('firstName');
  const iLast = col('lastName');
  const iPhone = col('phone');
  const iEmail = col('email');

  if (iPhone < 0 && iEmail < 0) {
    console.error('CSV needs a phone and/or email column. Got:', header);
    process.exit(1);
  }

  const rows = table.slice(1).map((r) => ({
    firstName: iFirst >= 0 ? (r[iFirst] || '').trim() : '',
    lastName: iLast >= 0 ? (r[iLast] || '').trim() : '',
    phone: iPhone >= 0 ? (r[iPhone] || '').trim() : '',
    email: iEmail >= 0 ? (r[iEmail] || '').trim() : ''
  }));

  console.log(`Rows: ${rows.length}`);

  const results = await mapPool(rows, concurrency, resolveRow);

  const found = results.filter((r) => r.status === 'found');
  const uniqueIds = [...new Set(found.map((r) => r.contactId).filter(Boolean))];

  const summary = {
    locationId,
    sourceCsv: path.basename(csvPath),
    totalRows: results.length,
    found: found.length,
    notFound: results.filter((r) => r.status === 'not_found').length,
    ambiguous: results.filter((r) => r.status === 'ambiguous').length,
    errors: results.filter((r) => r.status === 'error').length,
    skipped: results.filter((r) => r.status.startsWith('skipped')).length,
    uniqueContactIds: uniqueIds.length,
    generatedAt: new Date().toISOString()
  };

  // Full JSON
  fs.writeFileSync(OUT_JSON, JSON.stringify({ summary, results }, null, 2));

  // IDs-only JSON (ready for Call Transcriptions filters.contactIds)
  fs.writeFileSync(
    OUT_IDS_ONLY,
    JSON.stringify({ locationId, contactIds: uniqueIds }, null, 2)
  );

  // CSV
  const csvHeader = [
    'row',
    'firstName',
    'lastName',
    'phone',
    'email',
    'contactId',
    'contactName',
    'matchMethod',
    'status',
    'error'
  ];
  const csvBody = results
    .map((r) =>
      csvHeader.map((k) => escapeCsv(r[k])).join(',')
    )
    .join('\n');
  fs.writeFileSync(OUT_CSV, csvHeader.join(',') + '\n' + csvBody + '\n');

  fs.writeFileSync(OUT_SUMMARY, JSON.stringify(summary, null, 2));

  console.log('\nDone.');
  console.log(summary);
  console.log('CSV:      ', OUT_CSV);
  console.log('JSON:     ', OUT_JSON);
  console.log('IDs only: ', OUT_IDS_ONLY);
  console.log('Summary:  ', OUT_SUMMARY);
}

main().catch((err) => {
  console.error('Fatal:', err.response?.data || err.message || err);
  process.exit(1);
});
