import { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import Header from './Header';
import ConversationsTab from './tabs/ConversationsTab';
import MessagesTab from './tabs/MessagesTab';
import SupportTab from './tabs/SupportTab';
import ExportTab from './tabs/ExportTab';
import NotesTab from './tabs/NotesTab';
import TasksTab from './tabs/TasksTab';
import OpportunitiesTab from './tabs/OpportunitiesTab';
import FormSubmissionsTab from './tabs/FormSubmissionsTab';
import LinksTab from './tabs/LinksTab';
import CallLogsTab from './tabs/CallLogsTab';
import TemplatesTab from './tabs/TemplatesTab';
import SpecialMessagesTab from './tabs/SpecialMessagesTab';
import CallTranscriptionsTab from './tabs/CallTranscriptionsTab';
import ContactBundleTab from './tabs/ContactBundleTab';
import MessagesByTagTab from './tabs/MessagesByTagTab';
import GroupMessagesTab from './tabs/GroupMessagesTab';
import ExportContactsTab from './tabs/ExportContactsTab';
import ConversationMessages from './ConversationMessages';
import { billingAPI } from '../api/billing';
import CustomChargeTab from './tabs/CustomChargeTab';
import ImportNotesTab from './tabs/ImportNotesTab';
import ImportContactsTab from './tabs/ImportContactsTab';
import CustomFieldsTab from './tabs/CustomFieldsTab';
import CustomValuesTab from './tabs/CustomValuesTab';
import TagsTab from './tabs/TagsTab';
import ImportCustomFieldsTab from './tabs/ImportCustomFieldsTab';
import ImportCustomValuesTab from './tabs/ImportCustomValuesTab';
import OpportunityStageHistoryTab from './tabs/OpportunityStageHistoryTab';
import { MESSAGE_PRICE_TIERS } from '../constants/pricing';

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
  // Per-location tab kill-switch (from AppConfig `disabledTabs:<locationId>`). Holds tab ids to
  // hide, and/or the value 'import' to hide the whole Import mode. Empty = nothing disabled.
  const [disabledTabs, setDisabledTabs] = useState([]);
  const importDisabled = disabledTabs.includes('import');

  // Persist mode + sub-tab
  useEffect(() => { localStorage.setItem('dataMode', dataMode); }, [dataMode]);
  useEffect(() => { localStorage.setItem('activeTab', activeTab); }, [activeTab]);

  useEffect(() => {
    if (!location?.id) return;
    billingAPI.getPricing(location.id).then(res => {
      setCustomChargeEnabled(!!res?.data?.customChargeEnabled);
      setCallTranscriptionsEnabled(!!res?.data?.callTranscriptionsEnabled);
      setDisabledTabs(Array.isArray(res?.data?.disabledTabs) ? res.data.disabledTabs : []);
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
        { id: 'notes', label: 'Notes', icon: '📝' },
        { id: 'tasks', label: 'Tasks', icon: '✅' },
        { id: 'templates', label: 'Templates', icon: '📄' },
        { id: 'links', label: 'Links', icon: '🔗' },
        { id: 'callLogs', label: 'Voice AI', icon: '📞' },
        { id: 'customFields', label: 'Custom Fields', icon: '🧩' },
        { id: 'customValues', label: 'Custom Values', icon: '🔖' },
        { id: 'tags', label: 'Tags', icon: '🏷️' },
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

        {/* Price Drop Promo Strip */}
        <div className="mb-3 rounded-xl overflow-hidden border border-emerald-200 bg-gradient-to-r from-emerald-50 via-teal-50 to-emerald-50 relative">
          <div className="absolute inset-y-0 right-0 w-1/3 bg-gradient-to-l from-emerald-100/60 to-transparent pointer-events-none"></div>
          <div className="absolute -top-10 -right-10 w-40 h-40 bg-emerald-300/20 rounded-full blur-3xl pointer-events-none"></div>
          <div className="relative px-4 py-2.5 flex items-center gap-3 flex-wrap">
            <div className="relative flex-shrink-0 flex items-center gap-2">
              <span className="text-xl leading-none">🎉</span>
              <span className="inline-flex items-center text-[10px] font-bold bg-emerald-600 text-white px-2 py-1 rounded-md uppercase tracking-wider shadow-sm">
                Price Drop
              </span>
              <span className="absolute -top-1 -right-1 w-2 h-2 bg-emerald-500 rounded-full animate-ping"></span>
              <span className="absolute -top-1 -right-1 w-2 h-2 bg-emerald-500 rounded-full"></span>
            </div>
            <div className="flex-1 min-w-[200px]">
              <p className="text-sm text-gray-800">
                <span className="font-semibold text-emerald-900">Save up to {MAX_SAVINGS_PCT}% on messages.</span>
                <span className="text-gray-700 ml-1.5">
                  SMS, WhatsApp &amp; email get cheaper the more you export — discount auto-applied at estimate time.
                </span>
              </p>
              {/* Tier chips: live price + savings vs the $0.018 base, driven by the shared pricing constant. */}
              <div className="hidden sm:flex items-center gap-1.5 mt-1.5 flex-wrap">
                {SAVINGS_TIERS.map((t) => (
                  <span
                    key={t.label}
                    className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-800 bg-white/80 px-2 py-0.5 rounded-md border border-emerald-200"
                  >
                    <strong className="text-emerald-900">{t.label}</strong>
                    <span className="text-emerald-700">{t.price}</span>
                    <span className="text-[10px] font-bold bg-emerald-600 text-white px-1 py-px rounded">
                      Save {t.savePct}%
                    </span>
                  </span>
                ))}
              </div>
            </div>
            <div className="hidden md:flex items-center gap-1.5 flex-shrink-0 self-start">
              <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-emerald-700 bg-white px-2 py-1 rounded-md border border-emerald-200">
                <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={3} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
                Auto-applied
              </span>
            </div>
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

        {/* Cross-Promo Banners — HelmDesk (left) + Telegram (right), side by side on md+, stacked on mobile. */}
        <div className="mb-4 grid grid-cols-1 md:grid-cols-2 gap-4">

          {/* HelmDesk — Support Ticket System & Helpdesk.
              Marketplace app id: 6a42b01a904c53a589aae692 */}
          <div className="bg-gradient-to-br from-violet-600 via-purple-600 to-fuchsia-600 rounded-xl px-5 py-4 flex flex-col shadow-md">
            <div className="flex items-start gap-3 min-w-0 flex-1">
              <div className="w-10 h-10 bg-white/20 rounded-full flex items-center justify-center flex-shrink-0">
                {/* Ticket / lifebuoy icon */}
                <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
                </svg>
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-white font-semibold text-sm">🎧 HelmDesk — white-label helpdesk &amp; support tickets</p>
                  <span className="hidden sm:inline-flex items-center bg-white/20 text-white text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border border-white/30">
                    White-label
                  </span>
                </div>
                <p className="text-violet-50 text-xs mt-0.5">
                  Turn every inbound SMS, Email, WhatsApp, Live Chat, FB &amp; IG message into a tracked support ticket — SLA countdowns, Kanban board, routing, and a fully branded client portal. Resell it as your own.
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0 mt-3">
              <a
                href="https://marketplace.gohighlevel.com/integration/6a42b01a904c53a589aae692"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 bg-white hover:bg-violet-50 text-purple-700 text-sm font-semibold px-4 py-2 rounded-lg transition-colors shadow-sm"
              >
                Install now
                <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M17 8l4 4m0 0l-4 4m4-4H3" />
                </svg>
              </a>
            </div>
          </div>

          {/* Telegram Messaging Connector — now live on the HighLevel Marketplace.
              Marketplace app id: 69b67036e65bf138703a31d7 */}
          <div className="bg-gradient-to-br from-sky-500 via-cyan-500 to-blue-600 rounded-xl px-5 py-4 flex flex-col shadow-md">
            <div className="flex items-start gap-3 min-w-0 flex-1">
              <div className="w-10 h-10 bg-white/20 rounded-full flex items-center justify-center flex-shrink-0">
                {/* Paper-plane (Telegram) icon */}
                <svg className="w-6 h-6 text-white" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M21.94 4.3 2.9 11.64c-1.24.5-1.23 1.2-.22 1.5l4.87 1.52 1.88 5.77c.23.63.11.88.77.88.51 0 .74-.23 1.02-.51l2.36-2.3 4.9 3.62c.9.5 1.55.24 1.78-.84l3.2-15.1c.33-1.32-.5-1.92-1.36-1.53Z" />
                </svg>
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-white font-semibold text-sm">🚀 Telegram Messaging Connector — now live on the Marketplace</p>
                  <span className="hidden sm:inline-flex items-center bg-white/20 text-white text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border border-white/30">
                    Free to install
                  </span>
                </div>
                <p className="text-sky-50 text-xs mt-0.5">
                  Two-way Telegram messaging inside your Conversations inbox — Bot &amp; Phone Account support, media &amp; attachment sync, auto contact creation, 10+ workflow actions, 6+ triggers, and group management.
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0 mt-3">
              <a
                href="https://marketplace.gohighlevel.com/integration/69b67036e65bf138703a31d7/versions/69cd720d516a315c8f08c6e4"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 bg-white hover:bg-sky-50 text-blue-600 text-sm font-semibold px-4 py-2 rounded-lg transition-colors shadow-sm"
              >
                Install now
                <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M17 8l4 4m0 0l-4 4m4-4H3" />
                </svg>
              </a>
            </div>
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
          {!['exports', 'support'].includes(activeTab) && (
          <aside className="w-65  flex-shrink-0 border-r border-gray-100 py-4 bg-gray-50/60">
            {(dataMode === 'export' ? exportGroupsVisible : importGroupsVisible).map((group, gi) => (
              <div key={group.label || `g-${gi}`} className="mb-1">
                {group.label && (
                  <div className="px-4 pt-3 pb-1 text-[10px] font-bold uppercase tracking-widest text-gray-400 select-none">
                    {group.label}
                  </div>
                )}
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
                        w-full flex items-center gap-2.5 px-4 py-2 text-sm font-medium transition-all text-left
                        ${isActive
                          ? 'bg-blue-50 text-blue-700 border-r-2 border-blue-600'
                          : 'text-gray-600 hover:bg-gray-100 hover:text-gray-800 border-r-2 border-transparent'
                        }
                      `}
                    >
                      <span className="text-base leading-none">{tab.icon}</span>
                      <span className="truncate">{tab.label}</span>
                    </button>
                  );
                })}
              </div>
            ))}
          </aside>
          )}

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
            ) : (
              <>
                {activeTab === 'conversations' && <ConversationsTab onSelectConversation={handleConversationSelect} />}
                {activeTab === 'messages' && <MessagesTab />}
                {activeTab === 'specialTabMessages' && <SpecialMessagesTab />}
                {activeTab === 'contacts' && <ExportContactsTab />}
                {activeTab === 'opportunities' && <OpportunitiesTab />}
                {activeTab === 'formSubmissions' && <FormSubmissionsTab />}
                {activeTab === 'notes' && <NotesTab />}
                {activeTab === 'tasks' && <TasksTab />}
                {activeTab === 'templates' && <TemplatesTab />}
                {activeTab === 'links' && <LinksTab />}
                {activeTab === 'callLogs' && <CallLogsTab />}
                {activeTab === 'customFields' && <CustomFieldsTab />}
                {activeTab === 'customValues' && <CustomValuesTab />}
                {activeTab === 'tags' && <TagsTab />}
                {activeTab === 'opportunityStageHistory' && features?.opportunityStageHistory && <OpportunityStageHistoryTab />}
                {activeTab === 'callTranscriptions' && callTranscriptionsEnabled && <CallTranscriptionsTab />}
                {activeTab === 'contactBundle' && <ContactBundleTab />}
                {activeTab === 'messagesByTag' && <MessagesByTagTab />}
                {activeTab === 'groupMessages' && <GroupMessagesTab />}
                {activeTab === 'customCharge' && customChargeEnabled && <CustomChargeTab />}
                {activeTab === 'importContacts' && <ImportContactsTab />}
                {activeTab === 'importNotes' && <ImportNotesTab />}
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

