const axios = require('axios');
const logger = require('../utils/logger');
const AppConfig = require('../models/AppConfig');

/**
 * Billing Service - Handle pricing calculations and GHL Marketplace billing
 */

// App ID for rebilling config
const APP_ID = process.env.GHL_APP_ID || '694f93f8a6babf0c821b1356';

// Meter IDs for GHL Marketplace billing
const METER_IDS = {
  conversations: '69864aed1265653fdd7c0620',
  smsWhatsapp: '69864aed1265653fdd7c0620',
  email: '69864aed1265653fdd7c0620',
  notesAndTasks: '69864aed1265653fdd7c0620',
  opportunities: '69864aed1265653fdd7c0620',
  formSubmissions: '69864aed1265653fdd7c0620',
  links: '69864aed1265653fdd7c0620',
  socialPosts: '69864aed1265653fdd7c0620',
  callLogs: '69864aed1265653fdd7c0620',
  templates: '69864aed1265653fdd7c0620',
  businesses: '69864aed1265653fdd7c0620',
  customFields: '69864aed1265653fdd7c0620',
  customValues: '69864aed1265653fdd7c0620',
  tags: '69864aed1265653fdd7c0620',
  opportunityStageHistory: '69864aed1265653fdd7c0620',
  appointments: '69864aed1265653fdd7c0620',
  invoices: '69864aed1265653fdd7c0620',
  paymentOrders: '69864aed1265653fdd7c0620',
  paymentTransactions: '69864aed1265653fdd7c0620',
  paymentSubscriptions: '69864aed1265653fdd7c0620',
  surveySubmissions: '69864aed1265653fdd7c0620',
  products: '69864aed1265653fdd7c0620',
  mediaFiles: '69864aed1265653fdd7c0620'
};

// Base credit price used by all default unit prices. Custom per-location credit prices override this.
const BASE_CREDIT_PRICE = 0.018;

// Message volume pricing tiers (shared by SMS/WhatsApp AND email — 1 credit per item).
// The volume tier IS the discount; messages do not get the separate percentage DISCOUNT_TIERS.
//   ≤ 1,000     messages → $0.018/message
//   1K–10K      messages → $0.006/message
//   10K–50K     messages → $0.003/message
//   > 50,000    messages → $0.002/message
//   > 100,000   messages → $0.001/message
//   > 500,000   messages → $0.0005/message  (mega-volume floor)
// When `customCreditPrice` is set (per-location override from AppConfig), it REPLACES the
// tier price entirely with the negotiated rate (no further auto-discount by volume).
function getMessageCreditPrice(count) {
  if (count > 500000) return 0.0005;
  if (count > 100000) return 0.001;
  if (count > 50000)  return 0.002;
  if (count > 10000)  return 0.003;
  if (count > 1000)   return 0.006;
  return 0.018;
}

function getEmailPricing(emailCount, customCreditPrice = null) {
  const creditsPerEmail = 1;
  const creditPrice = customCreditPrice || getMessageCreditPrice(emailCount);
  return { creditsPerEmail, creditPrice, unitPrice: creditsPerEmail * creditPrice };
}

function getSmsPricing(smsCount, customCreditPrice = null) {
  const creditsPerItem = 1;
  const creditPrice = customCreditPrice || getMessageCreditPrice(smsCount);
  return { creditsPerItem, creditPrice, unitPrice: creditsPerItem * creditPrice };
}

// Default unit prices in dollars (fallback if API fails)
// All export types are billed at $0.018 per item with the same volume discount tiers.
// Email is handled dynamically via getEmailPricing() based on volume.
const DEFAULT_UNIT_PRICES = {
  conversations: 0.018,
  smsWhatsapp: 0.018,
  email: 0.018,            // base rate (≤1k emails, 1 credit); overridden by getEmailPricing() at higher volumes
  notesAndTasks: 0.018,
  opportunities: 0.018,
  formSubmissions: 0.018,
  links: 0.018,
  socialPosts: 0.018,
  callLogs: 0.018,
  templates: 0.018,
  customFields: 0.018,
  customValues: 0.018,
  tags: 0.018,
  opportunityStageHistory: 0.10,   // Custom build — flat per-row, no volume tier
  importNotes: 0.018,
  importContacts: 0.018,
  importCustomFields: 0.018,
  importCustomValues: 0.018,
  importOpportunities: 0.018,
  importTasks: 0.018,
  contacts: 0.018,
  appointments: 0.018,
  invoices: 0.018,
  paymentOrders: 0.018,
  paymentTransactions: 0.018,
  paymentSubscriptions: 0.018,
  surveySubmissions: 0.018,
  businesses: 0.018,
  products: 0.018,
  mediaFiles: 0.018
};


// Cached prices from GHL API
let cachedPrices = null;
let cacheExpiry = null;

// Volume discount tiers
const DISCOUNT_TIERS = [
  { min: 0, max: 1000, discount: 0 },
  { min: 1000, max: 2000, discount: 20 },
  { min: 2000, max: 5000, discount: 40 },
  { min: 5000, max: 30000, discount: 50 },
  { min: 30000, max: Infinity, discount: 70 }
];

class BillingService {
  constructor() {
    this.baseURL = process.env.GHL_API_URL || 'https://services.leadconnectorhq.com';
  }

  /**
   * Fetch rebilling config from GHL to get actual meter prices
   * @param {string} accessToken - GHL access token
   * @returns {Object} Prices per meter in cents
   */
  async fetchMeterPrices(accessToken, locationId) {
    // Return cached if still valid (cache for 1 hour)
    if (cachedPrices && cacheExpiry && Date.now() < cacheExpiry) {
      return cachedPrices;
    }

    try {
      const response = await axios.get(
        `${this.baseURL}/marketplace/app/${APP_ID}/rebilling-config/location/${locationId}`,
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'Version': '2021-07-28'
          }
        }
      );

      const config = response.data?.plans;
      logger.info('Fetched rebilling config:', config);

      // Extract prices from meters
      const prices = { ...DEFAULT_UNIT_PRICES };
      if (config.usage && Array.isArray(config.usage)) {
        config?.usage?.forEach(meter => {
          if (meter.meterId === METER_IDS.conversations) {
            prices.conversations = meter.fixedPricePerUnit || DEFAULT_UNIT_PRICES.conversations;
          } else if (meter.meterId === METER_IDS.smsWhatsapp) {
            prices.smsWhatsapp = meter.fixedPricePerUnit || DEFAULT_UNIT_PRICES.smsWhatsapp;
          } else if (meter.meterId === METER_IDS.email) {
            prices.email = meter.fixedPricePerUnit || DEFAULT_UNIT_PRICES.email;
          }
        });
      }

      // Cache for 1 hour
      cachedPrices = prices;
      cacheExpiry = Date.now() + (60 * 60 * 1000);

      return prices;
    } catch (error) {
      logger.error('Failed to fetch rebilling config:', {
        error: error.response?.data || error.message
      });
      // Return defaults on error
      return DEFAULT_UNIT_PRICES;
    }
  }

  /**
   * Get discount percentage based on total items
   */
  getDiscountPercent(totalItems) {
    for (const tier of DISCOUNT_TIERS) {
      if (totalItems >= tier.min && totalItems < tier.max) {
        return tier.discount;
      }
    }
    return 70; // Max discount for 30000+
  }

  /**
   * Get all discount tiers (for displaying to user)
   */
  getDiscountTiers() {
    return DISCOUNT_TIERS.map(tier => ({
      range: tier.max === Infinity ? `${tier.min}+` : `${tier.min}-${tier.max}`,
      discount: tier.discount
    }));
  }

  /**
   * Calculate pricing estimate for export
   * @param {Object} counts - Item counts { conversations, smsMessages, emailMessages }
   * @param {Object} prices - Optional prices (if not provided, uses defaults)
   * @returns {Object} Pricing estimate with breakdown
   */
  calculateEstimate(counts, prices = null, customCreditPrice = null) {
    const {
      conversations = 0,
      smsMessages = 0,
      emailMessages = 0,
      notes = 0,
      tasks = 0,
      opportunities = 0,
      formSubmissions = 0,
      links = 0,
      socialPosts = 0,
      callLogs = 0,
      templates = 0,
      contacts = 0,
      customFields = 0,
      customValues = 0,
      tags = 0,
      appointments = 0,
      invoices = 0,
      paymentOrders = 0,
      paymentTransactions = 0,
      paymentSubscriptions = 0,
      surveySubmissions = 0,
      businesses = 0,
      products = 0,
      mediaFiles = 0,
      opportunityStageHistory = 0,
      // OSH sub-counts: passed in for transparency on the customer-facing breakdown.
      // The billable total is still `opportunityStageHistory` (= opps + msgs from the caller),
      // but exposing these two lets the UI show "X opportunities + Y messages × $0.10".
      opportunityStageOppCount = 0,
      opportunityStageMsgCount = 0
    } = counts;

    // Per-location credit-price override scales every default unit price proportionally,
    // so OSH ($0.10 flat) and credit-based items move together. Tiered email/SMS get the
    // override applied inside their helpers above.
    let unitPrices = prices || DEFAULT_UNIT_PRICES;
    if (customCreditPrice && !prices) {
      const multiplier = customCreditPrice / BASE_CREDIT_PRICE;
      unitPrices = Object.fromEntries(
        Object.entries(DEFAULT_UNIT_PRICES).map(([k, v]) => [k, v * multiplier])
      );
    }
    const emailPricing = getEmailPricing(emailMessages, customCreditPrice);
    const smsPricing = getSmsPricing(smsMessages, customCreditPrice);
    // Every export type is now discountable. Volume tiers apply to the total item count.
    const conversationsCost = conversations * unitPrices.conversations;
    const textMessagesCost = smsMessages * smsPricing.unitPrice;
    const emailCost = emailMessages * emailPricing.unitPrice;
    const opportunitiesCost = opportunities * (unitPrices.opportunities || DEFAULT_UNIT_PRICES.opportunities);
    const formSubmissionsCost = formSubmissions * (unitPrices.formSubmissions || DEFAULT_UNIT_PRICES.formSubmissions);
    const linksCost = links * (unitPrices.links || DEFAULT_UNIT_PRICES.links);
    const socialPostsCost = socialPosts * (unitPrices.socialPosts || DEFAULT_UNIT_PRICES.socialPosts);
    const callLogsCost = callLogs * (unitPrices.callLogs || DEFAULT_UNIT_PRICES.callLogs);
    const templatesCost = templates * (unitPrices.templates || DEFAULT_UNIT_PRICES.templates);
    const contactsCost = contacts * (unitPrices.contacts || DEFAULT_UNIT_PRICES.contacts);
    const customFieldsCost = customFields * (unitPrices.customFields || DEFAULT_UNIT_PRICES.customFields);
    const customValuesCost = customValues * (unitPrices.customValues || DEFAULT_UNIT_PRICES.customValues);
    const tagsCost = tags * (unitPrices.tags || DEFAULT_UNIT_PRICES.tags);
    // Commerce & More exports — all flat $0.018/item, discountable like links.
    const appointmentsCost = appointments * (unitPrices.appointments || DEFAULT_UNIT_PRICES.appointments);
    const invoicesCost = invoices * (unitPrices.invoices || DEFAULT_UNIT_PRICES.invoices);
    const paymentOrdersCost = paymentOrders * (unitPrices.paymentOrders || DEFAULT_UNIT_PRICES.paymentOrders);
    const paymentTransactionsCost = paymentTransactions * (unitPrices.paymentTransactions || DEFAULT_UNIT_PRICES.paymentTransactions);
    const paymentSubscriptionsCost = paymentSubscriptions * (unitPrices.paymentSubscriptions || DEFAULT_UNIT_PRICES.paymentSubscriptions);
    const surveySubmissionsCost = surveySubmissions * (unitPrices.surveySubmissions || DEFAULT_UNIT_PRICES.surveySubmissions);
    const businessesCost = businesses * (unitPrices.businesses || DEFAULT_UNIT_PRICES.businesses);
    const productsCost = products * (unitPrices.products || DEFAULT_UNIT_PRICES.products);
    const mediaFilesCost = mediaFiles * (unitPrices.mediaFiles || DEFAULT_UNIT_PRICES.mediaFiles);
    // Opportunity Stage History: flat $0.10 per row, no volume discount tier (custom build, excluded from totals below).
    const opportunityStagePrice = unitPrices.opportunityStageHistory || DEFAULT_UNIT_PRICES.opportunityStageHistory;
    const opportunityStageCost = opportunityStageHistory * opportunityStagePrice;

    const notesTasksPrice = unitPrices.notesAndTasks || DEFAULT_UNIT_PRICES.notesAndTasks;
    const notesCost = notes * notesTasksPrice;
    const tasksCost = tasks * notesTasksPrice;

    // Messages (SMS/WhatsApp + email) are priced PURELY by their own volume ladder
    // (getMessageCreditPrice). The ladder IS their discount, so they are excluded from the
    // percentage DISCOUNT_TIERS below — no stacking. They also stay out of the item count
    // that selects the percentage tier, so a large message run can't inflate the flat-item discount.
    const messagesCost = textMessagesCost + emailCost;

    // Percentage volume discount applies only to flat-rate items.
    const commerceItems = appointments + invoices + paymentOrders + paymentTransactions + paymentSubscriptions + surveySubmissions + businesses + products + mediaFiles;
    const commerceCost = appointmentsCost + invoicesCost + paymentOrdersCost + paymentTransactionsCost + paymentSubscriptionsCost + surveySubmissionsCost + businessesCost + productsCost + mediaFilesCost;

    const discountableItems = conversations + opportunities + formSubmissions + links + socialPosts + callLogs + templates + contacts + customFields + customValues + tags + notes + tasks + commerceItems;
    const discountableAmount = conversationsCost + opportunitiesCost + formSubmissionsCost + linksCost + socialPostsCost + callLogsCost + templatesCost + contactsCost + customFieldsCost + customValuesCost + tagsCost + notesCost + tasksCost + commerceCost;

    // opportunityStageHistory is billed flat (no discount), so it stays out of the discounted totals.
    const totalItems = conversations + smsMessages + emailMessages + opportunities + formSubmissions + links + socialPosts + callLogs + templates + contacts + customFields + customValues + tags + notes + tasks + commerceItems;
    const baseAmount = discountableAmount + messagesCost;

    const discountPercent = discountableItems > 0 ? this.getDiscountPercent(discountableItems) : 0;
    const discountAmount = discountableAmount * (discountPercent / 100);
    // Messages billed at ladder price (no % discount); flat items get the % discount;
    // opportunityStageHistory flat cost added last (custom build, no volume tiers).
    const finalAmount = (discountableAmount - discountAmount) + messagesCost + opportunityStageCost;

    logger.info('Billing calculation:', {
      totalItems,
      baseAmount,
      discountPercent,
      discountAmount,
      opportunityStageCost,
      finalAmount
    });

    return {
      itemCounts: {
        conversations,
        smsMessages,
        emailMessages,
        notes,
        tasks,
        opportunities,
        formSubmissions,
        links,
        socialPosts,
        callLogs,
        templates,
        contacts,
        customFields,
        customValues,
        tags,
        appointments,
        invoices,
        paymentOrders,
        paymentTransactions,
        paymentSubscriptions,
        surveySubmissions,
        businesses,
        products,
        mediaFiles,
        opportunityStageHistory,
        total: totalItems + opportunityStageHistory
      },
      breakdown: {
        conversations: {
          count: conversations,
          unitPrice: unitPrices.conversations,
          subtotal: conversationsCost
        },
        smsWhatsapp: {
          count: smsMessages,
          unitPrice: smsPricing.unitPrice,
          creditsPerItem: smsPricing.creditsPerItem,
          creditPrice: smsPricing.creditPrice,
          subtotal: textMessagesCost
        },
        email: {
          count: emailMessages,
          unitPrice: emailPricing.unitPrice,
          creditsPerItem: emailPricing.creditsPerEmail,
          creditPrice: emailPricing.creditPrice,
          subtotal: emailCost
        },
        notes: {
          count: notes,
          unitPrice: notesTasksPrice,
          subtotal: notesCost
        },
        tasks: {
          count: tasks,
          unitPrice: notesTasksPrice,
          subtotal: tasksCost
        },
        opportunities: {
          count: opportunities,
          unitPrice: unitPrices.opportunities || DEFAULT_UNIT_PRICES.opportunities,
          subtotal: opportunitiesCost
        },
        formSubmissions: {
          count: formSubmissions,
          unitPrice: unitPrices.formSubmissions || DEFAULT_UNIT_PRICES.formSubmissions,
          subtotal: formSubmissionsCost
        },
        links: {
          count: links,
          unitPrice: unitPrices.links || DEFAULT_UNIT_PRICES.links,
          subtotal: linksCost
        },
        socialPosts: {
          count: socialPosts,
          unitPrice: unitPrices.socialPosts || DEFAULT_UNIT_PRICES.socialPosts,
          subtotal: socialPostsCost
        },
        callLogs: {
          count: callLogs,
          unitPrice: unitPrices.callLogs || DEFAULT_UNIT_PRICES.callLogs,
          subtotal: callLogsCost
        },
        templates: {
          count: templates,
          unitPrice: unitPrices.templates || DEFAULT_UNIT_PRICES.templates,
          subtotal: templatesCost
        },
        contacts: {
          count: contacts,
          unitPrice: unitPrices.contacts || DEFAULT_UNIT_PRICES.contacts,
          subtotal: contactsCost
        },
        customFields: {
          count: customFields,
          unitPrice: unitPrices.customFields || DEFAULT_UNIT_PRICES.customFields,
          subtotal: customFieldsCost
        },
        customValues: {
          count: customValues,
          unitPrice: unitPrices.customValues || DEFAULT_UNIT_PRICES.customValues,
          subtotal: customValuesCost
        },
        tags: {
          count: tags,
          unitPrice: unitPrices.tags || DEFAULT_UNIT_PRICES.tags,
          subtotal: tagsCost
        },
        appointments: {
          count: appointments,
          unitPrice: unitPrices.appointments || DEFAULT_UNIT_PRICES.appointments,
          subtotal: appointmentsCost
        },
        invoices: {
          count: invoices,
          unitPrice: unitPrices.invoices || DEFAULT_UNIT_PRICES.invoices,
          subtotal: invoicesCost
        },
        paymentOrders: {
          count: paymentOrders,
          unitPrice: unitPrices.paymentOrders || DEFAULT_UNIT_PRICES.paymentOrders,
          subtotal: paymentOrdersCost
        },
        paymentTransactions: {
          count: paymentTransactions,
          unitPrice: unitPrices.paymentTransactions || DEFAULT_UNIT_PRICES.paymentTransactions,
          subtotal: paymentTransactionsCost
        },
        paymentSubscriptions: {
          count: paymentSubscriptions,
          unitPrice: unitPrices.paymentSubscriptions || DEFAULT_UNIT_PRICES.paymentSubscriptions,
          subtotal: paymentSubscriptionsCost
        },
        surveySubmissions: {
          count: surveySubmissions,
          unitPrice: unitPrices.surveySubmissions || DEFAULT_UNIT_PRICES.surveySubmissions,
          subtotal: surveySubmissionsCost
        },
        businesses: {
          count: businesses,
          unitPrice: unitPrices.businesses || DEFAULT_UNIT_PRICES.businesses,
          subtotal: businessesCost
        },
        products: {
          count: products,
          unitPrice: unitPrices.products || DEFAULT_UNIT_PRICES.products,
          subtotal: productsCost
        },
        mediaFiles: {
          count: mediaFiles,
          unitPrice: unitPrices.mediaFiles || DEFAULT_UNIT_PRICES.mediaFiles,
          subtotal: mediaFilesCost
        },
        opportunityStageHistory: {
          count: opportunityStageHistory,
          unitPrice: opportunityStagePrice,
          subtotal: opportunityStageCost,
          // Sub-detail so the UI can render "X opportunities + Y messages × $0.10 = $Z"
          // instead of a single opaque "N units" line. Falls back to zero when not provided
          // (e.g. legacy callers that pass only the rolled-up count).
          opportunityCount: opportunityStageOppCount,
          messageCount: opportunityStageMsgCount,
          opportunityCost: opportunityStageOppCount * opportunityStagePrice,
          messageCost: opportunityStageMsgCount * opportunityStagePrice
        }
      },
      baseAmount,
      discountPercent,
      discountAmount,
      finalAmount,
      finalAmountDollars: finalAmount
    };
  }

  /**
   * Calculate estimate with fetched prices from GHL
   * @param {Object} counts - Item counts
   * @param {string} accessToken - GHL access token
   * @returns {Object} Pricing estimate with actual GHL prices
   */
  async calculateEstimateWithPrices(counts, accessToken, locationId) {
    const prices = await this.fetchMeterPrices(accessToken, locationId);
    // Per-location override (set via AppConfig `locationCreditPrice:<locationId>`) wins over
    // both rebilling-config prices and defaults. Scales every tab's price by the negotiated rate.
    const customCreditPrice = await AppConfig.getLocationCreditPrice(locationId);
    if (customCreditPrice) return this.calculateEstimate(counts, null, customCreditPrice);
    return this.calculateEstimate(counts, prices);
  }

  /**
   * Sync `calculateEstimate` but applies the per-location credit-price override from AppConfig.
   * Use this from any caller that already has `locationId` and wants the override honored
   * (e.g. the OSH branch in routes/billing.js which doesn't go through `calculateEstimateWithPrices`).
   */
  async calculateEstimateForLocation(counts, locationId) {
    const customCreditPrice = await AppConfig.getLocationCreditPrice(locationId);
    return this.calculateEstimate(counts, null, customCreditPrice);
  }

  /**
   * Check if wallet has sufficient funds
   * @param {string} companyId - Company ID
   * @param {string} accessToken - GHL access token
   * @returns {boolean} Whether wallet has funds
   */
  async hasFunds(companyId, accessToken) {
    if (await AppConfig.hasValue('internalTestingCompanyIds', companyId)) {
      logger.info('Internal testing company - skipping funds check', { companyId });
      return true;
    }

    try {
      const response = await axios.get(
        `${this.baseURL}/marketplace/billing/charges/has-funds`,
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'Version': '2021-07-28'
          },
          params: { companyId }
        }
      );

      logger.info('Wallet funds check:', { companyId, response: response?.data });
      return response.data.hasFunds === true;
    } catch (error) {
      logger.error('Failed to check wallet funds:', {
        companyId,
        error: error.response?.data || error.message
      });
      throw new Error('Unable to verify wallet balance');
    }
  }

  /**
   * Charge wallet using GHL Billing API
   * @param {string} companyId - Company ID
   * @param {string} accessToken - GHL access token
   * @param {Array} meterCharges - Array of { meterId, qty, description }
   * @returns {Object} Charge result with charge IDs
   */
  async chargeWallet(companyId, accessToken, meterCharges, locationId, transactionId, finalAmount, appId = null) {
    // appId defaults to the premium app; the lite ("Export Messages") charge path passes its own
    // GHL_LITE_APP_ID so charges bill the correct marketplace app.
    const chargeAppId = appId || process.env.GHL_APP_ID || "694f93f8a6babf0c821b1356";
    // Look up referral code for this location (non-blocking)
    let referralCode = null;
    try {
      const Referral = require('../models/Referral');
      const referral = await Referral.findByLocation(locationId);
      if (referral) {
        referralCode = referral.referralCode;
      }
    } catch (refErr) {
      // Silent fail
    }

    if (await AppConfig.hasValue('internalTestingCompanyIds', companyId)) {
      logger.info('Internal testing company - skipping charge', { companyId, meterCharges });
      try {
        const Referral = require('../models/Referral');
        await Referral.addRevenue(locationId, finalAmount);
      } catch (refErr) {
        // Silent fail — referral tracking should never block billing
      }
      return {
        success: true,
        internalTesting: true,
        paymentIgnored: true,
        referralCode,
        charges: meterCharges.map(c => ({
          meterId: c.meterId,
          qty: c.qty,
          chargeId: `internal_test_${transactionId}`,
          success: true,
          paymentIgnored: true
        })),
        totalCharges: meterCharges.length
      };
    }

    try {
      const chargeResults = [];

      for (const charge of meterCharges) {
        if (charge.qty <= 0) continue;

        logger.info('Charging wallet:', {
          companyId,
          meterId: charge.meterId,
          qty: charge.qty,
          finalAmount: finalAmount,
          unitPrice: Number((finalAmount/charge.qty).toFixed(4)),
          referralCode
        });

        const response = await axios.post(
          `${this.baseURL}/marketplace/billing/charges`,
          {
            companyId,
            meterId: charge.meterId,
            units: charge.qty,
            price: Number((finalAmount/charge.qty).toFixed(4)),
            appId: chargeAppId,
            eventId: transactionId,
            locationId: locationId,
            description: "Exported Data " + "_" + new Date().toDateString()
          },
          {
            headers: {
              'Authorization': `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
              'Version': '2021-07-28'
            }
          }
        );

        chargeResults.push({
          meterId: charge.meterId,
          qty: charge.qty,
          unitPrice: (finalAmount/charge.qty).toFixed(4),
          finalAmount: finalAmount,
          chargeId: response.data.chargeId || response.data.id || response.data._id,
          referralCode,
          success: true
        });

        logger.info('Wallet charge successful:', {
          response: response.data,
          meterId: charge.meterId,
          chargeId: chargeResults[chargeResults.length - 1].chargeId,
          referralCode
        });
      }

      // Track revenue for referral (non-blocking)
      try {
        const Referral = require('../models/Referral');
        await Referral.addRevenue(locationId, finalAmount);
      } catch (refErr) {
        // Silent fail — referral tracking should never block billing
      }

      return {
        success: true,
        referralCode,
        charges: chargeResults,
        totalCharges: chargeResults.length
      };
    } catch (error) {
      logger.error('Failed to charge wallet:', {
        companyId,
        error: error.response?.data || error.message
      });
      const ghlMsg = error.response?.data?.message || '';
      // hasFunds() is a boolean precheck and can pass while the actual charge still fails for
      // lack of funds (balance covers something but not this amount, or it drained between the
      // check and the charge). GHL returns these as HTTP 400 with messages like
      // "Agency wallet has insufficient funds" / "Location wallet has insufficient funds".
      // Detect that here so the route can return the INSUFFICIENT_FUNDS experience, and capture
      // which wallet is short so the UI can name it precisely.
      const isInsufficientFunds = /insufficient|not enough funds|low balance/i.test(ghlMsg);
      const err = new Error(ghlMsg || 'Payment failed. Please check your wallet balance.');
      err.insufficientFunds = isInsufficientFunds;
      // 'agency' | 'location' | null — derived from the GHL message when available.
      err.walletScope = /agency/i.test(ghlMsg) ? 'agency'
        : /location|sub-?account/i.test(ghlMsg) ? 'location'
        : null;
      throw err;
    }
  }

  /**
   * Build meter charges array from item counts
   * @param {Object} counts - Item counts
   * @returns {Array} Array of meter charges for GHL API
   */
  buildMeterCharges(counts) {
    const charges = [];

    if (counts.conversations > 0) {
      charges.push({
        meterId: METER_IDS.conversations,
        qty: counts.conversations,
        description: 'Conversation exports'
      });
    }

    if (counts.smsMessages > 0) {
      charges.push({
        meterId: METER_IDS.smsWhatsapp,
        qty: counts.smsMessages,
        description: 'Text message exports'
      });
    }

    if (counts.emailMessages > 0) {
      charges.push({
        meterId: METER_IDS.email,
        qty: counts.emailMessages,
        description: 'Email message exports'
      });
    }

    if (counts.notes > 0) {
      charges.push({
        meterId: METER_IDS.notesAndTasks,
        qty: counts.notes,
        description: 'Note exports'
      });
    }

    if (counts.tasks > 0) {
      charges.push({
        meterId: METER_IDS.notesAndTasks,
        qty: counts.tasks,
        description: 'Task exports'
      });
    }

    if (counts.opportunities > 0) {
      charges.push({
        meterId: METER_IDS.opportunities,
        qty: counts.opportunities,
        description: 'Opportunity exports'
      });
    }

    if (counts.formSubmissions > 0) {
      charges.push({
        meterId: METER_IDS.formSubmissions,
        qty: counts.formSubmissions,
        description: 'Form submission exports'
      });
    }

    if (counts.links > 0) {
      charges.push({
        meterId: METER_IDS.links,
        qty: counts.links,
        description: 'Link exports'
      });
    }

    if (counts.socialPosts > 0) {
      charges.push({
        meterId: METER_IDS.socialPosts,
        qty: counts.socialPosts,
        description: 'Social post exports'
      });
    }

    if (counts.callLogs > 0) {
      charges.push({
        meterId: METER_IDS.callLogs,
        qty: counts.callLogs,
        description: 'Call log exports'
      });
    }

    if (counts.contacts > 0) {
      // Contacts share the messages meter — same rate ($0.018) and same volume-discount tiering.
      charges.push({
        meterId: METER_IDS.smsWhatsapp,
        qty: counts.contacts,
        description: 'Contact exports'
      });
    }

    if (counts.customFields > 0) {
      charges.push({
        meterId: METER_IDS.customFields,
        qty: counts.customFields,
        description: 'Custom field exports'
      });
    }

    if (counts.customValues > 0) {
      charges.push({
        meterId: METER_IDS.customValues,
        qty: counts.customValues,
        description: 'Custom value exports'
      });
    }

    if (counts.tags > 0) {
      charges.push({
        meterId: METER_IDS.tags,
        qty: counts.tags,
        description: 'Tag exports'
      });
    }

    if (counts.opportunityStageHistory > 0) {
      charges.push({
        meterId: METER_IDS.opportunityStageHistory,
        qty: counts.opportunityStageHistory,
        description: 'Opportunity stage history exports'
      });
    }

    if (counts.appointments > 0) {
      charges.push({
        meterId: METER_IDS.appointments,
        qty: counts.appointments,
        description: 'Appointment exports'
      });
    }

    if (counts.invoices > 0) {
      charges.push({
        meterId: METER_IDS.invoices,
        qty: counts.invoices,
        description: 'Invoice exports'
      });
    }

    if (counts.paymentOrders > 0) {
      charges.push({
        meterId: METER_IDS.paymentOrders,
        qty: counts.paymentOrders,
        description: 'Payment order exports'
      });
    }

    if (counts.paymentTransactions > 0) {
      charges.push({
        meterId: METER_IDS.paymentTransactions,
        qty: counts.paymentTransactions,
        description: 'Payment transaction exports'
      });
    }

    if (counts.paymentSubscriptions > 0) {
      charges.push({
        meterId: METER_IDS.paymentSubscriptions,
        qty: counts.paymentSubscriptions,
        description: 'Payment subscription exports'
      });
    }

    if (counts.surveySubmissions > 0) {
      charges.push({
        meterId: METER_IDS.surveySubmissions,
        qty: counts.surveySubmissions,
        description: 'Survey submission exports'
      });
    }

    if (counts.businesses > 0) {
      charges.push({
        meterId: METER_IDS.businesses,
        qty: counts.businesses,
        description: 'Business exports'
      });
    }

    if (counts.products > 0) {
      charges.push({
        meterId: METER_IDS.products,
        qty: counts.products,
        description: 'Product exports'
      });
    }

    if (counts.mediaFiles > 0) {
      charges.push({
        meterId: METER_IDS.mediaFiles,
        qty: counts.mediaFiles,
        description: 'Media file exports'
      });
    }

    return charges;
  }

  /**
   * Get meter IDs (for reference)
   */
  getMeterIds() {
    return { ...METER_IDS };
  }

  /**
   * Get unit prices (returns cached prices if available, otherwise defaults)
   */
  getUnitPrices(locationId) {
    return cachedPrices ? { ...cachedPrices } : { ...DEFAULT_UNIT_PRICES };
  }

  /**
   * Get default unit prices (always returns the configured defaults, ignoring cache)
   */
  getDefaultUnitPrices(locationId) {
    return { ...DEFAULT_UNIT_PRICES };
  }
}

module.exports = new BillingService();
