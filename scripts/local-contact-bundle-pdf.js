#!/usr/bin/env node
/**
 * Local Contact Bundle (Google Doc) PDF — same gather + render as production
 * contactBundleDoc, but NO billing, Mongo, SpecialExport, S3, or email.
 *
 * Usage:
 *   node local-contact-bundle-pdf.js \
 *     --contactId <id> --locationId <id> --token <oauthJwt>
 *
 * Or env:
 *   CONTACT_ID=... LOCATION_ID=... GHL_TOKEN=... node local-contact-bundle-pdf.js
 *
 * Output:
 *   ../local-exports/<contactId>/contact-bundle.pdf
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');

const GHL_API = 'https://services.leadconnectorhq.com';
const VERSION = '2021-07-28';

// ── CLI / env ────────────────────────────────────────────────────────────────
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
const contactId = args.contactId || process.env.CONTACT_ID;
const locationId = args.locationId || process.env.LOCATION_ID;
const token = args.token || process.env.GHL_TOKEN;
// Display timezone: default LOCAL (matches GHL UI in your browser).
// Pass --timezone America/Chicago (or LOCATION) to force the sub-account zone.
// Default: location timezone (matches GHL sub-account UI). Use --timezone local for machine TZ.
const tzArg = args.timezone || process.env.DISPLAY_TIMEZONE || 'location';

if (!contactId || !locationId || !token) {
  console.error('Missing required args. Need --contactId, --locationId, --token (or CONTACT_ID / LOCATION_ID / GHL_TOKEN).');
  process.exit(1);
}

const OUT_DIR = path.resolve(__dirname, '..', 'local-exports', contactId);
const OUT_PDF = path.join(OUT_DIR, 'contact-bundle.pdf');

// ── HTTP helpers ─────────────────────────────────────────────────────────────
const client = axios.create({
  baseURL: GHL_API,
  headers: {
    Authorization: `Bearer ${token}`,
    Version: VERSION,
    Accept: 'application/json'
  },
  timeout: 60000
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(fn, maxRetries = 5) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = err.response?.status;
      const is429 = status === 429;
      const is5xx = status >= 500 && status < 600;
      if ((is429 || is5xx) && attempt < maxRetries) {
        const delay = Math.min(20000, Math.pow(2, attempt) * 1500) + Math.floor(Math.random() * 400);
        console.warn(`  retry ${attempt + 1}/${maxRetries} after ${status} (${delay}ms)`);
        await sleep(delay);
      } else {
        throw err;
      }
    }
  }
}

async function ghlGet(urlPath, params) {
  const res = await withRetry(() => client.get(urlPath, { params }));
  return res.data;
}

function decodeJwtPayload(jwt) {
  try {
    const mid = String(jwt).split('.')[1];
    if (!mid) return {};
    return JSON.parse(Buffer.from(mid.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch {
    return {};
  }
}

// ── Date parsing ─────────────────────────────────────────────────────────────
// GHL often returns naive ISO (no Z / offset) in the *location's* wall clock.
 // Node would parse that as the *machine* timezone (e.g. IST) → AM/PM looks reversed
 // after converting to America/Chicago. Interpret naive ISO in the account TZ instead.
function zonedWallTimeToDate(y, mo, d, h, mi, se, ms, timeZone) {
  // Treat components as if UTC, then subtract the TZ offset at that instant.
  let utcMs = Date.UTC(y, mo - 1, d, h, mi, se, ms);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  });
  for (let i = 0; i < 3; i++) {
    const parts = Object.fromEntries(
      fmt
        .formatToParts(new Date(utcMs))
        .filter((p) => p.type !== 'literal')
        .map((p) => [p.type, p.value])
    );
    const asIfUtc = Date.UTC(
      +parts.year,
      +parts.month - 1,
      +parts.day,
      +parts.hour,
      +parts.minute,
      +parts.second
    );
    const offset = asIfUtc - utcMs;
    const corrected = Date.UTC(y, mo - 1, d, h, mi, se, ms) - offset;
    if (corrected === utcMs) break;
    utcMs = corrected;
  }
  return new Date(utcMs);
}

function parseGhlDate(d, accountTz) {
  if (d == null || d === '') return null;
  if (typeof d === 'number' || (typeof d === 'string' && /^\d+$/.test(d.trim()))) {
    const n = Number(d);
    return new Date(n < 1e12 ? n * 1000 : n);
  }
  const s = String(d).trim();
  const naive = s.match(
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(?:\s*)?$/
  );
  // Explicit Z / offset → trust absolute instant
  if (/([zZ]|[+-]\d{2}:?\d{2})$/.test(s) && !naive) {
    const t = new Date(s);
    return isNaN(t) ? null : t;
  }
  // Naive ISO → wall clock in account timezone (fixes AM/PM flip on non-US machines)
  if (naive && accountTz) {
    const ms = naive[7] ? Number(String(naive[7]).padEnd(3, '0')) : 0;
    return zonedWallTimeToDate(
      +naive[1],
      +naive[2],
      +naive[3],
      +naive[4],
      +naive[5],
      +(naive[6] || 0),
      ms,
      accountTz
    );
  }
  // ISO with Z but GHL sometimes stamps location-local wall clock + "Z".
  // If it has Z and we have accountTz, ALSO try: strip Z and treat as wall clock when
  // the trusted-Z reading disagrees with typical UI — prefer wall-clock in account TZ.
  const withZ = s.match(
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?Z$/i
  );
  if (withZ && accountTz) {
    // Prefer absolute Z first (correct when GHL sends real UTC).
    return new Date(s);
  }
  const t = new Date(s);
  return isNaN(t) ? null : t;
}

// ── Type helpers ─────────────────────────────────────────────────────────────
const CALL_STATUSES_OK = new Set(['completed', 'answered', 'voicemail']);

const isEmailMsg = (m) => {
  const t = m.type ?? m.messageType;
  if (typeof t === 'number') return t === 3;
  return String(t || '').toUpperCase() === 'TYPE_EMAIL';
};
const isCallMsg = (m) => {
  const t = m.type ?? m.messageType;
  if (typeof t === 'number') return t === 1 || t === 10 || t === 24 || t === 34;
  const s = String(t || '').toUpperCase();
  return (
    s === 'TYPE_CALL' ||
    s === 'TYPE_IVR_CALL' ||
    s === 'TYPE_VOICEMAIL' ||
    s.includes('CALL')
  );
};
const isIvrMsg = (m) => {
  const t = m.type ?? m.messageType;
  if (t === 24) return true;
  return String(t || '').toUpperCase() === 'TYPE_IVR_CALL';
};
const channelLabel = (m) => {
  const t = m.type ?? m.messageType;
  if (typeof t === 'string') return t.replace(/^TYPE_/, '').replace(/_/g, ' ');
  const MAP = {
    1: 'CALL', 2: 'SMS', 3: 'EMAIL', 4: 'SMS', 5: 'WHATSAPP',
    6: 'GMB', 7: 'FACEBOOK', 8: 'CALL', 9: 'INSTAGRAM', 10: 'VOICEMAIL',
    13: 'CALL', 14: 'EMAIL', 15: 'WHATSAPP', 16: 'GMB', 17: 'INSTAGRAM',
    18: 'FACEBOOK', 19: 'FACEBOOK COMMENT', 20: 'SMS', 21: 'EMAIL',
    22: 'LIVE CHAT', 23: 'LIVE CHAT', 24: 'IVR CALL', 25: 'ACTIVITY',
    26: 'ACTIVITY', 27: 'ACTIVITY', 28: 'ACTIVITY', 29: 'ACTIVITY',
    34: 'CALL'
  };
  return MAP[t] || 'MESSAGE';
};

function truthyFlag(v) {
  if (v === true || v === 1) return true;
  const s = String(v || '').toLowerCase();
  return s === 'true' || s === '1' || s === 'yes';
}

/** workflowId → Automation; auto-reply → AI (AI wins if both somehow set). */
function resolveOutboundKind(m) {
  const workflowId =
    m.workflowId ||
    m.meta?.workflowId ||
    m.meta?.workflow?.id ||
    m.meta?.sms?.workflowId ||
    m.meta?.email?.workflowId ||
    '';
  const autoReply =
    truthyFlag(m.autoReply) ||
    truthyFlag(m.isAutoReply) ||
    truthyFlag(m.meta?.autoReply) ||
    truthyFlag(m.meta?.isAutoReply) ||
    truthyFlag(m.meta?.sms?.autoReply) ||
    truthyFlag(m.meta?.email?.autoReply) ||
    String(m.source || '').toLowerCase() === 'ai' ||
    String(m.source || '').toLowerCase() === 'auto_reply' ||
    String(m.source || '').toLowerCase() === 'autoreply';

  const src = String(m.source || '').toLowerCase();
  if (autoReply) return { kind: 'AI', workflowId: workflowId || '' };
  if (workflowId || src === 'workflow' || src === 'campaign' || src === 'bulk_actions') {
    return { kind: 'Automation', workflowId: workflowId || '' };
  }
  return { kind: '', workflowId: workflowId || '' };
}

function pushUrl(out, seen, u) {
  const url = typeof u === 'string' ? u.trim() : u?.url || u?.link || u?.href || u?.downloadUrl || '';
  if (!url || seen.has(url)) return;
  seen.add(url);
  out.push(url);
}

/** Pull attachment URLs from every place GHL hides them. */
function extractAttachments(m) {
  const out = [];
  const seen = new Set();
  const bags = [
    m.attachments,
    m.files,
    m.meta?.attachments,
    m.meta?.files,
    m.meta?.email?.attachments,
    m.meta?.sms?.attachments,
    m.meta?.call?.attachments,
    m.meta?.whatsapp?.attachments
  ];
  for (const bag of bags) {
    if (!Array.isArray(bag)) continue;
    for (const a of bag) pushUrl(out, seen, a);
  }
  const singles = [
    m.recordingUrl,
    m.meta?.recordingUrl,
    m.meta?.call?.recordingUrl,
    m.meta?.call?.recording,
    m.meta?.call?.url,
    m.meta?.voicemailUrl,
    m.meta?.attachmentsUrl
  ];
  for (const s of singles) pushUrl(out, seen, s);

  // Sometimes body itself is just a media URL
  const body = String(m.body || '').trim();
  if (/^https?:\/\/\S+$/i.test(body) && /\.(png|jpe?g|gif|webp|pdf|mp3|wav|mp4)(\?|$)/i.test(body)) {
    pushUrl(out, seen, body);
  }
  return out;
}

function isImageUrl(u) {
  // Only trust real image extensions — GHL conversations-assets often serve vCards/etc with no ext.
  return /\.(png|jpe?g|gif|webp|bmp|svg)(\?|$)/i.test(String(u || ''));
}

/** Sniff downloaded bytes to set kind + extension (fixes extensionless GHL CDN URLs). */
function sniffFile(buf, fileName) {
  if (!buf || !buf.length) return { kind: 'file', ext: path.extname(fileName) || '' };
  const head = buf.slice(0, 64);
  const asUtf = head.toString('utf8');
  if (head[0] === 0xff && head[1] === 0xd8) return { kind: 'image', ext: '.jpg' };
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) {
    return { kind: 'image', ext: '.png' };
  }
  if (asUtf.startsWith('GIF8')) return { kind: 'image', ext: '.gif' };
  if (asUtf.startsWith('RIFF') && buf.slice(8, 12).toString('utf8') === 'WEBP') {
    return { kind: 'image', ext: '.webp' };
  }
  if (asUtf.includes('BEGIN:VCARD')) return { kind: 'file', ext: '.vcf' };
  if (head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46) {
    return { kind: 'pdf', ext: '.pdf' };
  }
  if (asUtf.startsWith('ID3') || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0)) {
    return { kind: 'audio', ext: '.mp3' };
  }
  if (asUtf.startsWith('RIFF') && buf.slice(8, 12).toString('utf8') === 'WAVE') {
    return { kind: 'audio', ext: '.wav' };
  }
  if (buf.slice(4, 8).toString('utf8') === 'ftyp') return { kind: 'video', ext: '.mp4' };
  const byName = guessKindFromName(fileName);
  return { kind: byName, ext: path.extname(fileName) || '' };
}

/** meta.call.duration is often wrong for IVR — GHL player shows recording length instead. */
function normalizeCallDurationSeconds(m) {
  const raw =
    m.meta?.call?.duration != null && m.meta?.call?.duration !== ''
      ? m.meta.call.duration
      : m.duration;
  if (raw == null || raw === '') return null;
  let d = Number(raw);
  if (!Number.isFinite(d) || d <= 0) return null;
  if (d >= 100000 && Number.isInteger(d)) d = d / 1000;
  if (d < 1) return null;
  return Math.round(d);
}

/** Read duration (seconds) from a WAV buffer — matches GHL's audio player length. */
function wavDurationSeconds(buf) {
  if (!buf || buf.length < 44) return null;
  let offset = 12;
  let byteRate = 0;
  let dataSize = 0;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === 'fmt ' && offset + 16 <= buf.length) {
      byteRate = buf.readUInt32LE(offset + 8 + 8);
    }
    if (id === 'data') {
      dataSize = size;
      break;
    }
    offset += 8 + size + (size % 2);
    if (size < 0 || offset > buf.length) break;
  }
  if (!byteRate || !dataSize) return null;
  return Math.max(1, Math.round(dataSize / byteRate));
}

function isVideoUrl(u) {
  return /\.(mp4|mov|webm|m4v|avi|mkv)(\?|$)/i.test(String(u || ''));
}

function isAudioUrl(u) {
  return (
    /\.(mp3|wav|m4a|ogg)(\?|$)/i.test(String(u || '')) ||
    /twilio\.com\/.*Recordings/i.test(String(u || '')) ||
    (/\/recordings\//i.test(String(u || '')) && /\.wav(\?|$)/i.test(String(u || '')))
  );
}

function extFromContentType(ct) {
  const c = String(ct || '').split(';')[0].trim().toLowerCase();
  const map = {
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'video/mp4': '.mp4',
    'video/quicktime': '.mov',
    'video/webm': '.webm',
    'audio/wav': '.wav',
    'audio/x-wav': '.wav',
    'audio/mpeg': '.mp3',
    'application/pdf': '.pdf',
    'text/vcard': '.vcf',
    'text/x-vcard': '.vcf'
  };
  return map[c] || '';
}

function fileUrlFromPath(absPath) {
  // file:///path with encoded spaces
  const resolved = path.resolve(absPath);
  return 'file://' + encodeURI(resolved);
}

function guessKindFromName(nameOrUrl) {
  const s = String(nameOrUrl || '');
  if (isVideoUrl(s)) return 'video';
  if (isAudioUrl(s)) return 'audio';
  if (isImageUrl(s)) return 'image';
  if (/\.pdf(\?|$)/i.test(s)) return 'pdf';
  return 'file';
}

/**
 * Download every remote http(s) attachment into OUT_DIR/attachments/
 * and rewrite row.attachments to local file:// URLs (clickable in PDF / HTML).
 * Already-local file:// paths are kept.
 */
async function downloadAllAttachments(rows) {
  const attDir = path.join(OUT_DIR, 'attachments');
  fs.mkdirSync(attDir, { recursive: true });

  // url -> { fileUrl, absPath, relPath, kind, originalUrl }
  const cache = new Map();
  let ok = 0;
  let fail = 0;

  const allRemote = [];
  for (const row of rows) {
    for (const u of row.attachments || []) {
      const url = typeof u === 'string' ? u : u?.originalUrl || u?.fileUrl || '';
      if (/^https?:\/\//i.test(url)) allRemote.push(url);
    }
  }
  const unique = [...new Set(allRemote)];
  console.log(`Downloading attachments: ${unique.length} unique URLs`);

  const PARALLEL = 4;
  for (let i = 0; i < unique.length; i += PARALLEL) {
    const batch = unique.slice(i, i + PARALLEL);
    await Promise.all(
      batch.map(async (url) => {
        const hash = crypto.createHash('sha1').update(url).digest('hex').slice(0, 10);
        try {
          let base = 'file';
          try {
            base = path.basename(new URL(url).pathname) || 'file';
          } catch {
            /* ignore */
          }
          base = decodeURIComponent(base).replace(/[^a-zA-Z0-9._-]/g, '_') || 'file';
          // Stable name from URL hash so parallel downloads don't collide / re-download
          let fileName = `${hash}_${base}`.slice(0, 160);
          let absPath = path.join(attDir, fileName);

          let buf;
          if (!fs.existsSync(absPath) || fs.statSync(absPath).size === 0) {
            const res = await withRetry(() =>
              axios.get(url, {
                responseType: 'arraybuffer',
                timeout: 120000,
                maxRedirects: 5,
                headers: {
                  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X) ConvoVaultLocalExport/1.0',
                  Accept: '*/*'
                },
                validateStatus: (s) => s >= 200 && s < 400
              })
            );
            buf = Buffer.from(res.data);
            let ext = path.extname(fileName);
            if (!ext) {
              ext =
                extFromContentType(res.headers['content-type']) ||
                sniffFile(buf, fileName).ext ||
                '';
              if (ext) {
                fileName += ext;
                absPath = path.join(attDir, fileName);
              }
            }
            fs.writeFileSync(absPath, buf);
          } else {
            buf = fs.readFileSync(absPath);
          }

          // Re-sniff so extensionless CDN files (vCard vs JPEG) get the right kind
          const sniffed = sniffFile(buf, fileName);
          if (sniffed.ext && !path.extname(fileName)) {
            const renamed = fileName + sniffed.ext;
            const newPath = path.join(attDir, renamed);
            if (!fs.existsSync(newPath)) fs.renameSync(absPath, newPath);
            fileName = renamed;
            absPath = newPath;
          } else if (
            sniffed.ext &&
            path.extname(fileName) &&
            path.extname(fileName).toLowerCase() !== sniffed.ext.toLowerCase() &&
            sniffed.kind === 'image'
          ) {
            // keep existing name if already has ext
          }
          // If file was saved without ext earlier, rename now
          if (sniffed.ext && !path.extname(absPath)) {
            const newPath = absPath + sniffed.ext;
            if (!fs.existsSync(newPath)) fs.renameSync(absPath, newPath);
            absPath = newPath;
            fileName = path.basename(absPath);
          }

          const kind =
            sniffed.kind !== 'file'
              ? sniffed.kind
              : guessKindFromName(fileName) !== 'file'
                ? guessKindFromName(fileName)
                : guessKindFromName(url);
          cache.set(url, {
            fileUrl: fileUrlFromPath(absPath),
            absPath,
            relPath: path.join('attachments', path.basename(absPath)).replace(/\\/g, '/'),
            kind,
            originalUrl: url
          });
          ok++;
          if (ok % 10 === 0 || ok === unique.length) {
            console.log(`  downloaded ${ok}/${unique.length}`);
          }
        } catch (e) {
          fail++;
          console.warn(`  attach fail:`, e.response?.status || e.message, url.slice(0, 80));
        }
      })
    );
  }

  // Rewrite rows: remote → local ; keep already-local objects / file://
  for (const row of rows) {
    const next = [];
    const seen = new Set();
    for (const u of row.attachments || []) {
      let entry;
      if (u && typeof u === 'object' && (u.relPath || u.absPath || u.fileUrl)) {
        // Already a local attachment object (e.g. call recording)
        entry = {
          fileUrl: u.fileUrl || (u.absPath ? fileUrlFromPath(u.absPath) : ''),
          absPath: u.absPath || '',
          relPath: (u.relPath || (u.absPath ? path.relative(OUT_DIR, u.absPath) : '')).replace(
            /\\/g,
            '/'
          ),
          kind: u.kind || guessKindFromName(u.relPath || u.absPath || ''),
          originalUrl: u.originalUrl || ''
        };
      } else if (typeof u === 'string' && /^file:\/\//i.test(u)) {
        const abs = decodeURI(u.replace(/^file:\/\//i, ''));
        entry = {
          fileUrl: u,
          absPath: abs,
          relPath: path.relative(OUT_DIR, abs).replace(/\\/g, '/'),
          kind: guessKindFromName(abs),
          originalUrl: u
        };
      } else if (typeof u === 'string' && cache.has(u)) {
        entry = cache.get(u);
      } else if (typeof u === 'string') {
        entry = {
          fileUrl: u,
          absPath: '',
          relPath: '',
          kind: guessKindFromName(u),
          originalUrl: u,
          remoteOnly: true
        };
      } else {
        continue;
      }
      const key = entry.relPath || entry.fileUrl;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      next.push(entry);
    }
    row.attachments = next;
  }

  // For calls/IVR: GHL UI shows the recording player length (e.g. 0:11), NOT meta.call.duration.
  // When we have a local .wav attachment, overwrite durationSeconds from the file.
  for (const row of rows) {
    if (row.category !== 'call' && !/call/i.test(String(row.channel || ''))) continue;
    for (const att of row.attachments || []) {
      if (!att || att.kind !== 'audio' || !att.absPath) continue;
      if (!/\.wav$/i.test(att.absPath)) continue;
      try {
        if (!fs.existsSync(att.absPath)) continue;
        const sec = wavDurationSeconds(fs.readFileSync(att.absPath));
        if (sec != null) {
          row.durationSeconds = sec;
          row.durationFromRecording = true;
          break;
        }
      } catch {
        /* ignore */
      }
    }
    // IVR with no recording file: don't show the misleading meta.call.duration
    if (row.isIvr && !row.durationFromRecording) {
      row.durationSeconds = null;
    }
  }

  console.log(`Attachments saved: ${ok} ok, ${fail} failed → ${attDir}`);
  return { ok, fail, attDir };
}

// ── Gather ───────────────────────────────────────────────────────────────────
async function fetchTimezone() {
  try {
    const data = await ghlGet(`/locations/${locationId}`);
    const loc = data.location || data;
    return loc.timezone || '';
  } catch (e) {
    console.warn('timezone fetch failed (non-blocking):', e.message);
    return '';
  }
}

async function fetchUserMap() {
  const map = {};
  try {
    const data = await ghlGet('/users/search', { locationId, query: '' });
    for (const u of data.users || []) {
      const nm = u.name || [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || u.email || '';
      if (u.id && nm) map[u.id] = nm;
    }
  } catch (e) {
    console.warn('users/search failed (will resolve per userId):', e.response?.status || e.message);
  }
  return map;
}

/** Resolve missing sender names via GET /users/:id (works when /users/search returns 422). */
async function enrichUserMap(userMap, userIds) {
  const missing = [...new Set(userIds.filter(Boolean))].filter((id) => !userMap[id]);
  console.log(`Resolving user names: ${missing.length}`);
  for (let i = 0; i < missing.length; i += 3) {
    const batch = missing.slice(i, i + 3);
    await Promise.all(
      batch.map(async (id) => {
        try {
          const data = await ghlGet(`/users/${id}`);
          const u = data.user || data || {};
          const nm =
            u.name || [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || u.email || '';
          if (nm) userMap[id] = nm;
        } catch {
          /* ignore */
        }
      })
    );
  }
  return userMap;
}

async function fetchContactMeta() {
  try {
    const data = await ghlGet(`/contacts/${contactId}`);
    const c = data.contact || data || {};
    const name =
      c.contactName ||
      [c.firstName, c.lastName].filter(Boolean).join(' ').trim() ||
      c.name ||
      '';
    return { name, email: c.email || '', phone: c.phone || '' };
  } catch (e) {
    console.warn('contact fetch failed (non-blocking):', e.message);
    return { name: '', email: '', phone: '' };
  }
}

function rowFromMessage(m, meta, userMap, extras = {}) {
  const { kind, workflowId } = resolveOutboundKind(m);
  const outbound = String(m.direction || extras.direction || '').toLowerCase() === 'outbound';
  let senderName = userMap[m.userId] || '';
  if (outbound && kind) senderName = kind;
  else if (outbound && !senderName) senderName = 'Team';

  const ivr = isIvrMsg(m);

  return {
    contactId,
    contactName: meta.name,
    contactEmail: meta.email,
    contactPhone: meta.phone,
    attachments: extractAttachments(m),
    conversationId: m.conversationId || extras.conversationId || '',
    messageId: m.id,
    category: extras.category || (isCallMsg(m) ? 'call' : 'sms'),
    channel: extras.channel || (ivr ? 'IVR CALL' : channelLabel(m)),
    direction: m.direction || extras.direction || '',
    dateAdded: m.dateAdded || m.dateUpdated || '',
    from: extras.from || m.from || '',
    to: extras.to || m.to || '',
    body: m.body || '',
    subject: extras.subject || '',
    status: m.status || '',
    // Placeholder from API; overwritten with WAV length when a recording attachment exists.
    durationSeconds: normalizeCallDurationSeconds(m),
    messageType: m.messageType || m.type || '',
    userId: m.userId || '',
    senderName,
    outboundKind: kind,
    workflowId,
    source: m.source || '',
    autoReply: kind === 'AI',
    isIvr: ivr,
    ...extras.more
  };
}

async function walkContact(userMap) {
  const rows = [];
  const meta = await fetchContactMeta();
  console.log(`Contact: ${meta.name || contactId} (${meta.email || meta.phone || 'no email/phone'})`);

  const convoResp = await ghlGet('/conversations/search', {
    locationId,
    contactId,
    limit: 100
  });
  const convoIds = (convoResp.conversations || []).map((c) => c.id);
  console.log(`Conversations: ${convoIds.length}`);

  const CONV_PARALLEL = 2;
  for (let i = 0; i < convoIds.length; i += CONV_PARALLEL) {
    const batch = convoIds.slice(i, i + CONV_PARALLEL);
    const batchResults = await Promise.all(
      batch.map(async (cId) => {
        const out = [];
        let cursor;
        let pages = 0;
        while (true) {
          pages++;
          const params = { limit: 100 };
          if (cursor) params.lastMessageId = cursor;
          const r = await ghlGet(`/conversations/${cId}/messages`, params);
          const wrapper = r.messages || {};
          const pageMsgs = wrapper.messages || [];
          for (const m of pageMsgs) {
            if (isEmailMsg(m)) continue;
            out.push({ ...m, conversationId: cId });
          }
          if (pageMsgs.length < 100 || !wrapper.nextPage) break;
          cursor = wrapper.lastMessageId;
          if (pages > 20) break;
        }
        return out;
      })
    );
    for (const arr of batchResults) {
      for (const m of arr) {
        const callEligible = isCallMsg(m) && CALL_STATUSES_OK.has(String(m.status || '').toLowerCase());
        const row = rowFromMessage(m, meta, userMap, {
          conversationId: m.conversationId
        });
        row._needsTranscript = callEligible;
        rows.push(row);
      }
    }
  }
  console.log(`Non-email messages: ${rows.length}`);

  const transcribeQueue = rows.filter((r) => r._needsTranscript);
  console.log(`Fetching transcripts: ${transcribeQueue.length}`);
  const TRANSCRIBE_PARALLEL = 3;
  for (let i = 0; i < transcribeQueue.length; i += TRANSCRIBE_PARALLEL) {
    const batch = transcribeQueue.slice(i, i + TRANSCRIBE_PARALLEL);
    await Promise.all(
      batch.map(async (row) => {
        try {
          const res = await withRetry(() =>
            client.get(
              `/conversations/locations/${locationId}/messages/${row.messageId}/transcription/download`,
              { responseType: 'text', headers: { Accept: 'text/plain' } }
            )
          );
          row.transcription = res.data || '';
        } catch {
          row.transcription = '';
        }
      })
    );
  }
  for (const r of rows) delete r._needsTranscript;

  // Do NOT pull recordings via the separate recording API — GHL UI often has no
  // recording URL/player for a call; synthesizing local wavs made the PDF disagree
  // with GHL. Only keep attachment URLs that GHL already returned on the message.

  let emailCount = 0;
  let cursor;
  let pages = 0;
  while (true) {
    pages++;
    const params = {
      locationId,
      contactId,
      channel: 'Email',
      limit: 100,
      startDate: new Date(0).toISOString(),
      endDate: new Date().toISOString()
    };
    if (cursor) params.cursor = cursor;
    const r = await ghlGet('/conversations/messages/export', params);
    const msgs = r.messages || [];
    for (const m of msgs) {
      emailCount++;
      rows.push(
        rowFromMessage(m, meta, userMap, {
          category: 'email',
          channel: 'EMAIL',
          direction: m.direction || m.meta?.email?.direction || '',
          from: m.meta?.email?.from || m.from || '',
          to: (m.meta?.email?.to || []).join('; ') || m.to || '',
          subject: m.meta?.email?.subject || ''
        })
      );
    }
    if (msgs.length < 100 || !r.nextPage) break;
    cursor = r.lastMessageId;
    if (pages > 50) break;
  }
  console.log(`Emails: ${emailCount}`);

  return rows;
}

// ── HTML + PDF ───────────────────────────────────────────────────────────────
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildContactBundleHtml(records, displayTz, accountTzLabel) {
  const byContact = new Map();
  for (const r of records) {
    const cid = r.contactId || 'unknown';
    if (!byContact.has(cid)) byContact.set(cid, []);
    byContact.get(cid).push(r);
  }

  const initials = (name) => {
    const parts = String(name || '')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (!parts.length) return '?';
    return ((parts[0][0] || '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
  };

  // displayTz: undefined = machine local (matches GHL browser UI for most users)
  const tz = displayTz || undefined;
  const tzOpts = (o) => (tz ? { ...o, timeZone: tz } : o);

  // Dates from GHL are absolute UTC (…Z). Always parse as real Instant — do NOT
  // reinterpret wall-clock in account TZ (that was wrong when API sends real Z).
  const toDate = (d) => parseGhlDate(d, null);

  const dayKey = (d) => {
    const t = toDate(d);
    if (!t || isNaN(t)) return '';
    try {
      return t.toLocaleDateString('en-CA', tzOpts({}));
    } catch {
      return t.toISOString().slice(0, 10);
    }
  };
  const dayLabel = (d) => {
    const t = toDate(d);
    return !t || isNaN(t) ? '' : t.toLocaleDateString('en-US', tzOpts({ month: 'short', day: 'numeric' }));
  };
  const timeLabel = (d) => {
    const t = toDate(d);
    return !t || isNaN(t)
      ? ''
      : t.toLocaleTimeString('en-US', tzOpts({ hour: 'numeric', minute: '2-digit', hour12: true }));
  };
  const formatDuration = (secs) => {
    const s = parseInt(secs, 10);
    if (!Number.isFinite(s) || s <= 0) return '';
    if (s < 60) return `${s}s`;
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (s < 3600) return `${m}m ${sec}s`;
    return `${h}h ${m}m ${sec}s`;
  };

  const displaySender = (r, meta, cid) => {
    const outbound = String(r.direction || '').toLowerCase() === 'outbound';
    if (!outbound) return meta.contactName || cid;
    if (r.outboundKind === 'AI' || r.autoReply) return 'AI';
    if (r.outboundKind === 'Automation' || r.workflowId) return 'Automation';
    return r.senderName || 'Team';
  };

  /** Bucket for top summary — mutually exclusive; only buckets with count > 0 are shown. */
  const summaryBucket = (r) => {
    if (r.outboundKind === 'AI' || r.autoReply) return 'AI';
    if (
      r.outboundKind === 'Automation' ||
      r.workflowId ||
      String(r.source || '').toLowerCase() === 'workflow'
    ) {
      return 'Automation';
    }
    const ch = String(r.channel || r.category || '');
    if (r.category === 'call' || r.isIvr || /call|voicemail/i.test(ch)) return 'Call';
    if (r.category === 'email' || /^email$/i.test(ch)) return 'Email';
    if (/whatsapp/i.test(ch)) return 'WhatsApp';
    if (/facebook/i.test(ch)) return 'Facebook';
    if (/instagram/i.test(ch)) return 'Instagram';
    if (/live\s*chat|webchat/i.test(ch)) return 'Live Chat';
    if (/gmb/i.test(ch)) return 'GMB';
    if (/sms/i.test(ch) || r.category === 'sms') return 'SMS';
    return ch.trim() ? ch.replace(/_/g, ' ') : 'Other';
  };

  const buildSummaryHtml = (rows) => {
    const counts = {};
    for (const r of rows) {
      const b = summaryBucket(r);
      counts[b] = (counts[b] || 0) + 1;
    }
    const preferred = ['SMS', 'Automation', 'AI', 'Call'];
    const lines = [];
    for (const key of preferred) {
      if (counts[key] > 0) lines.push({ key, n: counts[key] });
      delete counts[key];
    }
    // Any other types with count > 0
    for (const key of Object.keys(counts).sort()) {
      if (counts[key] > 0) lines.push({ key, n: counts[key] });
    }
    if (!lines.length) return '';
    const total = rows.length;
    return (
      '<div class="summary">' +
      '<div class="summary-title">Summary</div>' +
      lines
        .map(
          (l) =>
            '<div class="summary-row"><span class="summary-label">' +
            esc(l.key) +
            '</span><span class="summary-count">' +
            l.n +
            '</span></div>'
        )
        .join('') +
      '<div class="summary-row summary-total"><span class="summary-label">Total</span><span class="summary-count">' +
      total +
      '</span></div>' +
      '</div>'
    );
  };

  let sections = '';
  for (const [cid, rows] of byContact) {
    const meta = rows[0] || {};
    const name = esc(meta.contactName || cid);

    const header =
      '<div class="export-head">' +
      '<div class="eh-title">Conversation Export for <span class="eh-name">' +
      name +
      '</span> ' +
      '<span class="eh-id">(' +
      esc(cid) +
      ')</span></div>' +
      (meta.contactEmail ? '<div class="eh-sub">Email: ' + esc(meta.contactEmail) + '</div>' : '') +
      (meta.contactPhone ? '<div class="eh-sub">Phone: ' + esc(meta.contactPhone) + '</div>' : '') +
      '<div class="eh-sub">Exported at ' +
      esc(new Date().toLocaleString('en-US', tzOpts({ hour12: true }))) +
      (tz ? ' (' + esc(tz) + ')' : '') +
      '</div>' +
      buildSummaryHtml(rows) +
      '<div class="eh-tip">Attachments are in <b>attachments/</b> next to this export. ' +
      'Open this HTML in the browser and <b>Cmd/Ctrl-click</b> links to open media in a new tab.</div>' +
      '</div>';

    let inbox =
      '<div class="inbox">' +
      '<div class="inbox-bar"><div class="ib-av">' +
      esc(initials(meta.contactName || cid)) +
      '</div>' +
      '<div class="ib-name">' +
      name +
      '</div></div>' +
      '<div class="thread">';

    let lastDay = null;
    for (const r of rows) {
      const dk = dayKey(r.dateAdded);
      if (dk && dk !== lastDay) {
        lastDay = dk;
        inbox += '<div class="daysep"><span>\u{1F4C5} ' + esc(dayLabel(r.dateAdded)) + '</span></div>';
      }

      const outbound = String(r.direction || '').toLowerCase() === 'outbound';
      const side = outbound ? 'out' : 'in';
      const senderName = displaySender(r, meta, cid);
      const avInit = esc(initials(senderName === 'Automation' || senderName === 'AI' ? senderName : senderName));
      const channel = esc(r.channel || r.category || '');
      const isCall = r.category === 'call' || /call/i.test(channel);

      // Channel badge + Automation/AI tag
      let badges = '';
      if (channel) badges += '<div class="badge">☎︎ ' + channel + '</div>';
      if (senderName === 'Automation') badges += '<div class="badge badge-auto">Automation</div>';
      if (senderName === 'AI') badges += '<div class="badge badge-ai">AI</div>';

      let inner = badges;
      inner += '<div class="sender">' + esc(senderName) + '</div>';
      if (r.subject) inner += '<div class="subj">' + esc(r.subject) + '</div>';

      // Build attachment HTML first — shown BEFORE transcript on calls (PDF viewers
      // block absolute file:// links; use RELATIVE paths next to the PDF/HTML).
      const atts = Array.isArray(r.attachments) ? r.attachments.filter(Boolean) : [];
      let attHtml = '';
      for (const att of atts) {
        const fileUrl =
          typeof att === 'string' ? att : att.fileUrl || att.originalUrl || '';
        let rel =
          typeof att === 'object' && att.relPath
            ? String(att.relPath).replace(/\\/g, '/')
            : '';
        if (!rel && typeof att === 'string' && /^file:\/\//i.test(att)) {
          const abs = decodeURI(att.replace(/^file:\/\//i, ''));
          rel = path.relative(OUT_DIR, abs).replace(/\\/g, '/');
        }
        if (!rel && !fileUrl) continue;

        const kind =
          typeof att === 'object' && att.kind
            ? att.kind
            : guessKindFromName(rel || fileUrl);
        // Relative href for clicks + img src (works in HTML and in Puppeteer file:// load).
        const openHref = rel || fileUrl;
        const imgSrc = rel || openHref;

        const aOpen =
          '<a href="' +
          esc(openHref) +
          '" target="_blank" rel="noopener noreferrer">';
        if (kind === 'image') {
          attHtml +=
            '<div class="att-img">' +
            aOpen +
            '<img src="' +
            esc(imgSrc) +
            '" /></a></div>';
          attHtml +=
            '<div class="att">' +
            aOpen +
            '\u{1F5BC} Open image</a> <span class="att-path">' +
            esc(path.basename(openHref)) +
            '</span></div>';
        } else if (kind === 'video') {
          attHtml +=
            '<div class="att att-video">' +
            aOpen +
            '\u{1F3AC} Open video</a> <span class="att-path">' +
            esc(path.basename(openHref)) +
            '</span></div>';
        } else if (kind === 'audio') {
          attHtml +=
            '<div class="att att-audio">' +
            aOpen +
            '\u{1F3B5} Open recording</a> <span class="att-path">' +
            esc(path.basename(openHref)) +
            '</span></div>';
        } else {
          attHtml +=
            '<div class="att">' +
            aOpen +
            '\u{1F4CE} Open file</a> <span class="att-path">' +
            esc(path.basename(openHref)) +
            '</span></div>';
        }
      }

      if (isCall) {
        const isIvrCall = r.isIvr || /ivr/i.test(String(r.channel || ''));
        // Prefer recording-file duration (matches GHL player 0:11); else API duration for normal calls.
        const dur = formatDuration(r.durationSeconds);
        const callLabel = isIvrCall
          ? 'IVR Call'
          : 'Call' + (r.status ? ' ' + esc(r.status) : ' completed');
        inner +=
          '<div class="callrow">\u{1F4DE} ' +
          callLabel +
          (dur ? ' · ' + esc(dur) : '') +
          '</div>';
        // Attachments BEFORE transcript (GHL attachment URLs only — e.g. Twilio recordings)
        inner += attHtml;
        const t = r.transcription || '';
        if (t) {
          inner +=
            '<div class="transcript"><div class="tr-h">Transcript</div>' +
            esc(t).replace(/\r?\n/g, '<br>') +
            '</div>';
        }
      } else {
        const body = esc(r.body || '').replace(/\r?\n/g, '<br>');
        if (body) inner += '<div class="body">' + body + '</div>';
        inner += attHtml;
      }
      if (!inner) inner = '<div class="body empty">(no content)</div>';

      // Name (small) immediately before the timestamp
      inbox +=
        '<div class="row ' +
        side +
        '">' +
        '<div class="av">' +
        avInit +
        '</div>' +
        '<div class="bcol">' +
        '<div class="bubble">' +
        inner +
        '</div>' +
        '<div class="time"><span class="time-name">' +
        esc(senderName) +
        '</span> ' +
        esc(timeLabel(r.dateAdded)) +
        '</div>' +
        '</div>' +
        '</div>';
    }
    inbox += '</div></div>';
    sections += '<section class="contact">' + header + inbox + '</section>';
  }

  return (
    '<!doctype html><html><head><meta charset="utf-8"><style>' +
    '*{box-sizing:border-box;} body{font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2937;margin:0;padding:20px;font-size:13px;background:#fff;}' +
    '.contact{margin-bottom:34px;page-break-inside:auto;}' +
    '.export-head{margin-bottom:12px;}' +
    '.eh-title{font-size:16px;font-weight:600;color:#111827;}' +
    '.eh-name{color:#2563eb;} .eh-id{color:#6b7280;font-weight:400;font-size:12px;}' +
    '.eh-sub{color:#6b7280;font-size:12px;margin-top:2px;}' +
    '.summary{margin:12px 0;padding:10px 12px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;max-width:320px;}' +
    '.summary-title{font-weight:700;font-size:13px;color:#0f172a;margin-bottom:6px;}' +
    '.summary-row{display:flex;justify-content:space-between;gap:16px;font-size:12px;padding:3px 0;color:#334155;}' +
    '.summary-label{font-weight:600;}' +
    '.summary-count{font-variant-numeric:tabular-nums;color:#0f172a;}' +
    '.summary-total{border-top:1px solid #e2e8f0;margin-top:4px;padding-top:6px;font-weight:700;}' +
    '.eh-tip{margin-top:8px;padding:8px 10px;background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;color:#9a3412;font-size:12px;}' +
    '.inbox{border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;}' +
    '.inbox-bar{display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid #eef0f3;background:#fafbfc;}' +
    '.ib-av{width:30px;height:30px;border-radius:50%;background:#fcd34d;color:#78350f;font-weight:700;font-size:12px;display:flex;align-items:center;justify-content:center;}' +
    '.ib-name{font-weight:600;color:#111827;}' +
    '.thread{padding:16px;background:#fff;}' +
    '.daysep{text-align:center;margin:16px 0;}' +
    '.daysep span{background:#f1f5f9;color:#64748b;font-size:11px;padding:4px 12px;border-radius:999px;}' +
    '.row{display:flex;align-items:flex-end;gap:8px;margin:12px 0;}' +
    '.row.out{flex-direction:row-reverse;}' +
    '.av{width:28px;height:28px;border-radius:50%;flex:0 0 28px;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;color:#fff;background:#60a5fa;}' +
    '.row.in .av{background:#fcd34d;color:#78350f;}' +
    '.bcol{max-width:74%;display:flex;flex-direction:column;}' +
    '.row.out .bcol{align-items:flex-end;}' +
    '.bubble{padding:9px 12px;border-radius:14px;line-height:1.45;background:#f1f5f9;}' +
    '.row.in .bubble{border-bottom-left-radius:4px;}' +
    '.row.out .bubble{background:#dbeafe;border-bottom-right-radius:4px;}' +
    '.badge{display:inline-block;background:#ecfdf5;color:#047857;font-size:10px;font-weight:600;padding:2px 8px;border-radius:6px;margin-bottom:5px;margin-right:4px;}' +
    '.badge-auto{background:#f3e8ff;color:#6b21a8;}' +
    '.badge-ai{background:#e0e7ff;color:#3730a3;}' +
    '.sender{font-size:10px;font-weight:700;color:#475569;margin-bottom:3px;}' +
    '.subj{font-weight:600;margin-bottom:3px;}' +
    '.body{white-space:normal;word-break:break-word;}' +
    '.body.empty{color:#9ca3af;font-style:italic;}' +
    '.callrow{font-weight:600;color:#065f46;}' +
    '.transcript{margin-top:12px;background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:8px 10px;font-size:12px;color:#374151;}' +
    '.transcript .tr-h{font-weight:700;color:#2563eb;margin-bottom:4px;}' +
    '.att{margin-top:6px;font-size:12px;} .att a{color:#1155cc;text-decoration:underline;font-weight:700;}' +
    '.att-path{color:#94a3b8;font-size:10px;margin-left:6px;}' +
    '.att-audio a{color:#0f766e;} .att-video a{color:#9a3412;}' +
    '.att-img{margin-top:8px;} .att-img img{max-width:100%;width:420px;border-radius:10px;border:1px solid #e5e7eb;}' +
    '.att-img a{display:inline-block;}' +
    '.time{font-size:10px;color:#9ca3af;margin:3px 4px 0;}' +
    '.time-name{font-weight:600;color:#64748b;margin-right:4px;}' +
    '</style></head><body>' +
    sections +
    '</body></html>'
  );
}

async function buildPdf(htmlPath) {
  const puppeteer = require('puppeteer');
  // Load via file:// so local attachment images/videos resolve, and allow file access.
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--allow-file-access-from-files',
      '--disable-web-security'
    ]
  });
  try {
    const page = await browser.newPage();
    const fileUrl = fileUrlFromPath(htmlPath);
    try {
      await page.goto(fileUrl, { waitUntil: 'networkidle0', timeout: 120000 });
    } catch (e) {
      console.warn('page.goto timed out, rendering anyway:', e.message);
    }
    return await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '16mm', bottom: '16mm', left: '14mm', right: '14mm' }
    });
  } finally {
    await browser.close().catch(() => {});
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('Local Contact Bundle PDF');
  console.log({ contactId, locationId, out: OUT_PDF });

  const [locationTz, userMap] = await Promise.all([fetchTimezone(), fetchUserMap()]);
  // Default display = location timezone (matches GHL sub-account). --timezone local = machine.
  let displayTz;
  if (tzArg === 'local') {
    displayTz = undefined;
  } else if (!tzArg || tzArg === 'location' || tzArg === 'account') {
    displayTz = locationTz || undefined;
  } else {
    displayTz = tzArg;
  }
  console.log('Location TZ:', locationTz || '(unknown)');
  console.log(
    'Display TZ:',
    displayTz || Intl.DateTimeFormat().resolvedOptions().timeZone || 'local'
  );
  console.log('Users mapped:', Object.keys(userMap).length);

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const rows = await walkContact(userMap);
  await enrichUserMap(
    userMap,
    rows.map((r) => r.userId)
  );
  // Re-stamp human sender names (don't overwrite Automation / AI)
  for (const r of rows) {
    if (r.outboundKind === 'Automation' || r.outboundKind === 'AI') continue;
    if (r.userId && userMap[r.userId]) r.senderName = userMap[r.userId];
  }
  console.log('Users mapped:', Object.keys(userMap).length);
  if (locationTz) for (const r of rows) r.timezone = locationTz;

  rows.sort((a, b) => {
    const ta = parseGhlDate(a.dateAdded, null)?.getTime() || 0;
    const tb = parseGhlDate(b.dateAdded, null)?.getTime() || 0;
    return ta - tb;
  });

  console.log(`Total records: ${rows.length}`);
  const withAtt = rows.filter((r) => r.attachments?.length).length;
  const autoN = rows.filter((r) => r.outboundKind === 'Automation').length;
  const aiN = rows.filter((r) => r.outboundKind === 'AI').length;
  console.log(`With attachments: ${withAtt} | Automation: ${autoN} | AI: ${aiN}`);

  if (rows.length === 0) {
    console.error('No messages found for this contact.');
    process.exit(1);
  }

  // Download every remote attachment locally, rewrite links to file://
  await downloadAllAttachments(rows);

  const sample = rows.find((r) => (r.body || '').includes('Sorry we missed')) || rows[0];
  if (sample) {
    const parsed = parseGhlDate(sample.dateAdded, null);
    const fmtOpts = { hour12: true, ...(displayTz ? { timeZone: displayTz } : {}) };
    console.log('Date sample:', {
      raw: sample.dateAdded,
      displayed: parsed ? parsed.toLocaleString('en-US', fmtOpts) : null,
      kind: sample.outboundKind || '(none)',
      source: sample.source || '',
      atts: sample.attachments?.length || 0
    });
  }

  fs.writeFileSync(
    path.join(OUT_DIR, 'messages.json'),
    JSON.stringify(
      rows.map(({ transcription, ...r }) => ({
        ...r,
        transcription: transcription ? `[${String(transcription).length} chars]` : ''
      })),
      null,
      2
    )
  );

  console.log('Rendering PDF…');
  const html = buildContactBundleHtml(rows, displayTz, locationTz);
  const htmlPath = path.join(OUT_DIR, 'contact-bundle.html');
  fs.writeFileSync(htmlPath, html, 'utf8');
  const pdf = await buildPdf(htmlPath);
  fs.writeFileSync(OUT_PDF, pdf);

  console.log('Done.');
  console.log(`PDF:  ${OUT_PDF}`);
  console.log(`HTML: ${htmlPath}`);
  console.log(`Attachments: ${path.join(OUT_DIR, 'attachments')}`);
  console.log(`Size: ${(pdf.length / 1024).toFixed(1)} KB`);
  console.log('');
  console.log('Play media: open contact-bundle.html in browser, Cmd/Ctrl-click attachment links.');
}

main().catch((err) => {
  console.error('Failed:', err.response?.data || err.message || err);
  process.exit(1);
});
