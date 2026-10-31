import { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import Header from './Header';
import ConversationsTab from './tabs/ConversationsTab';
import MessagesTab from './tabs/MessagesTab';
import SupportTab from './tabs/SupportTab';
import ExportTab from './tabs/ExportTab';
import NotesTab from './tabs/NotesTab';
import NotesSearchTab from './tabs/NotesSearchTab';
import TasksTab from './tabs/TasksTab';
import OpportunitiesTab from './tabs/OpportunitiesTab';
import FormSubmissionsTab from './tabs/FormSubmissionsTab';
import LinksTab from './tabs/LinksTab';
import CallLogsTab from './tabs/CallLogsTab';
import TemplatesTab from './tabs/TemplatesTab';
import SpecialMessagesTab from './tabs/SpecialMessagesTab';
import CallTranscriptionsTab from './tabs/CallTranscriptionsTab';
import CallRecordingsTab from './tabs/CallRecordingsTab';
import ContactBundleTab from './tabs/ContactBundleTab';
import MessagesByTagTab from './tabs/MessagesByTagTab';
import GroupMessagesTab from './tabs/GroupMessagesTab';
import ExportContactsTab from './tabs/ExportContactsTab';
import ConversationMessages from './ConversationMessages';
import { billingAPI } from '../api/billing';
import { buildMarketplaceUrl } from '../constants/api';
import CustomChargeTab from './tabs/CustomChargeTab';
import ImportNotesTab from './tabs/ImportNotesTab';
import ImportContactsTab from './tabs/ImportContactsTab';
import CustomFieldsTab from './tabs/CustomFieldsTab';
import CustomValuesTab from './tabs/CustomValuesTab';
import TagsTab from './tabs/TagsTab';
import ImportCustomFieldsTab from './tabs/ImportCustomFieldsTab';
import ImportCustomValuesTab from './tabs/ImportCustomValuesTab';
import OpportunityStageHistoryTab from './tabs/OpportunityStageHistoryTab';
import AppointmentsTab from './tabs/AppointmentsTab';
import InvoicesTab from './tabs/InvoicesTab';
import PaymentOrdersTab from './tabs/PaymentOrdersTab';
import PaymentTransactionsTab from './tabs/PaymentTransactionsTab';
import PaymentSubscriptionsTab from './tabs/PaymentSubscriptionsTab';
import SurveySubmissionsTab from './tabs/SurveySubmissionsTab';
import BusinessesTab from './tabs/BusinessesTab';
import ProductsTab from './tabs/ProductsTab';
import MediaFilesTab from './tabs/MediaFilesTab';
import ImportOpportunitiesTab from './tabs/ImportOpportunitiesTab';
import ImportTasksTab from './tabs/ImportTasksTab';
import { MESSAGE_PRICE_TIERS } from '../constants/pricing';

// ---------------------------------------------------------------------------
// Consistent line-icon set for the sidebar (one visual weight, stroke 1.6).
// Keyed by Dashboard tab id. `NavIcon` renders the matching path; anything
// without an explicit entry falls back to a neutral document glyph, so new
// tabs never break the UI. Icons are purely presentational.
// ---------------------------------------------------------------------------
const ICON_PATHS = {
  // Conversations
  messages: 'M8 10h8M8 14h5M21 12a8 8 0 0 1-11.5 7.2L3 21l1.8-6.5A8 8 0 1 1 21 12z',
  specialTabMessages: 'M12 3l2.1 4.9L19 9l-4 3.6L16 18l-4-2.4L8 18l1-5.4L5 9l4.9-1.1L12 3z',
  contactBundle: 'M3.3 7L12 3l8.7 4M3.3 7L12 11l8.7-4M3.3 7v10L12 21M20.7 7v10L12 21M12 11v10',
  messagesByTag: 'M3 7v5.2a2 2 0 0 0 .6 1.4l7 7a2 2 0 0 0 2.8 0l5.8-5.8a2 2 0 0 0 0-2.8l-7-7A2 2 0 0 0 10.8 4H5a2 2 0 0 0-2 2v1zM7.5 7.5h.01',
  groupMessages: 'M16 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM22 19v-1a4 4 0 0 0-3-3.9M16 4.1a4 4 0 0 1 0 7.8',
  callTranscriptions: 'M9 18V5l12-2v13M9 13l12-2M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 19a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  callRecordings: 'M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2 4.2 2 2 0 0 1 4 2h3a2 2 0 0 1 2 1.7c.1.9.3 1.8.6 2.6a2 2 0 0 1-.5 2.1L7.6 9.8a16 16 0 0 0 6 6l1.4-1.4a2 2 0 0 1 2.1-.5c.8.3 1.7.5 2.6.6a2 2 0 0 1 1.7 2z',
  // Contacts & CRM
  contacts: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  opportunities: 'M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6',
  opportunityStageHistory: 'M3 3v18h18M7 15l3-3 3 3 5-5M18 10h2V8',
  formSubmissions: 'M9 11l3 3 8-8M20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9',
  // Content
  notesSearch: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zM14 2v6h6M8 13h5M8 17h3',
  notes: 'M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M18.5 2.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z',
  tasks: 'M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11',
  templates: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zM14 2v6h6M8 13h8M8 17h8M8 9h2',
  links: 'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7',
  callLogs: 'M12 2a7 7 0 0 0-7 7v3.3c0 .5-.2 1-.6 1.4L3 15h18l-1.4-1.3a2 2 0 0 1-.6-1.4V9a7 7 0 0 0-7-7zM9 19a3 3 0 0 0 6 0',
  customFields: 'M20.5 11H19V7a2 2 0 0 0-2-2h-4V3.5a2.5 2.5 0 0 0-5 0V5H4a2 2 0 0 0-2 2v3.8h1.5a2.6 2.6 0 0 1 0 5.2H2V20a2 2 0 0 0 2 2h3.8v-1.5a2.6 2.6 0 0 1 5.2 0V22H17a2 2 0 0 0 2-2v-4h1.5a2.5 2.5 0 0 0 0-5z',
  customValues: 'M9 7h6M9 11h6M9 15h4M5 3h11l4 4v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z',
  tags: 'M3 7v5.2a2 2 0 0 0 .6 1.4l7 7a2 2 0 0 0 2.8 0l5.8-5.8a2 2 0 0 0 0-2.8l-7-7A2 2 0 0 0 10.8 4H5a2 2 0 0 0-2 2v1zM7.5 7.5h.01',
  // Commerce & More
  appointments: 'M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z',
  invoices: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zM14 2v6h6M9 13h6M9 17h6M9 9h2',
  paymentOrders: 'M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4zM3 6h18M16 10a4 4 0 0 1-8 0',
  paymentTransactions: 'M2 9h20M2 7a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7zM6 15h4',
  paymentSubscriptions: 'M3 2v6h6M21 12a9 9 0 0 0-15-6.7L3 8M21 22v-6h-6M3 12a9 9 0 0 0 15 6.7l3-2.7',
  surveySubmissions: 'M9 11l3 3 8-8M20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9',
  businesses: 'M3 21h18M5 21V7l8-4v18M19 21V11l-6-3M9 9h.01M9 13h.01M9 17h.01',
  products: 'M3.3 7L12 3l8.7 4M3.3 7L12 11l8.7-4M3.3 7v10L12 21M20.7 7v10L12 21M12 11v10',
  mediaFiles: 'M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zM8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM21 15l-5-5L5 21',
  customCharge: 'M2 9h20M2 7a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7zM6 15h4',
  // Import
  importContacts: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM19 8v6M22 11h-6',
  importNotes: 'M12 3v12m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2',
  importOpportunities: 'M12 3v12m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2',
  importTasks: 'M12 3v12m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2',
  importCustomFields: 'M12 3v12m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2',
  importCustomValues: 'M12 3v12m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2',
};
const FALLBACK_ICON = 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zM14 2v6h6';

function NavIcon({ id, className = 'w-4 h-4' }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICON_PATHS[id] || FALLBACK_ICON} />
    </svg>
  );
}

// Marketing tiers for the dashboard price-drop banner: every message tier below the base rate,
// with the live price and the savings % vs the $0.018 base. Driven by the shared pricing constant.
const SAVINGS_TIERS = MESSAGE_PRICE_TIERS
  .filter((t) => t.savePct > 0)
  .map((t) => ({
    label: t.min >= 1000 ? `${t.min / 1000}k+` : `${t.min}+`,
    price: `$${t.price}`,
    savePct: t.savePct,
  }));
const MAX_SAVINGS_PCT = Math.max(...MESSAGE_PRICE_TIERS.map((t) => t.savePct));

export default function Dashboard() {
  const { location, features } = useAuth();

  // Top-level mode: 'export' (default) or 'import'
  const savedMode = localStorage.getItem('dataMode') || 'export';
  const [dataMode, setDataMode] = useState(savedMode);

  // Saved sub-tab — defaults to 'messages' under Export, 'importNotes' under Import.
  const savedTab = localStorage.getItem('activeTab') || 'messages';
  const [activeTab, setActiveTab] = useState(savedTab);
  const [selectedConversation, setSelectedConversation] = useState(null);
  const [showConversationView, setShowConversationView] = useState(false);
  // Charge and Call Transcriptions stay gated; Complete Messages and Import Notes are now live for everyone.
  const [customChargeEnabled, setCustomChargeEnabled] = useState(false);
  const [callTranscriptionsEnabled, setCallTranscriptionsEnabled] = useState(false);
  const [callRecordingsEnabled, setCallRecordingsEnabled] = useState(false);
  const [contactBundleDocEnabled, setContactBundleDocEnabled] = useState(false);
  // Per-location tab kill-switch (from AppConfig `disabledTabs:<locationId>`). Holds tab ids to
  // hide, and/or the value 'import' to hide the whole Import mode. Empty = nothing disabled.
  const [disabledTabs, setDisabledTabs] = useState([]);
  // Per-tab app-version gate: { tabId: { needsUpgrade, forceUpdate, reason, ... } }. Only out-of-date
  // gated tabs appear here; everything else is absent and renders normally.
  const [tabUpgrades, setTabUpgrades] = useState({});
  const importDisabled = disabledTabs.includes('import');

  // Sidebar: quick-filter text + per-group collapse state (persisted). A collapsed group keeps its
  // header visible but hides its items; searching overrides collapse so matches always show.
  const [navSearch, setNavSearch] = useState('');
  const [collapsedGroups, setCollapsedGroups] = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem('navCollapsed') || '[]')); }
    catch { return new Set(); }
  });
  const toggleGroup = (label) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      next.has(label) ? next.delete(label) : next.add(label);
      try { localStorage.setItem('navCollapsed', JSON.stringify([...next])); } catch { /* ignore */ }
      return next;
    });
  };

  // Persist mode + sub-tab
  useEffect(() => { localStorage.setItem('dataMode', dataMode); }, [dataMode]);
  useEffect(() => { localStorage.setItem('activeTab', activeTab); }, [activeTab]);

  useEffect(() => {
    if (!location?.id) return;
    billingAPI.getPricing(location.id).then(res => {
      setCustomChargeEnabled(!!res?.data?.customChargeEnabled);
      setCallTranscriptionsEnabled(!!res?.data?.callTranscriptionsEnabled);
      setCallRecordingsEnabled(!!res?.data?.callRecordingsEnabled);
      setContactBundleDocEnabled(!!res?.data?.contactBundleDocEnabled);
      setDisabledTabs(Array.isArray(res?.data?.disabledTabs) ? res.data.disabledTabs : []);
      setTabUpgrades(res?.data?.tabUpgrades && typeof res.data.tabUpgrades === 'object' ? res.data.tabUpgrades : {});
    }).catch(() => {});
  }, [location?.id]);

  // Sidebar groups for Export Data
  const exportGroups = [
    {
      label: 'Conversations',
      items: [
        { id: 'messages', label: 'Messages', icon: '📊' },
        { id: 'specialTabMessages', label: 'Activity Messages', icon: '💎' },
        { id: 'contactBundle', label: 'All Contact Communication', icon: '📦' },
        { id: 'messagesByTag', label: 'Messages by Tag', icon: '🏷️' },
        { id: 'groupMessages', label: 'Group Messages', icon: '👥' },
        ...(callTranscriptionsEnabled ? [{ id: 'callTranscriptions', label: 'Call Transcriptions', icon: '🎙️' }] : []),
        { id: 'callRecordings', label: 'Call Recordings', icon: '🔊' },
      ]
    },
    {
      label: 'Contacts & CRM',
      items: [
        { id: 'contacts', label: 'Contacts', icon: '👤' },
        { id: 'opportunities', label: 'Opportunities', icon: '💰' },
        ...(features?.opportunityStageHistory ? [{ id: 'opportunityStageHistory', label: 'Stage History', icon: '🪜' }] : []),
        { id: 'formSubmissions', label: 'Forms', icon: '📋' },
      ]
    },
    {
      label: 'Content',
      items: [
        { id: 'notesSearch', label: 'Notes', icon: '🗒️' },
        { id: 'notes', label: 'Notes By Tag', icon: '📝' },
        { id: 'tasks', label: 'Tasks', icon: '✅' },
        { id: 'templates', label: 'Templates', icon: '📄' },
        { id: 'links', label: 'Links', icon: '🔗' },
        { id: 'callLogs', label: 'Voice AI', icon: '📞' },
        { id: 'customFields', label: 'Custom Fields', icon: '🧩' },
        { id: 'customValues', label: 'Custom Values', icon: '🔖' },
        { id: 'tags', label: 'Tags', icon: '🏷️' },
      ]
    },
    {
      label: 'Commerce & More',
      items: [
        { id: 'appointments', label: 'Appointments', icon: '📅' },
        { id: 'invoices', label: 'Invoices', icon: '🧾' },
        { id: 'paymentOrders', label: 'Payment Orders', icon: '🛒' },
        { id: 'paymentTransactions', label: 'Payment Transactions', icon: '💳' },
        { id: 'paymentSubscriptions', label: 'Subscriptions', icon: '🔁' },
        { id: 'surveySubmissions', label: 'Surveys', icon: '📝' },
        { id: 'businesses', label: 'Businesses', icon: '🏢' },
        { id: 'products', label: 'Products', icon: '📦' },
        { id: 'mediaFiles', label: 'Media Files', icon: '🖼️' },
      ]
    },
    ...(customChargeEnabled ? [{ label: 'Billing', items: [{ id: 'customCharge', label: 'Charge', icon: '💳' }] }] : []),
  ];

  // Sidebar groups for Import Data
  const importGroups = [
    {
      label: 'Contacts & CRM',
      items: [
        { id: 'importContacts', label: 'Contacts', icon: '👥' },
        { id: 'importNotes', label: 'Notes', icon: '📥' },
        { id: 'importOpportunities', label: 'Opportunities', icon: '💰' },
        { id: 'importTasks', label: 'Tasks', icon: '✅' },
      ]
    },
    {
      label: 'Content',
      items: [
        { id: 'importCustomFields', label: 'Custom Fields', icon: '🧩' },
        { id: 'importCustomValues', label: 'Custom Values', icon: '🔖' },
      ]
    },
  ];

  // Apply the per-location disabled-tabs filter: drop any hidden tab id, then drop groups left
  // empty. 'import' in disabledTabs hides the whole Import mode (handled at the mode toggle).
  const applyDisabled = (groups) =>
    groups
      .map(g => ({ ...g, items: g.items.filter(it => !disabledTabs.includes(it.id)) }))
      .filter(g => g.items.length > 0);

  const exportGroupsVisible = applyDisabled(exportGroups);
  const importGroupsVisible = importDisabled ? [] : applyDisabled(importGroups);
  const exportTabs = exportGroupsVisible.flatMap(g => g.items);
  const importTabs = importGroupsVisible.flatMap(g => g.items);

  const tabs = dataMode === 'export' ? exportTabs : importTabs;

  // If the persisted activeTab doesn't belong to the current mode (e.g. user switched modes),
  // snap to the first tab in the current group.
  useEffect(() => {
    if (tabs.length === 0) return;
    if (!tabs.some(t => t.id === activeTab)) {
      setActiveTab(tabs[0].id);
    }
  }, [dataMode, tabs.length]);

  const switchMode = (mode) => {
    const onStandaloneTab = ['exports', 'support'].includes(activeTab);
    // Allow re-clicking the active mode to escape standalone tabs (Export History, Support).
    if (mode === dataMode && !onStandaloneTab) return;
    setDataMode(mode);
    setShowConversationView(false);
    // Snap activeTab to first sub-tab of new mode immediately so content updates without a frame of mismatch.
    const list = mode === 'export' ? exportTabs : importTabs;
    if (list.length > 0) setActiveTab(list[0].id);
  };

  const handleConversationSelect = (conversation) => {
    setSelectedConversation(conversation);
    setShowConversationView(true);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-50 to-gray-100">
      <Header />
      
      <div className="max-w-12xl mx-auto px-3 py-3">
        {/* Updates Banner */}
        {/* <UpdatesBanner /> */}

        {/* Price Drop Promo Strip — single compact row: badge · headline · inline tier chips · auto-applied. */}
        <div className="mb-3 rounded-xl overflow-hidden border border-emerald-200 bg-gradient-to-r from-emerald-50 via-teal-50 to-emerald-50 relative">
          <div className="absolute -top-8 -right-8 w-32 h-32 bg-emerald-300/20 rounded-full blur-3xl pointer-events-none"></div>
          <div className="relative px-3.5 py-2 flex items-center gap-x-3 gap-y-1.5 flex-wrap">
            <span className="relative inline-flex items-center text-[10px] font-bold bg-emerald-600 text-white px-2 py-1 rounded-md uppercase tracking-wider shadow-sm flex-shrink-0">
              Price Drop
              <span className="absolute -top-1 -right-1 w-2 h-2 bg-emerald-500 rounded-full animate-ping"></span>
              <span className="absolute -top-1 -right-1 w-2 h-2 bg-emerald-500 rounded-full"></span>
            </span>
            <p className="text-sm font-semibold text-emerald-900 flex-shrink-0">
              Save up to {MAX_SAVINGS_PCT}% on messages
            </p>
            {/* Tier chips: live price + savings vs the $0.018 base, driven by the shared pricing constant. */}
            <div className="hidden sm:flex items-center gap-1.5 flex-wrap">
              {SAVINGS_TIERS.map((t) => (
                <span
                  key={t.label}
                  className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-800 bg-white/80 px-2 py-0.5 rounded-md border border-emerald-200"
                >
                  <strong className="text-emerald-900">{t.label}</strong>
                  <span className="text-emerald-700">{t.price}</span>
                  <span className="text-[10px] font-bold bg-emerald-600 text-white px-1 py-px rounded">
                    −{t.savePct}%
                  </span>
                </span>
              ))}
            </div>
            <span className="hidden md:inline-flex items-center gap-1 text-[10px] font-semibold text-emerald-700 bg-white px-2 py-1 rounded-md border border-emerald-200 flex-shrink-0 ml-auto">
              <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={3} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
              Auto-applied
            </span>
          </div>
        </div>

        {/* NotifyPro Cross-Promo Banner — temporarily hidden (replaced by Telegram Messaging Connector promo).
            Info: https://notify.vaultsuite.store · Marketplace app id: 6962592adbdd5106c52e257a */}
        {/*
        <div className="mb-4 bg-gradient-to-r from-amber-500 via-orange-500 to-rose-500 rounded-xl px-5 py-3 flex items-center justify-between shadow-md">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 bg-white/20 rounded-full flex items-center justify-center flex-shrink-0">
              <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
              </svg>
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <p className="text-white font-semibold text-sm">NotifyPro — respond to leads in seconds, not hours</p>
                <span className="hidden sm:inline-flex items-center bg-white/20 text-white text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border border-white/30">
                  Free to install
                </span>
              </div>
              <p className="text-orange-50 text-xs mt-0.5">
                Get pinged on Slack &amp; desktop the moment a message, task, appointment, or opportunity hits the sub-account — even when no one is logged in. Assigned-only, business-hours aware.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <a
              href="https://notify.vaultsuite.store"
              target="_blank"
              rel="noopener noreferrer"
              className="hidden sm:inline-flex items-center gap-1.5 bg-white/15 hover:bg-white/25 text-white text-sm font-semibold px-3 py-2 rounded-lg transition-colors border border-white/30"
            >
              Learn more
            </a>
            <a
              href="https://marketplace.gohighlevel.com/integration/6962592adbdd5106c52e257a"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 bg-white hover:bg-orange-50 text-orange-600 text-sm font-semibold px-4 py-2 rounded-lg transition-colors shadow-sm"
            >
              Install now
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M17 8l4 4m0 0l-4 4m4-4H3" />
              </svg>
            </a>
          </div>
        </div>
        */}

        {/* Cross-Promo Banners — HelmDesk (left) + Telegram (right). Compact single-row cards so they
            stay small at the top of the dashboard: icon · title + one-line pitch · Install button. */}
        <div className="mb-4 grid grid-cols-1 md:grid-cols-2 gap-3">

          {/* HelmDesk — Support Ticket System & Helpdesk. Marketplace app id: 6a42b01a904c53a589aae692 */}
          <div className="bg-gradient-to-r from-violet-600 to-fuchsia-600 rounded-xl pl-3.5 pr-3 py-2.5 flex items-center gap-3 shadow-sm">
            <div className="w-8 h-8 bg-white/20 rounded-lg flex items-center justify-center flex-shrink-0">
              {/* Ticket icon */}
              <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
              </svg>
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <p className="text-white font-semibold text-sm truncate">HelmDesk</p>
                <span className="hidden sm:inline-flex items-center bg-white/20 text-white text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full border border-white/30 flex-shrink-0">
                  White-label
                </span>
              </div>
              <p className="text-violet-50 text-xs truncate">White-label helpdesk — chat widget &amp; support forms turn every message into a tracked ticket. Resell as your own.</p>
            </div>
            <a
              href="https://marketplace.gohighlevel.com/integration/6a42b01a904c53a589aae692"
              target="_blank"
              rel="noopener noreferrer"
              title="Install HelmDesk"
              className="inline-flex items-center gap-1 bg-white hover:bg-violet-50 text-purple-700 text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors shadow-sm flex-shrink-0"
            >
              Install
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M17 8l4 4m0 0l-4 4m4-4H3" />
              </svg>
            </a>
          </div>

          {/* Telegram Messaging Connector. Marketplace app id: 69b67036e65bf138703a31d7 */}
          <div className="bg-gradient-to-r from-sky-500 to-blue-600 rounded-xl pl-3.5 pr-3 py-2.5 flex items-center gap-3 shadow-sm">
            <div className="w-8 h-8 bg-white/20 rounded-lg flex items-center justify-center flex-shrink-0">
              {/* Paper-plane (Telegram) icon */}
              <svg className="w-4 h-4 text-white" fill="currentColor" viewBox="0 0 24 24">
                <path d="M21.94 4.3 2.9 11.64c-1.24.5-1.23 1.2-.22 1.5l4.87 1.52 1.88 5.77c.23.63.11.88.77.88.51 0 .74-.23 1.02-.51l2.36-2.3 4.9 3.62c.9.5 1.55.24 1.78-.84l3.2-15.1c.33-1.32-.5-1.92-1.36-1.53Z" />
              </svg>
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <p className="text-white font-semibold text-sm truncate">Telegram Connector</p>
                <span className="hidden sm:inline-flex items-center bg-white/20 text-white text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full border border-white/30 flex-shrink-0">
                  Free
                </span>
              </div>
              <p className="text-sky-50 text-xs truncate">Two-way Telegram in your Conversations inbox — bot & phone, media sync, workflows & triggers.</p>
            </div>
            <a
              href="https://marketplace.gohighlevel.com/integration/69b67036e65bf138703a31d7/versions/69cd720d516a315c8f08c6e4"
              target="_blank"
              rel="noopener noreferrer"
              title="Install Telegram Connector"
              className="inline-flex items-center gap-1 bg-white hover:bg-sky-50 text-blue-600 text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors shadow-sm flex-shrink-0"
            >
              Install
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M17 8l4 4m0 0l-4 4m4-4H3" />
              </svg>
            </a>
          </div>

        </div>

        {/* Custom Work / AI Agents Promo Banner — temporarily hidden */}
        {/*
        <div className="mb-4 bg-gradient-to-r from-indigo-600 via-purple-600 to-pink-600 rounded-xl px-5 py-3 flex items-center justify-between shadow-md">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-white/20 rounded-full flex items-center justify-center flex-shrink-0">
              <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <p className="text-white font-semibold text-sm">Hire a former HighLevel developer</p>
                <span className="hidden sm:inline-flex items-center gap-1 bg-white/20 text-white text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border border-white/30">
                  Ex-HighLevel · 5+ yrs
                </span>
              </div>
              <p className="text-purple-100 text-xs mt-0.5">Custom GHL apps, integrations, automations & AI agents — quality work at low cost. Need something built? Let's talk.</p>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <a
              href="mailto:rapiddev21@gmail.com"
              className="flex items-center gap-2 bg-white hover:bg-gray-50 text-indigo-600 text-sm font-semibold px-4 py-2 rounded-lg transition-colors shadow-sm"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
              </svg>
              Email
            </a>
            <a
              href="https://www.facebook.com/profile.php?id=61585960844180"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 bg-white/15 hover:bg-white/25 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors shadow-sm border border-white/30"
            >
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/>
              </svg>
              Facebook
            </a>
          </div>
        </div>
        */}

        {/* Mode tabs (Export / Import) — connected to the sub-tab card below like browser tabs.
            No horizontal padding here so the leftmost mode tab lines up with the left edge of the
            sub-tabs card underneath. */}
        <div className="flex items-end gap-2">
          {[
            { key: 'export', label: 'Export Data', tagline: 'Pull data out as CSV / JSON' },
            // Import mode hidden entirely when disabled for this location.
            ...(importDisabled ? [] : [{ key: 'import', label: 'Import Data', tagline: 'Bring data in from a CSV' }]),
          ].map(m => {
            // Only highlight the mode tab when the user is actually inside the export/import sub-tabs.
            // Standalone tabs (Export History, Support) take focus away from both mode tabs.
            const active = dataMode === m.key && !['exports', 'support'].includes(activeTab);
            return (
              <button
                key={m.key}
                onClick={() => switchMode(m.key)}
                className={`
                  group relative flex items-center gap-3 px-5 pt-3 pb-4 rounded-t-xl transition-all
                  ${active
                    ? 'bg-gradient-to-br from-blue-600 to-blue-700 text-white shadow-lg z-10'
                    : 'bg-white/70 hover:bg-white text-gray-600 border border-gray-200 border-b-0'
                  }
                `}
              >
                {/* Icon */}
                <div className={`
                  w-9 h-9 rounded-lg flex items-center justify-center transition-colors
                  ${active ? 'bg-white/20 text-white' : 'bg-gray-100 text-gray-500 group-hover:text-gray-700'}
                `}>
                  {m.key === 'export' ? (
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                    </svg>
                  ) : (
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0l-4 4m4-4v12" />
                    </svg>
                  )}
                </div>
                <div className="text-left">
                  <div className={`font-bold text-sm leading-tight ${active ? 'text-white' : 'text-gray-700'}`}>
                    {m.label}
                  </div>
                  <div className={`text-xs leading-tight mt-0.5 ${active ? 'text-blue-100' : 'text-gray-500'}`}>
                    {m.tagline}
                  </div>
                </div>
              </button>
            );
          })}

          {/* Export History & Support — quick-access tabs, same visual style as mode tabs */}
          {[
            { key: 'exports', label: 'Export History', tagline: 'View past exports', icon: '📤' },
            { key: 'support', label: 'Support', tagline: 'Get help', icon: '🆘' },
          ].map(t => {
            const active = activeTab === t.key;
            return (
              <button
                key={t.key}
                onClick={() => { setActiveTab(t.key); setShowConversationView(false); }}
                className={`
                  group relative flex items-center gap-3 px-5 pt-3 pb-4 rounded-t-xl transition-all
                  ${active
                    ? 'bg-gradient-to-br from-blue-600 to-blue-700 text-white shadow-lg z-10'
                    : 'bg-white/70 hover:bg-white text-gray-600 border border-gray-200 border-b-0'
                  }
                `}
              >
                <div className={`
                  w-9 h-9 rounded-lg flex items-center justify-center text-lg transition-colors
                  ${active ? 'bg-white/20 text-white' : 'bg-gray-100 text-gray-500 group-hover:text-gray-700'}
                `}>
                  {t.icon}
                </div>
                <div className="text-left">
                  <div className={`font-bold text-sm leading-tight ${active ? 'text-white' : 'text-gray-700'}`}>
                    {t.label}
                  </div>
                  <div className={`text-xs leading-tight mt-0.5 ${active ? 'text-blue-100' : 'text-gray-500'}`}>
                    {t.tagline}
                  </div>
                </div>
              </button>
            );
          })}
        </div>

        {/* Sidebar nav + content panel — same layout for Export and Import.
            Sidebar is hidden for standalone tabs (Export History, Support) where it doesn't apply. */}
        <div className="bg-white rounded-xl shadow-lg flex overflow-hidden border-t border-gray-200">
          {/* Sidebar */}
          {!['exports', 'support'].includes(activeTab) && (() => {
            const q = navSearch.trim().toLowerCase();
            const groups = (dataMode === 'export' ? exportGroupsVisible : importGroupsVisible)
              // When searching, filter items by label and drop groups with no match.
              .map((g) => ({ ...g, items: q ? g.items.filter((it) => it.label.toLowerCase().includes(q)) : g.items }))
              .filter((g) => g.items.length > 0);
            const noMatches = q && groups.length === 0;
            return (
            <aside className="w-64 flex-shrink-0 border-r border-gray-200/70 bg-gray-50/40 flex flex-col max-h-[calc(100vh-7rem)]">
              {/* Search */}
              <div className="p-3 border-b border-gray-200/70 sticky top-0 bg-gray-50/90 backdrop-blur-sm z-10">
                <div className="relative">
                  <svg className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
                    viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" />
                  </svg>
                  <input
                    type="text"
                    value={navSearch}
                    onChange={(e) => setNavSearch(e.target.value)}
                    placeholder={`Search ${dataMode === 'export' ? 'exports' : 'imports'}…`}
                    className="w-full pl-9 pr-8 py-2 text-sm bg-white border border-gray-200 rounded-lg text-gray-700 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 transition"
                  />
                  {navSearch && (
                    <button
                      onClick={() => setNavSearch('')}
                      title="Clear"
                      className="absolute right-2 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center rounded text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition"
                    >
                      <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
                    </button>
                  )}
                </div>
              </div>

              {/* Groups */}
              <nav className="flex-1 overflow-y-auto py-2 px-2">
                {noMatches && (
                  <div className="px-3 py-8 text-center text-sm text-gray-400">
                    No exports match “{navSearch.trim()}”.
                  </div>
                )}
                {groups.map((group, gi) => {
                  // Searching forces every matching group open; otherwise honor the collapse state.
                  const collapsed = !q && group.label && collapsedGroups.has(group.label);
                  return (
                    <div key={group.label || `g-${gi}`} className="mb-1">
                      {group.label && (
                        <button
                          onClick={() => toggleGroup(group.label)}
                          className="w-full group flex items-center gap-2 px-2.5 pt-3 pb-1.5 text-[11px] font-bold uppercase tracking-wider text-gray-600 hover:text-gray-900 select-none transition-colors"
                        >
                          <svg
                            className={`w-3.5 h-3.5 flex-shrink-0 text-gray-500 group-hover:text-gray-700 transition-transform duration-200 ${collapsed ? '-rotate-90' : ''}`}
                            viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round"
                          >
                            <path d="M6 9l6 6 6-6" />
                          </svg>
                          <span className="flex-1 text-left">{group.label}</span>
                          <span className="min-w-[20px] text-center text-[10px] font-semibold text-gray-500 bg-gray-200/70 group-hover:bg-gray-200 group-hover:text-gray-700 rounded-full px-1.5 py-0.5 tabular-nums transition-colors">{group.items.length}</span>
                        </button>
                      )}
                      {!collapsed && (
                        <div className="space-y-0.5 mt-0.5">
                          {group.items.map((tab) => {
                            const isActive = activeTab === tab.id;
                            return (
                              <button
                                key={tab.id}
                                onClick={() => {
                                  setActiveTab(tab.id);
                                  setShowConversationView(false);
                                }}
                                title={tab.label}
                                className={`
                                  w-full flex items-center gap-2.5 pl-2 pr-2.5 py-1.5 rounded-lg text-sm font-medium transition-all text-left group/item
                                  ${isActive
                                    ? 'bg-blue-600 text-white shadow-sm shadow-blue-600/20'
                                    : 'text-gray-600 hover:bg-white hover:text-gray-900 hover:shadow-sm'
                                  }
                                `}
                              >
                                <span className={`
                                  flex-shrink-0 w-7 h-7 rounded-md flex items-center justify-center transition-colors
                                  ${isActive
                                    ? 'bg-white/20 text-white'
                                    : 'bg-white text-gray-500 border border-gray-200 group-hover/item:text-blue-600 group-hover/item:border-blue-200'
                                  }
                                `}>
                                  <NavIcon id={tab.id} />
                                </span>
                                <span className="truncate">{tab.label}</span>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </nav>
            </aside>
            );
          })()}

          {/* Content */}
          <div className="flex-1 min-w-0 p-8">
            {showConversationView && (
              <div className="mb-6 flex items-center gap-2 text-sm text-gray-600">
                <button
                  onClick={() => setShowConversationView(false)}
                  className="hover:text-blue-600 transition-colors font-medium"
                >
                  Conversation Threads
                </button>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
                <span className="text-gray-900 font-medium">{selectedConversation?.contactName || 'Messages'}</span>
              </div>
            )}

            {showConversationView ? (
              <ConversationMessages
                conversation={selectedConversation}
                onBack={() => setShowConversationView(false)}
              />
            ) : (tabUpgrades[activeTab]?.needsUpgrade) ? (
              // Per-tab app-version gate — the active tab requires a newer app version. Shown at render
              // (the tab stays clickable). Only new/out-of-date tabs land here; existing tabs never do.
              <div className="flex items-center justify-center py-16">
                <div className="max-w-md text-center bg-gradient-to-br from-indigo-50 to-blue-50 border border-indigo-200 rounded-xl p-8">
                  <div className="w-14 h-14 rounded-full bg-indigo-100 flex items-center justify-center text-3xl mx-auto mb-4">⬆️</div>
                  <h3 className="text-lg font-bold text-gray-900">Update the app to use this feature</h3>
                  <p className="text-sm text-gray-600 mt-2">
                    {tabUpgrades[activeTab]?.reason
                      || 'This feature is available in a newer version of the app. Please update the app to the latest version to use it.'}
                  </p>
                  <a
                    href={buildMarketplaceUrl(tabUpgrades[activeTab]?.requiredVersionId)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 mt-5 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold px-5 py-2.5 rounded-lg transition-colors shadow-sm"
                  >
                    Update the app
                  </a>
                </div>
              </div>
            ) : (
              <>
                {activeTab === 'conversations' && <ConversationsTab onSelectConversation={handleConversationSelect} />}
                {activeTab === 'messages' && <MessagesTab />}
                {activeTab === 'specialTabMessages' && <SpecialMessagesTab />}
                {activeTab === 'contacts' && <ExportContactsTab />}
                {activeTab === 'opportunities' && <OpportunitiesTab />}
                {activeTab === 'formSubmissions' && <FormSubmissionsTab />}
                {activeTab === 'notesSearch' && <NotesSearchTab />}
                {activeTab === 'notes' && <NotesTab />}
                {activeTab === 'tasks' && <TasksTab />}
                {activeTab === 'templates' && <TemplatesTab />}
                {activeTab === 'links' && <LinksTab />}
                {activeTab === 'callLogs' && <CallLogsTab />}
                {activeTab === 'customFields' && <CustomFieldsTab />}
                {activeTab === 'customValues' && <CustomValuesTab />}
                {activeTab === 'tags' && <TagsTab />}
                {activeTab === 'appointments' && <AppointmentsTab />}
                {activeTab === 'invoices' && <InvoicesTab />}
                {activeTab === 'paymentOrders' && <PaymentOrdersTab />}
                {activeTab === 'paymentTransactions' && <PaymentTransactionsTab />}
                {activeTab === 'paymentSubscriptions' && <PaymentSubscriptionsTab />}
                {activeTab === 'surveySubmissions' && <SurveySubmissionsTab />}
                {activeTab === 'businesses' && <BusinessesTab />}
                {activeTab === 'products' && <ProductsTab />}
                {activeTab === 'mediaFiles' && <MediaFilesTab />}
                {activeTab === 'opportunityStageHistory' && features?.opportunityStageHistory && <OpportunityStageHistoryTab />}
                {activeTab === 'callTranscriptions' && callTranscriptionsEnabled && <CallTranscriptionsTab />}
                {activeTab === 'callRecordings' && <CallRecordingsTab />}
                {activeTab === 'contactBundle' && <ContactBundleTab contactBundleDocEnabled={contactBundleDocEnabled} />}
                {activeTab === 'messagesByTag' && <MessagesByTagTab />}
                {activeTab === 'groupMessages' && <GroupMessagesTab />}
                {activeTab === 'customCharge' && customChargeEnabled && <CustomChargeTab />}
                {activeTab === 'importContacts' && <ImportContactsTab />}
                {activeTab === 'importNotes' && <ImportNotesTab />}
                {activeTab === 'importOpportunities' && <ImportOpportunitiesTab />}
                {activeTab === 'importTasks' && <ImportTasksTab />}
                {activeTab === 'importCustomFields' && <ImportCustomFieldsTab />}
                {activeTab === 'importCustomValues' && <ImportCustomValuesTab />}
                {activeTab === 'exports' && <ExportTab />}
                {activeTab === 'support' && <SupportTab />}
              </>
            )}
          </div>
        </div>

      </div>
    </div>
  );
}

