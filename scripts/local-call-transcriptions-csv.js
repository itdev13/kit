#!/usr/bin/env node
/**
 * Local Call Transcriptions CSV — same GHL walk as ConvoVault exportType=callTranscriptions,
 * but NO billing / Mongo / Lambda. Adds ContactName, Phone, Email from the resolved-ids CSV.
 *
 * APIs used (same as ghlService / billing.js — there is no bulk transcript endpoint):
 *   1. GET  /conversations/search?contactId=&locationId=
 *   2. GET  /conversations/{conversationId}/messages?type=TYPE_CALL
 *   3. GET  /conversations/locations/{locationId}/messages/{messageId}/transcription/download
 *
 * Usage:
 *   node local-call-transcriptions-csv.js \
 *     --contactsCsv ../local-exports/T7_774_contacts_for_transcripts_contact_ids.csv \
 *     --locationId YUwoRCfXsM6pJvZ3bRik \
 *     --token <locationJwt> \
 *     [--token2 <appJwt>] \
 *     [--concurrency 6]
 *
 * Env: LOCATION_ID, GHL_TOKEN, GHL_TOKEN_2, CONCURRENCY
 *
 * Output:
 *   ../local-exports/call-transcriptions-<locationId>/call-transcriptions.csv
 *   ../local-exports/call-transcriptions-<locationId>/summary.json
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const GHL_API = 'https://services.leadconnectorhq.com';
const VERSION = '2021-07-28';
const CALL_STATUSES_OK = new Set(['completed', 'answered', 'voicemail']);

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--') && i + 1 < argv.length) out[a.slice(2)] = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv);
const locationId = args.locationId || process.env.LOCATION_ID;
const token = args.token || process.env.GHL_TOKEN;
const token2 = args.token2 || process.env.GHL_TOKEN_2 || '';
const concurrency = Math.max(
  1,
  parseInt(args.concurrency || process.env.CONCURRENCY || (token2 ? '8' : '5'), 10)
);
const contactsCsv = path.resolve(
  args.contactsCsv ||
    path.join(__dirname, '..', 'local-exports', 'T7_774_contacts_for_transcripts_contact_ids.csv')
);
const limitContacts = args.limit ? parseInt(args.limit, 10) : 0;

if (!locationId || !token) {
  console.error('Need --locationId and --token (or LOCATION_ID / GHL_TOKEN).');
  process.exit(1);
}
if (!fs.existsSync(contactsCsv)) {
  console.error('Contacts CSV not found:', contactsCsv);
  process.exit(1);
}

const OUT_DIR = path.resolve(__dirname, '..', 'local-exports', `call-transcriptions-${locationId}`);
fs.mkdirSync(OUT_DIR, { recursive: true });
const OUT_CSV = path.join(OUT_DIR, 'call-transcriptions.csv');
const OUT_SUMMARY = path.join(OUT_DIR, 'summary.json');
const OUT_PROGRESS = path.join(OUT_DIR, 'progress.json');

const tokens = [token, token2].filter(Boolean);
let tokenIdx = 0;
function nextToken() {
  const t = tokens[tokenIdx % tokens.length];
  tokenIdx++;
  return t;
}

function clientFor(tok) {
  return axios.create({
    baseURL: GHL_API,
    headers: {
      Authorization: `Bearer ${tok}`,
      Version: VERSION,
      Accept: 'application/json'
    },
    timeout: 60000
  });
}

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
        const delay = Math.min(30000, Math.pow(2, attempt) * 2000) + Math.floor(Math.random() * 500);
        console.warn(`  retry ${attempt + 1}/${maxRetries} after ${status} (${delay}ms)`);
        await sleep(delay);
      } else {
        throw err;
      }
    }
  }
}

function escapeCsv(val) {
  const s = val == null ? '' : String(val);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function formatDate(d) {
  if (!d) return '';
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return String(d);
  return dt.toISOString();
}

/** Minimal CSV parser (quoted fields). */
function parseCsv(text) {
  const rows = [];
  let i = 0;
  let row = [];
  let field = '';
  let inQuotes = false;
  while (i < text.length) {
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

function loadContacts(csvPath) {
  const table = parseCsv(fs.readFileSync(csvPath, 'utf8'));
  const header = table[0].map((h) => h.trim());
  const idx = (name) => header.findIndex((h) => h.toLowerCase() === name.toLowerCase());
  const iId = idx('contactId');
  if (iId < 0) throw new Error('CSV missing contactId column');
  const iName = idx('contactName');
  const iFirst = idx('firstName');
  const iLast = idx('lastName');
  const iPhone = idx('phone');
  const iEmail = idx('email');

  const contacts = [];
  for (const r of table.slice(1)) {
    const contactId = (r[iId] || '').trim();
    if (!contactId) continue;
    const first = iFirst >= 0 ? (r[iFirst] || '').trim() : '';
    const last = iLast >= 0 ? (r[iLast] || '').trim() : '';
    const contactName =
      (iName >= 0 ? (r[iName] || '').trim() : '') ||
      [first, last].filter(Boolean).join(' ');
    contacts.push({
      contactId,
      contactName,
      firstName: first,
      lastName: last,
      phone: iPhone >= 0 ? (r[iPhone] || '').trim() : '',
      email: iEmail >= 0 ? (r[iEmail] || '').trim() : ''
    });
  }
  return contacts;
}

async function searchConversations(contactId) {
  const client = clientFor(nextToken());
  const res = await withRetry(() =>
    client.get('/conversations/search', {
      params: { locationId, contactId, limit: 100 }
    })
  );
  return res.data?.conversations || [];
}

async function getCallMessages(conversationId) {
  const out = [];
  let cursor;
  while (true) {
    const client = clientFor(nextToken());
    const params = { limit: 300, type: 'TYPE_CALL' };
    if (cursor) params.lastMessageId = cursor;
    const res = await withRetry(() =>
      client.get(`/conversations/${conversationId}/messages`, { params })
    );
    const wrapper = res.data?.messages || {};
    const page = wrapper.messages || [];
    for (const m of page) {
      if (CALL_STATUSES_OK.has(String(m?.status || '').toLowerCase())) {
        out.push({ ...m, conversationId });
      }
    }
    if (page.length < 300 || !wrapper.nextPage) break;
    cursor = wrapper.lastMessageId;
  }
  return out;
}

async function downloadTranscript(messageId) {
  const client = clientFor(nextToken());
  const res = await withRetry(() =>
    client.get(
      `/conversations/locations/${locationId}/messages/${messageId}/transcription/download`,
      { responseType: 'text', headers: { Accept: 'text/plain' } }
    )
  );
  return String(res.data || '');
}

const CSV_HEADER = [
  'Date',
  'ConversationID',
  'ContactID',
  'ContactName',
  'Phone',
  'Email',
  'MessageID',
  'MessageType',
  'UserID',
  'Direction',
  'Status',
  'CallDuration',
  'CallStatus',
  'Transcript'
];

function rowToCsv(r) {
  return [
    formatDate(r.dateAdded),
    r.conversationId || '',
    r.contactId || '',
    r.contactName || '',
    r.phone || '',
    r.email || '',
    r.messageId || '',
    r.messageType || '',
    r.userId || '',
    r.direction || '',
    r.status || '',
    r.callDuration || '',
    r.callStatus || '',
    r.transcript || ''
  ]
    .map(escapeCsv)
    .join(',');
}

async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

async function processContact(contact, index, total) {
  const stats = {
    contactId: contact.contactId,
    conversations: 0,
    callMessages: 0,
    withTranscript: 0,
    emptyTranscript: 0,
    errors: 0
  };
  const records = [];

  try {
    const convos = await searchConversations(contact.contactId);
    stats.conversations = convos.length;

    const callMsgs = [];
    for (let i = 0; i < convos.length; i += concurrency) {
      const batch = convos.slice(i, i + concurrency);
      const pages = await Promise.all(
        batch.map((c) =>
          getCallMessages(c.id).catch((err) => {
            stats.errors++;
            console.warn(`  msgs fail ${c.id}:`, err.response?.status || err.message);
            return [];
          })
        )
      );
      for (const arr of pages) callMsgs.push(...arr);
    }
    stats.callMessages = callMsgs.length;

    for (let i = 0; i < callMsgs.length; i += concurrency) {
      const batch = callMsgs.slice(i, i + concurrency);
      const texts = await Promise.all(
        batch.map(async (m) => {
          try {
            const transcript = await downloadTranscript(m.id);
            return { m, transcript, err: null };
          } catch (err) {
            return { m, transcript: '', err };
          }
        })
      );
      for (const { m, transcript, err } of texts) {
        if (err) {
          stats.errors++;
          continue;
        }
        if (!transcript.trim()) {
          stats.emptyTranscript++;
          continue;
        }
        stats.withTranscript++;
        records.push({
          dateAdded: m.dateAdded || null,
          conversationId: m.conversationId,
          contactId: contact.contactId,
          contactName: contact.contactName,
          phone: contact.phone,
          email: contact.email,
          messageId: m.id,
          messageType: m.type || m.messageType || '',
          userId: m.userId || '',
          direction: m.direction || '',
          status: m.status || '',
          callDuration: m.meta?.callDuration || m.callDuration || '',
          callStatus: m.meta?.callStatus || '',
          transcript
        });
      }
    }
  } catch (err) {
    stats.errors++;
    console.warn(
      `  contact fail ${contact.contactId}:`,
      err.response?.status || err.message
    );
  }

  if ((index + 1) % 10 === 0 || index + 1 === total) {
    console.log(
      `  contact ${index + 1}/${total}  convos=${stats.conversations} calls=${stats.callMessages} transcripts=${stats.withTranscript}`
    );
  }
  return { stats, records };
}

async function main() {
  let contacts = loadContacts(contactsCsv);
  if (limitContacts > 0) contacts = contacts.slice(0, limitContacts);

  console.log('Local Call Transcriptions CSV');
  console.log({
    locationId,
    contacts: contacts.length,
    concurrency,
    tokens: tokens.length,
    contactsCsv,
    outDir: OUT_DIR
  });

  // Streaming write: header first, append as we go (safer for long runs)
  fs.writeFileSync(OUT_CSV, CSV_HEADER.join(',') + '\n');

  const allStats = [];
  let totalTranscripts = 0;
  let totalCalls = 0;
  let totalEmpty = 0;
  let totalErrors = 0;
  let contactsWithAny = 0;

  // Process contacts with limited parallelism (each contact does its own internal batches)
  const CONTACT_PARALLEL = Math.min(concurrency, 4);
  for (let i = 0; i < contacts.length; i += CONTACT_PARALLEL) {
    const batch = contacts.slice(i, i + CONTACT_PARALLEL);
    const results = await Promise.all(
      batch.map((c, j) => processContact(c, i + j, contacts.length))
    );
    for (const { stats, records } of results) {
      allStats.push(stats);
      totalCalls += stats.callMessages;
      totalEmpty += stats.emptyTranscript;
      totalErrors += stats.errors;
      if (records.length) contactsWithAny++;
      totalTranscripts += records.length;
      if (records.length) {
        fs.appendFileSync(OUT_CSV, records.map(rowToCsv).join('\n') + '\n');
      }
    }
    fs.writeFileSync(
      OUT_PROGRESS,
      JSON.stringify(
        {
          doneContacts: Math.min(i + CONTACT_PARALLEL, contacts.length),
          totalContacts: contacts.length,
          totalTranscripts,
          totalCalls,
          updatedAt: new Date().toISOString()
        },
        null,
        2
      )
    );
  }

  const summary = {
    locationId,
    sourceCsv: path.basename(contactsCsv),
    contactsProcessed: contacts.length,
    contactsWithTranscripts: contactsWithAny,
    callMessagesEligible: totalCalls,
    transcriptsWritten: totalTranscripts,
    emptyTranscripts: totalEmpty,
    errors: totalErrors,
    concurrency,
    tokensUsed: tokens.length,
    csv: OUT_CSV,
    generatedAt: new Date().toISOString()
  };
  fs.writeFileSync(OUT_SUMMARY, JSON.stringify(summary, null, 2));

  console.log('\n========== COUNTS ==========');
  console.log(`Contacts processed:          ${summary.contactsProcessed}`);
  console.log(`Contacts with transcripts:   ${summary.contactsWithTranscripts}`);
  console.log(`Eligible call messages:      ${summary.callMessagesEligible}`);
  console.log(`Transcripts written (CSV):   ${summary.transcriptsWritten}`);
  console.log(`Empty / no transcript:       ${summary.emptyTranscripts}`);
  console.log(`Errors:                      ${summary.errors}`);
  console.log('============================\n');
  console.log('CSV:', OUT_CSV);
  console.log('Summary:', OUT_SUMMARY);
}

main().catch((err) => {
  console.error('Fatal:', err.response?.data || err.message || err);
  process.exit(1);
});
