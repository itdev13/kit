const express = require('express');
const router = express.Router();
const ghlService = require('../services/ghlService');
const OAuthToken = require('../models/OAuthToken');
const CompanyLocation = require('../models/CompanyLocation');
const Referral = require('../models/Referral');
const logger = require('../utils/logger');
const { logError } = require('../utils/errorLogger');
const AppConfig = require('../models/AppConfig');

/**
 * OAuth Routes - Simple Implementation
 */

/**
 * Start OAuth flow
 */
router.get('/authorize', (req, res) => {
  const { ref, campaign } = req.query;

  const scopes = [
    "conversations.readonly",
    "conversations.write",
    "conversations/message.readonly",
    "conversations/message.write",
    "conversations/reports.readonly",
    "locations.readonly",
    "contacts.readonly",
    "contacts.write",
    "charges.readonly",
    "charges.write",
    "oauth.readonly",
    "opportunities.readonly",
    "opportunities.write",
    "forms.readonly",
    "links.readonly",
    "locations/customValues.readonly",
    "locations/customFields.readonly",
    "locations/tasks.readonly",
    "voice-ai-agents.readonly",
    "voice-ai-dashboard.readonly",
    "locations/templates.readonly",
    "socialplanner/post.readonly",
    "users.readonly",
    "emails/builder.readonly",
    "marketplace-installer-details.readonly",
    "calendars.readonly",
    "calendars/events.readonly",
    "invoices.readonly",
    "payments/orders.readonly",
    "payments/transactions.readonly",
    "payments/subscriptions.readonly",
    "surveys.readonly",
    "businesses.readonly",
    "products.readonly",
    "medias.readonly",
    "notes.readonly",
  ].join(' ');

  // Encode referral info in state parameter if provided
  let stateParam = '';
  if (ref) {
    const stateData = JSON.stringify({ ref, campaign: campaign || '' });
    const stateEncoded = Buffer.from(stateData).toString('base64');
    stateParam = `&state=${encodeURIComponent(stateEncoded)}`;
    logger.info('OAuth authorize with referral:', { ref, campaign });
  }

  const authUrl = `https://marketplace.gohighlevel.com/v2/oauth/chooselocation?` +
    `response_type=code&` +
    `client_id=${process.env.GHL_CLIENT_ID}&` +
    `redirect_uri=${encodeURIComponent(process.env.GHL_REDIRECT_URI)}&` +
    `scope=${encodeURIComponent(scopes)}${stateParam}`;

  res.redirect(authUrl);
});

/**
 * OAuth callback
 */
router.get('/callback', async (req, res) => {
  const { code, state, app } = req.query;
  console.log("query: ", req.query)

  if (!code) {
    return res.status(400).send('Authorization code not provided');
  }

  // App identity: the lite "Export Messages" GHL app is configured with a redirect_uri of
  // .../oauth/callback?app=lite (the router is mounted at /oauth, NOT /api/oauth), so the query
  // param is the authoritative signal (GHL controls the authorize URL, so we can't rely on `state`).
  // We still allow app:'lite' in state as a fallback.
  let referralCode = null;
  let referralCampaign = null;
  let isLite = app === 'lite'; // true when the install came from the lite "Export Messages" app
  if (state) {
    try {
      console.log("state: ", state);
      const stateData = JSON.parse(Buffer.from(state, 'base64').toString('utf-8'));
      console.log("stateData: ", stateData);
      referralCode = stateData.ref || null;
      referralCampaign = stateData.campaign || null;
      if (stateData.app === 'lite') isLite = true; // fallback signal (query param takes precedence)
      if (referralCode) {
        logger.info('Referral code detected:', { ref: referralCode, campaign: referralCampaign });
      }
      if (isLite) logger.info('Lite (Export Messages) install detected');
    } catch (e) {
      logger.warn('Failed to decode state parameter:', state);
    }
  }

  // App-aware branding for the callback pages. Lite = "Export Messages" (own logo, no website
  // button); premium = "ExportKit". Referenced by all three HTML pages below.
  const brand = isLite
    ? {
        name: 'Export Messages', icon: '/assets/export-messages-icon.png', website: null, poweredBy: false,
        // Lite "Export Messages" identity: indigo accents on a soft indigo page.
        pageBg: 'linear-gradient(135deg, #6366f1 0%, #4338ca 100%)',
        boxBg: 'linear-gradient(135deg, #eef2ff 0%, #e0e7ff 100%)',
        boxBorder: '#4f46e5',
        heading: '#3730a3',
        accent: '#4f46e5',
        linkColor: '#4f46e5'
      }
    : {
        name: 'ExportKit', icon: '/assets/icon.png', website: 'https://export.vaultsuite.store', poweredBy: true,
        // Premium "ExportKit": EXACT current hardcoded colors so the page renders byte-for-byte identically.
        pageBg: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
        boxBg: 'linear-gradient(135deg, #EEF2FF 0%, #E0E7FF 100%)',
        boxBorder: '#2563EB',
        heading: '#1E40AF',
        accent: '#2563EB',
        linkColor: '#667eea'
      };

  try {
    logger.info('Exchanging code for token...', { isLite });

    // Exchange with the correct app's client credentials (lite vs premium).
    const tokenData = await ghlService.getAccessToken(code, isLite);

    // Check if this is Sub-Account-level or Company-level installation
    const isLocationLevel = !!tokenData.locationId;
    
    if (isLocationLevel) {
      // ===== SUB-ACCOUNT-LEVEL INSTALLATION =====
      logger.info('📍 Sub-Account-level installation for:', tokenData.locationId);
      
      // App-scope filter: lite and premium tokens are SEPARATE rows for the same location.
      // Premium matches lite false OR missing (`$ne: true`) so legacy rows aren't clobbered;
      // lite matches only `lite: true`. The update always stamps the canonical `lite` value.
      const liteFilter = isLite ? { lite: true } : { lite: { $ne: true } };

      // Save sub-account token
      let savedToken = await OAuthToken.findOneAndUpdate(
        { locationId: tokenData.locationId, ...liteFilter },
        {
          locationId: tokenData.locationId,
          companyId: tokenData.companyId,
          tokenType: 'location',
          accessToken: tokenData.accessToken,
          refreshToken: tokenData.refreshToken,
          expiresAt: new Date(Date.now() + tokenData.expiresIn * 1000),
          isActive: true,
          lite: isLite
        },
        { upsert: true, new: true }
      );

      // Fetch sub-account details (use the lite token for lite installs)
      logger.info('Fetching sub-account details...');
      const locationDetails = await ghlService.getLocationDetails(tokenData.locationId, { lite: isLite });

      // Update with sub-account details
      savedToken = await OAuthToken.findOneAndUpdate(
        { locationId: tokenData.locationId, ...liteFilter },
        { ...locationDetails },
        { new: true }
      );

      logger.info('✅ OAuth successful for sub-account:', savedToken.locationName || tokenData.locationId);

      // Save referral tracking if referral code present
      if (referralCode) {
        try {
          await Referral.findOneAndUpdate(
            { locationId: tokenData.locationId },
            {
              referralCode,
              companyId: tokenData.companyId,
              locationId: tokenData.locationId,
              campaign: referralCampaign,
              status: 'installed',
              testing: await AppConfig.hasValue('internalTestingCompanyIds', tokenData.companyId),
              installedAt: new Date()
            },
            { upsert: true, new: true }
          );
          logger.info('✅ Referral tracked:', { ref: referralCode, locationId: tokenData.locationId });
        } catch (refErr) {
          logger.warn('Failed to save referral (non-blocking):', refErr.message);
        }
      }

      var displayName = savedToken.locationName
        ? `${savedToken.locationName} (${savedToken.locationId})`
        : `Sub-Account ID: ${savedToken.locationId}`;
      var successMessage = `Sub-Account: ${displayName}`;
      
    } else {
      // ===== COMPANY-LEVEL INSTALLATION =====
      logger.info('🏢 Company-level installation for:', tokenData.companyId);
      
      // App-scope filter (see sub-account branch): keep lite/premium company rows separate.
      const liteFilter = isLite ? { lite: true } : { lite: { $ne: true } };

      // Save company-level token
      await OAuthToken.findOneAndUpdate(
        { companyId: tokenData.companyId, tokenType: 'company', ...liteFilter },
        {
          companyId: tokenData.companyId,
          tokenType: 'company',
          accessToken: tokenData.accessToken,
          refreshToken: tokenData.refreshToken,
          expiresAt: new Date(Date.now() + tokenData.expiresIn * 1000),
          isActive: true,
          lite: isLite
        },
        { upsert: true, new: true }
      );

      // Fetch all sub-accounts and store companyId -> locationIds mapping
      logger.info('Fetching all sub-accounts for company...');
      const locations = await ghlService.getCompanyLocations(tokenData.companyId, tokenData.accessToken);
      const locationIds = locations.map(loc => loc.locationId);

      await CompanyLocation.findOneAndUpdate(
        { companyId: tokenData.companyId },
        { companyId: tokenData.companyId, locationIds },
        { upsert: true, new: true }
      );

      logger.info(`✅ Stored ${locationIds.length} location IDs for company ${tokenData.companyId}`);

      logger.info('✅ OAuth successful for company:', tokenData.companyId);

      // Save referral tracking if referral code present
      if (referralCode) {
        try {
          await Referral.findOneAndUpdate(
            { companyId: tokenData.companyId, locationId: { $exists: false } },
            {
              referralCode,
              companyId: tokenData.companyId,
              campaign: referralCampaign,
              status: 'installed',
              testing: await AppConfig.hasValue('internalTestingCompanyIds', tokenData.companyId),
              installedAt: new Date()
            },
            { upsert: true, new: true }
          );
          logger.info('✅ Referral tracked (company):', { ref: referralCode, companyId: tokenData.companyId });
        } catch (refErr) {
          logger.warn('Failed to save referral (non-blocking):', refErr.message);
        }
      }

      var successMessage = `Successfully connected to your account`;
    }

    // Feature catalog shown on the welcome page, grouped like the in-app sidebar so what a new user
    // reads here matches what they'll actually see. The lite "Export Messages" app ONLY exports
    // messages/conversations — it does NOT have Contacts/Content/Commerce exports or imports — so lite
    // gets a message-only catalog. Premium "ExportKit" gets the full set. Brand-aware via `brand`.
    const featureGroups = isLite
      ? [
          {
            title: 'Conversations',
            items: [
              'Messages — full history with channel, date &amp; user filters',
              'SMS, WhatsApp, Email, Facebook &amp; Instagram',
              'Activity Messages &amp; Group Messages',
              'All Contact Communication in one bundle',
            ],
          },
          {
            title: 'Filters &amp; Output',
            items: [
              'Date range, channel &amp; message-type filters',
              'Export to CSV or JSON',
              'Advanced export with conversationId',
              'Email metadata (Subject, From, To, CC, BCC)',
            ],
          },
        ]
      : [
          {
            title: 'Conversations',
            items: [
              'Messages — full history with channel, date &amp; user filters',
              'Activity Messages &amp; Group Messages',
              'All Contact Communication in one bundle',
              'Messages by Tag',
              'Call Transcriptions &amp; Call Recordings',
            ],
          },
          {
            title: 'Contacts &amp; CRM',
            items: [
              'Contacts (with custom fields)',
              'Opportunities &amp; Stage History',
              'Form Submissions',
            ],
          },
          {
            title: 'Content',
            items: [
              'Notes (account-wide) &amp; Notes by Tag',
              'Tasks, Templates &amp; Links',
              'Voice AI call logs',
              'Custom Fields, Custom Values &amp; Tags',
            ],
          },
          {
            title: 'Commerce',
            items: [
              'Appointments &amp; Calendars',
              'Invoices, Payment Orders &amp; Transactions',
              'Subscriptions, Surveys &amp; Products',
              'Businesses &amp; Media Files',
            ],
          },
          {
            title: 'Import &amp; more',
            items: [
              'Import Contacts, Notes, Opportunities &amp; Tasks from CSV',
              'Import Custom Fields &amp; Custom Values',
              'Contact timeline as a shareable PDF / HTML document',
              'Volume discounts — the more you export, the less per record',
            ],
          },
        ];

    const featureCards = featureGroups.map((g) => `
              <div class="feature-card">
                <div class="feature-card-title">${g.title}</div>
                <ul class="feature-list">
                  ${g.items.map((it) => `<li>${it}</li>`).join('')}
                </ul>
              </div>`).join('');

    res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Welcome to ${brand.name}</title>
        <link rel="icon" type="image/svg+xml" href="/assets/favicon.svg">
        <link rel="preconnect" href="https://fonts.googleapis.com">
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap">
        <style>
          :root {
            --accent: ${brand.accent};
            --heading: ${brand.heading};
            --link: ${brand.linkColor};
            --ink: #0f172a;
            --ink-soft: #475569;
            --ink-faint: #94a3b8;
            --line: #e8ecf3;
            --card: #ffffff;
            --surface: #f6f8fc;
            --ok: #16a34a;
            --font: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
          }
          * { box-sizing: border-box; }
          html, body { margin: 0; }
          body {
            font-family: var(--font);
            color: var(--ink);
            background: ${brand.pageBg};
            min-height: 100vh;
            padding: 40px 16px;
            display: flex;
            align-items: flex-start;
            justify-content: center;
            -webkit-font-smoothing: antialiased;
          }
          .card {
            width: 100%;
            max-width: 720px;
            background: var(--card);
            border-radius: 20px;
            box-shadow: 0 24px 60px rgba(15,23,42,0.28), 0 2px 8px rgba(15,23,42,0.12);
            overflow: hidden;
          }
          /* Header band */
          .hero {
            position: relative;
            padding: 40px 40px 28px;
            text-align: center;
            background:
              radial-gradient(120% 140% at 50% -20%, rgba(255,255,255,0.9), rgba(255,255,255,0) 60%),
              ${brand.boxBg};
            border-bottom: 1px solid var(--line);
          }
          .badge {
            display: inline-flex; align-items: center; gap: 7px;
            background: rgba(22,163,74,0.12); color: var(--ok);
            font-size: 12px; font-weight: 700; letter-spacing: .02em;
            padding: 6px 12px; border-radius: 999px; margin-bottom: 18px;
          }
          .badge .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ok); box-shadow: 0 0 0 4px rgba(22,163,74,0.18); }
          /* The app icon already has its own (dark, rounded) background, so no white tile — just a soft
             shadow + matching radius. object-fit:cover fills the rounded box cleanly. */
          .logo { width: 66px; height: 66px; border-radius: 16px; object-fit: cover; box-shadow: 0 6px 18px rgba(15,23,42,0.22); display: block; margin: 0 auto; }
          .brand-name { margin-top: 12px; font-size: 15px; font-weight: 700; color: var(--ink); letter-spacing: -.01em; }
          .powered { font-size: 10.5px; font-weight: 600; color: var(--ink-faint); letter-spacing: .08em; text-transform: uppercase; margin-top: 2px; }
          h1 { font-size: 27px; font-weight: 800; letter-spacing: -.02em; margin: 16px 0 6px; text-wrap: balance; }
          .hero p { margin: 0; color: var(--ink-soft); font-size: 14.5px; }

          .body { padding: 28px 40px 36px; }

          /* How to access */
          .access {
            background: var(--surface);
            border: 1px solid var(--line);
            border-radius: 14px;
            padding: 20px 22px;
            margin-bottom: 30px;
          }
          .access h2 { font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: .07em; color: var(--heading); margin: 0 0 14px; }
          .steps { display: flex; flex-direction: column; gap: 12px; counter-reset: step; }
          .step { display: flex; align-items: flex-start; gap: 12px; font-size: 14px; color: var(--ink); }
          .step .n {
            counter-increment: step; flex: none;
            width: 24px; height: 24px; border-radius: 50%;
            background: var(--accent); color: #fff;
            font-size: 12.5px; font-weight: 700;
            display: flex; align-items: center; justify-content: center;
          }
          .step .n::before { content: counter(step); }
          .step strong { color: var(--accent); }
          .access .tip { margin: 14px 0 0; font-size: 12.5px; color: var(--ink-faint); }

          /* Features */
          .section-label { font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: .07em; color: var(--heading); margin: 0 0 4px; }
          .section-sub { margin: 0 0 18px; font-size: 13px; color: var(--ink-soft); }
          .feature-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 14px; }
          .feature-card { border: 1px solid var(--line); border-radius: 13px; padding: 16px 16px 6px; background: var(--card); }
          .feature-card-title { font-size: 13px; font-weight: 700; color: var(--ink); margin-bottom: 8px; }
          .feature-list { list-style: none; margin: 0 0 10px; padding: 0; }
          .feature-list li { position: relative; padding-left: 22px; margin: 8px 0; font-size: 13px; line-height: 1.45; color: var(--ink-soft); }
          .feature-list li::before {
            content: ""; position: absolute; left: 2px; top: 5px;
            width: 12px; height: 7px; border-left: 2px solid var(--accent); border-bottom: 2px solid var(--accent);
            transform: rotate(-45deg);
          }

          /* Footer actions */
          .footer { margin-top: 30px; padding-top: 22px; border-top: 1px solid var(--line); display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
          .footer .note { font-size: 13px; color: var(--ink-soft); display: flex; align-items: center; gap: 8px; }
          .footer .note .check { color: var(--ok); font-weight: 800; }
          .btn { display: inline-flex; align-items: center; gap: 8px; background: var(--accent); color: #fff; font-size: 14px; font-weight: 600; padding: 11px 20px; border-radius: 10px; text-decoration: none; transition: filter .15s, transform .05s; }
          .btn:hover { filter: brightness(1.07); }
          .btn:active { transform: translateY(1px); }

          @media (max-width: 560px) {
            body { padding: 20px 12px; }
            .hero { padding: 30px 22px 24px; }
            .body { padding: 22px 22px 28px; }
            h1 { font-size: 23px; }
            .feature-grid { grid-template-columns: 1fr; }
            .footer { flex-direction: column; align-items: stretch; }
            .btn { justify-content: center; }
          }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="hero">
            <div class="badge"><span class="dot"></span> Installation complete</div>
            <div>
              <img class="logo" src="${brand.icon}" alt="${brand.name}" onerror="this.style.display='none'">
              <div class="brand-name">${brand.name}</div>
              ${brand.poweredBy ? `<div class="powered">Powered by Vaultsuite</div>` : ""}
            </div>
            <h1>You're connected to ${brand.name}</h1>
            <p>${successMessage}</p>
          </div>

          <div class="body">
            <div class="access">
              <h2>Open the app</h2>
              <div class="steps">
                <div class="step"><span class="n"></span><span>Go to your sub-account dashboard in HighLevel.</span></div>
                <div class="step"><span class="n"></span><span>Find <strong>${brand.name}</strong> in the left navigation menu.</span></div>
                <div class="step"><span class="n"></span><span>Click it to launch the app and start exporting.</span></div>
              </div>
              <p class="tip">It appears as a new menu item in your sub-account's left sidebar.</p>
            </div>

            <p class="section-label">Everything you can export</p>
            <p class="section-sub">Pick a data type, set your filters, see the price up front, and download — ${isLite ? 'as CSV or JSON' : 'as CSV, JSON, or a shareable document'}.</p>
            <div class="feature-grid">
              ${featureCards}
            </div>

            <div class="footer">
              <span class="note"><span class="check">✓</span> You can close this window now.</span>
              ${brand.website ? `<a class="btn" href="${brand.website}" target="_blank" rel="noopener">Visit ${brand.name} →</a>` : ''}
            </div>
          </div>
        </div>
      </body>
      </html>
    `);

  } catch (error) {
    // Detect a reused/expired/invalid authorization code. GHL returns this a few ways:
    //   • { error: 'invalid_grant', error_description: '...authorization code...' }
    //   • { error: 'UnAuthorized!', error_description: 'Authorization code not found' }
    // All mean the code was already consumed (duplicate callback fire — browser prefetch, refresh,
    // link scanner) or expired. This is EXPECTED and harmless (the first callback already installed),
    // so show the friendly "already connected" page instead of a 500.
    const desc = String(error.response?.data?.error_description || '').toLowerCase();
    const isCodeReused =
      error.response?.data?.error === 'invalid_grant' ||
      desc.includes('authorization code') ||
      desc.includes('code not found');

    if (isCodeReused) {
      logger.info('OAuth callback: authorization code already used/expired (duplicate callback) — showing completion page');
      // Authorization already completed - show success message
      return res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>Already Connected — ${brand.name}</title>
          <link rel="icon" type="image/svg+xml" href="/assets/favicon.svg">
          <link rel="preconnect" href="https://fonts.googleapis.com">
          <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
          <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap">
          <style>
            :root {
              --accent: ${brand.accent};
              --heading: ${brand.heading};
              --link: ${brand.linkColor};
              --ink: #0f172a;
              --ink-soft: #475569;
              --ink-faint: #94a3b8;
              --line: #e8ecf3;
              --card: #ffffff;
              --surface: #f6f8fc;
              --ok: #16a34a;
              --font: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
            }
            * { box-sizing: border-box; }
            html, body { margin: 0; }
            body {
              font-family: var(--font);
              color: var(--ink);
              background: ${brand.pageBg};
              min-height: 100vh;
              padding: 40px 16px;
              display: flex;
              align-items: center;
              justify-content: center;
              -webkit-font-smoothing: antialiased;
            }
            .card {
              width: 100%;
              max-width: 540px;
              background: var(--card);
              border-radius: 20px;
              box-shadow: 0 24px 60px rgba(15,23,42,0.28), 0 2px 8px rgba(15,23,42,0.12);
              overflow: hidden;
            }
            .hero {
              padding: 40px 40px 28px;
              text-align: center;
              background:
                radial-gradient(120% 140% at 50% -20%, rgba(255,255,255,0.9), rgba(255,255,255,0) 60%),
                ${brand.boxBg};
              border-bottom: 1px solid var(--line);
            }
            .badge {
              display: inline-flex; align-items: center; gap: 7px;
              background: rgba(22,163,74,0.12); color: var(--ok);
              font-size: 12px; font-weight: 700; letter-spacing: .02em;
              padding: 6px 12px; border-radius: 999px; margin-bottom: 18px;
            }
            .badge .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ok); box-shadow: 0 0 0 4px rgba(22,163,74,0.18); }
            .logo { width: 62px; height: 62px; border-radius: 15px; object-fit: cover; box-shadow: 0 6px 18px rgba(15,23,42,0.22); display: block; margin: 0 auto; }
            .brand-name { margin-top: 12px; font-size: 15px; font-weight: 700; color: var(--ink); letter-spacing: -.01em; }
            .powered { font-size: 10.5px; font-weight: 600; color: var(--ink-faint); letter-spacing: .08em; text-transform: uppercase; margin-top: 2px; }
            h1 { font-size: 25px; font-weight: 800; letter-spacing: -.02em; margin: 16px 0 6px; text-wrap: balance; }
            .hero p { margin: 0; color: var(--ink-soft); font-size: 14.5px; }
            .body { padding: 26px 40px 34px; }
            .access {
              background: var(--surface);
              border: 1px solid var(--line);
              border-radius: 14px;
              padding: 20px 22px;
            }
            .access h2 { font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: .07em; color: var(--heading); margin: 0 0 14px; }
            .steps { display: flex; flex-direction: column; gap: 12px; counter-reset: step; }
            .step { display: flex; align-items: flex-start; gap: 12px; font-size: 14px; color: var(--ink); text-align: left; }
            .step .n {
              counter-increment: step; flex: none;
              width: 24px; height: 24px; border-radius: 50%;
              background: var(--accent); color: #fff;
              font-size: 12.5px; font-weight: 700;
              display: flex; align-items: center; justify-content: center;
            }
            .step .n::before { content: counter(step); }
            .step strong { color: var(--accent); }
            .access .tip { margin: 14px 0 0; font-size: 12.5px; color: var(--ink-faint); }
            .footer { margin-top: 24px; padding-top: 20px; border-top: 1px solid var(--line); display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
            .footer .note { font-size: 13px; color: var(--ink-soft); display: flex; align-items: center; gap: 8px; }
            .footer .note .check { color: var(--ok); font-weight: 800; }
            .btn { display: inline-flex; align-items: center; gap: 8px; background: var(--accent); color: #fff; font-size: 14px; font-weight: 600; padding: 10px 18px; border-radius: 10px; text-decoration: none; transition: filter .15s; }
            .btn:hover { filter: brightness(1.07); }
            @media (max-width: 520px) {
              body { padding: 20px 12px; }
              .hero { padding: 30px 22px 24px; }
              .body { padding: 22px 22px 28px; }
              h1 { font-size: 22px; }
              .footer { flex-direction: column; align-items: stretch; }
              .btn { justify-content: center; }
            }
          </style>
        </head>
        <body>
          <div class="card">
            <div class="hero">
              <div class="badge"><span class="dot"></span> Already connected</div>
              <div>
                <img class="logo" src="${brand.icon}" alt="${brand.name}" onerror="this.style.display='none'">
                <div class="brand-name">${brand.name}</div>
                ${brand.poweredBy ? `<div class="powered">Powered by Vaultsuite</div>` : ""}
              </div>
              <h1>You're all set with ${brand.name}</h1>
              <p>Your account is already connected — nothing more to do here.</p>
            </div>
            <div class="body">
              <div class="access">
                <h2>Open the app</h2>
                <div class="steps">
                  <div class="step"><span class="n"></span><span>Go to your sub-account dashboard in HighLevel.</span></div>
                  <div class="step"><span class="n"></span><span>Find <strong>${brand.name}</strong> in the left navigation menu.</span></div>
                  <div class="step"><span class="n"></span><span>Click it to launch the app and start exporting.</span></div>
                </div>
                <p class="tip">It appears as a new menu item in your sub-account's left sidebar.</p>
              </div>
              <div class="footer">
                <span class="note"><span class="check">✓</span> You can safely close this window.</span>
                ${brand.website ? `<a class="btn" href="${brand.website}" target="_blank" rel="noopener">Visit ${brand.name} →</a>` : ''}
              </div>
            </div>
          </div>
        </body>
        </html>
      `);
    }

    // Genuine failure (not a duplicate/expired code) — log as an error and show the error page.
    logError('OAuth callback error', error, { code: req.query?.code });

    // Other errors - show generic error page
    res.status(500).send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Connection Error — ${brand.name}</title>
        <link rel="icon" type="image/svg+xml" href="/assets/favicon.svg">
        <link rel="preconnect" href="https://fonts.googleapis.com">
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap">
        <style>
          :root {
            --ink: #0f172a; --ink-soft: #475569; --ink-faint: #94a3b8;
            --line: #e8ecf3; --card: #ffffff; --danger: #dc2626; --danger-bg: #fef2f2;
            --accent: ${brand.accent}; --link: ${brand.linkColor};
            --font: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
          }
          * { box-sizing: border-box; }
          html, body { margin: 0; }
          body {
            font-family: var(--font); color: var(--ink);
            background: ${brand.pageBg}; min-height: 100vh;
            padding: 40px 16px; display: flex; align-items: center; justify-content: center;
            -webkit-font-smoothing: antialiased;
          }
          .card { width: 100%; max-width: 500px; background: var(--card); border-radius: 20px; box-shadow: 0 24px 60px rgba(15,23,42,0.28), 0 2px 8px rgba(15,23,42,0.12); overflow: hidden; }
          .hero { padding: 36px 36px 24px; text-align: center; background: radial-gradient(120% 140% at 50% -20%, rgba(255,255,255,0.9), rgba(255,255,255,0) 60%), var(--danger-bg); border-bottom: 1px solid var(--line); }
          .badge { display: inline-flex; align-items: center; gap: 7px; background: rgba(220,38,38,0.1); color: var(--danger); font-size: 12px; font-weight: 700; padding: 6px 12px; border-radius: 999px; margin-bottom: 18px; }
          .badge .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--danger); box-shadow: 0 0 0 4px rgba(220,38,38,0.15); }
          .logo { width: 56px; height: 56px; border-radius: 14px; object-fit: cover; box-shadow: 0 6px 18px rgba(15,23,42,0.22); display: block; margin: 0 auto; }
          .brand-name { margin-top: 10px; font-size: 14px; font-weight: 700; color: var(--ink); }
          .powered { font-size: 10px; font-weight: 600; color: var(--ink-faint); letter-spacing: .08em; text-transform: uppercase; margin-top: 2px; }
          h1 { font-size: 23px; font-weight: 800; letter-spacing: -.02em; margin: 14px 0 6px; }
          .hero p { margin: 0; color: var(--ink-soft); font-size: 14px; }
          .body { padding: 24px 36px 32px; }
          .detail { background: var(--danger-bg); border: 1px solid #fecaca; color: #991b1b; font-size: 13px; border-radius: 10px; padding: 12px 14px; margin-bottom: 20px; word-break: break-word; }
          .actions { display: flex; flex-direction: column; gap: 10px; }
          .btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; font-size: 14px; font-weight: 600; padding: 11px 18px; border-radius: 10px; text-decoration: none; transition: filter .15s; }
          .btn-primary { background: var(--accent); color: #fff; }
          .btn-primary:hover { filter: brightness(1.07); }
          .btn-ghost { color: var(--link); }
          .btn-ghost:hover { text-decoration: underline; }
          .close { margin: 18px 0 0; text-align: center; font-size: 12.5px; color: var(--ink-faint); }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="hero">
            <div class="badge"><span class="dot"></span> Connection error</div>
            <div>
              <img class="logo" src="${brand.icon}" alt="${brand.name}" onerror="this.style.display='none'">
              <div class="brand-name">${brand.name}</div>
              ${brand.poweredBy ? `<div class="powered">Powered by Vaultsuite</div>` : ""}
            </div>
            <h1>We couldn't finish connecting</h1>
            <p>Something went wrong while connecting ${brand.name}. Please try installing again.</p>
          </div>
          <div class="body">
            <div class="detail">${error.message}</div>
            <div class="actions">
              ${brand.website ? `<a class="btn btn-primary" href="${brand.website}" target="_blank" rel="noopener">Try again</a>` : ''}
              ${brand.website ? `<a class="btn btn-ghost" href="${brand.website}" target="_blank" rel="noopener">Visit ${brand.name} website →</a>` : ''}
            </div>
            <p class="close">If this keeps happening, contact support and we'll help you connect.</p>
          </div>
        </div>
      </body>
      </html>
    `);
  }
});

/**
 * Check OAuth status
 */
router.get('/status', async (req, res) => {
  const { locationId } = req.query;

  if (!locationId) {
    return res.status(400).json({
      success: false,
      error: 'locationId required'
    });
  }

  try {
    const token = await OAuthToken.findActiveToken(locationId);
    
    res.json({
      success: true,
      connected: !!token,
      locationId,
      locationName: token?.locationName || null,
      locationDisplay: token?.locationName ? `${token.locationName} (${locationId})` : locationId,
      expiresAt: token?.expiresAt
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Get all connected sub-accounts for a company
 */
router.get('/locations', async (req, res) => {
  const { companyId } = req.query;

  if (!companyId) {
    return res.status(400).json({
      success: false,
      error: 'companyId required'
    });
  }

  try {
    const locations = await OAuthToken.findCompanyLocations(companyId);
    
    res.json({
      success: true,
      count: locations.length,
      locations: locations.map(loc => ({
        locationId: loc.locationId,
        locationName: loc.locationName,
        locationDisplay: loc.locationName ? `${loc.locationName} (${loc.locationId})` : loc.locationId,
        email: loc.locationEmail,
        phone: loc.locationPhone,
        address: loc.locationAddress,
        website: loc.locationWebsite,
        timezone: loc.locationTimezone,
        connectedAt: loc.createdAt
      }))
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;

