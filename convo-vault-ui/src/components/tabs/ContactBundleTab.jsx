import React, { useState, useEffect, useRef } from 'react';
import { useAuth } from '../../context/AuthContext';
import { billingAPI } from '../../api/billing';
import { contactsAPI } from '../../api/contacts';
import { Button, Select, message as antMessage } from 'antd';
import ExportEstimateModal from '../ExportEstimateModal';
import ExportProgress from '../ExportProgress';

/**
 * Contact Bundle — pulls every message (SMS, WhatsApp, Webchat, FB/IG), every email, and every
 * call transcription for the selected contacts. Outputs one CSV row per message sorted by
 * dateAdded ASC. Billed at flat rates with no volume discount:
 *   SMS-like : $0.02   Email : $0.04   Call : $0.05
 * Contact filter is REQUIRED (no whole-sub-account fallback).
 */
export default function ContactBundleTab({ contactBundleDocEnabled = false }) {
  const { location } = useAuth();

  // Sub-tab inside Contact Bundle: 'default' = existing CSV/JSON bundle, 'doc' = Google Doc (.docx).
  // The 'doc' sub-tab only renders when the location is enabled via AppConfig.
  const [subTab, setSubTab] = useState('default');
  const isDoc = subTab === 'doc' && contactBundleDocEnabled;
  const activeExportType = isDoc ? 'contactBundleDoc' : 'contactBundle';

  const [exportModalVisible, setExportModalVisible] = useState(false);
  const [estimating, setEstimating] = useState(false);
  const [estimate, setEstimate] = useState(null);
  const [estimateError, setEstimateError] = useState(null);
  const [specialExportId, setSpecialExportId] = useState(null);
  const [processing, setProcessing] = useState(false);
  const [activeJob, setActiveJob] = useState(null);

  // Doc output format: 'both' (PDF + HTML zip) | 'pdf' | 'html'. Only used by the Google Doc sub-tab.
  const [docFormat, setDocFormat] = useState('both');

  // Contact picker — at least one required.
  const [selectedContactIds, setSelectedContactIds] = useState([]);
  const [contactOptions, setContactOptions] = useState([]);
  const [contactsLoading, setContactsLoading] = useState(false);
  const searchTimeoutRef = useRef(null);

  const getContactName = (c) =>
    c?.contactName || `${c?.firstName || ''} ${c?.lastName || ''}`.trim() || c?.email || c?.phone || 'Unknown';

  // Load 100 contacts on mount.
  useEffect(() => {
    if (!location?.id) return;
    setContactsLoading(true);
    contactsAPI.search(location.id, '', 100)
      .then(res => {
        if (res.success) {
          const contacts = res.data.contacts || [];
          setContactOptions(contacts.map(c => ({
            value: c.id,
            label: `${getContactName(c)}${c.email ? ` — ${c.email}` : c.phone ? ` — ${c.phone}` : ''}`,
            contact: c
          })));
        }
      })
      .catch(() => {})
      .finally(() => setContactsLoading(false));
  }, [location?.id]);

  // Debounced server-side search merges new results into the dropdown pool.
  const handleContactSearch = (query) => {
    clearTimeout(searchTimeoutRef.current);
    if (!query || !query.trim()) return;
    searchTimeoutRef.current = setTimeout(async () => {
      setContactsLoading(true);
      try {
        const res = await contactsAPI.search(location.id, query, 20);
        if (res.success) {
          const apiResults = res.data.contacts || [];
          setContactOptions(prev => {
            const seen = new Set(prev.map(o => o.value));
            const merged = [...prev];
            for (const c of apiResults) {
              if (!seen.has(c.id)) {
                merged.push({
                  value: c.id,
                  label: `${getContactName(c)}${c.email ? ` — ${c.email}` : c.phone ? ` — ${c.phone}` : ''}`,
                  contact: c
                });
              }
            }
            return merged;
          });
        }
      } catch {}
      finally { setContactsLoading(false); }
    }, 400);
  };

  // Poll active job
  useEffect(() => {
    if (!activeJob || !['pending', 'processing'].includes(activeJob.status)) return;
    const pollInterval = setInterval(async () => {
      try {
        const response = await billingAPI.getExportStatus(activeJob.jobId, location?.id);
        if (response.success) {
          setActiveJob(response.data);
          if (response.data.status === 'completed') {
            antMessage.success('Export completed! Click Download to get your file.');
          }
        }
      } catch (err) { /* silent */ }
    }, 5000);
    return () => clearInterval(pollInterval);
  }, [activeJob?.jobId, activeJob?.status, location?.id]);

  // Doc is single-contact; the default bundle allows multiple. Trim the selection for the Doc tab.
  const effectiveContactIds = isDoc ? selectedContactIds.slice(0, 1) : selectedContactIds;
  const buildExportFilters = () => ({ contactIds: effectiveContactIds });

  const handleGetEstimate = async () => {
    if (effectiveContactIds.length === 0) {
      antMessage.warning(isDoc ? 'Please select a contact to export.' : 'Please select at least one contact to export.');
      return;
    }
    setExportModalVisible(true);
    setEstimating(true);
    setEstimate(null);
    setEstimateError(null);
    try {
      const response = await billingAPI.getEstimate(location.id, activeExportType, buildExportFilters());
      if (response.success) {
        setEstimate(response.data.estimate);
        setSpecialExportId(response.data.specialExportId || null);
      } else {
        setEstimateError(response.error || 'Failed to calculate estimate');
      }
    } catch (err) {
      setEstimateError(err.message || 'Failed to calculate estimate');
    } finally {
      setEstimating(false);
    }
  };

  const handlePayAndExport = async (notificationEmail, format = 'csv') => {
    setProcessing(true);
    setEstimateError(null);
    try {
      const filters = {
        ...buildExportFilters(),
        estimatedTotal: estimate?.itemCounts?.total || undefined,
        specialExportId: specialExportId || undefined
      };
      // Doc variant: the output format is chosen here (both | pdf | html), not in the modal.
      // Default bundle keeps the modal's csv/json selection.
      const chargeFormat = isDoc ? docFormat : format;
      const response = await billingAPI.chargeAndExport(location.id, activeExportType, chargeFormat, filters, notificationEmail);
      if (response.success) {
        setActiveJob({
          jobId: response.data.jobId,
          status: response.data.status,
          exportType: activeExportType,
          totalItems: response.data.totalItems,
          progress: { total: response.data.totalItems, processed: 0, percent: 0 }
        });
        setExportModalVisible(false);
        setEstimate(null);
        antMessage.success("Export started! We'll notify you by email when it's ready.");
      } else {
        setEstimateError(response.error || 'Export failed');
      }
    } catch (err) {
      setEstimateError(err.code === 'INSUFFICIENT_FUNDS' ? err : (err.message || 'Export failed'));
    } finally {
      setProcessing(false);
    }
  };

  const handleModalClose = () => {
    if (!processing) { setExportModalVisible(false); setEstimate(null); setEstimateError(null); }
  };

  return (
    <div className="space-y-6">
      <ExportEstimateModal
        visible={exportModalVisible}
        onCancel={handleModalClose}
        onConfirm={handlePayAndExport}
        loading={processing}
        estimating={estimating}
        estimate={estimate}
        error={estimateError}
        exportType={activeExportType}
      />

      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Contact Bundle</h2>
          <p className="text-sm text-gray-500 mt-1">
            {isDoc
              ? 'Export every message, email, and call transcription for one contact — a document styled like your GHL conversation view. Choose PDF, HTML, or both.'
              : 'Export every message, email, and call transcription for selected contacts — one CSV, sorted by time.'}
          </p>
        </div>
      </div>

      {/* Sub-tabs: Default (CSV/JSON) and Google Doc (.docx). The Google Doc tab only renders
          when the location is enabled via AppConfig (contactBundleDocEnabled). */}
      {contactBundleDocEnabled && (
        <div className="flex gap-1 border-b border-gray-200">
          {[
            { id: 'default', label: 'Default' },
            { id: 'doc', label: 'Google Doc' },
          ].map(t => (
            <button
              key={t.id}
              type="button"
              onClick={() => {
                setSubTab(t.id);
                setEstimate(null);
                setEstimateError(null);
                // Doc is single-contact — trim any multi-selection down to one when switching in.
                if (t.id === 'doc') setSelectedContactIds(prev => prev.slice(0, 1));
              }}
              className={`px-4 py-2 text-sm font-medium -mb-px border-b-2 transition-colors ${
                subTab === t.id
                  ? 'border-green-600 text-green-700'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}

      {activeJob && (
        <ExportProgress
          job={activeJob}
          onRefresh={async () => {
            try {
              const response = await billingAPI.getExportStatus(activeJob.jobId, location?.id);
              if (response.success) setActiveJob(response.data);
            } catch {}
          }}
          onDismiss={() => setActiveJob(null)}
        />
      )}

      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
        <div className="mb-4">
          <label className="block text-sm font-medium text-gray-700 mb-2">
            {isDoc ? 'Contact' : 'Contacts'} <span className="text-red-500">*</span>
          </label>
          <Select
            // Google Doc is a single-contact export; the default bundle allows multiple.
            mode={isDoc ? undefined : 'multiple'}
            allowClear
            showSearch
            value={isDoc ? (selectedContactIds[0] ?? undefined) : selectedContactIds}
            onChange={(val) => setSelectedContactIds(isDoc ? (val ? [val] : []) : val)}
            onSearch={handleContactSearch}
            optionFilterProp="label"
            loading={contactsLoading}
            placeholder={isDoc ? 'Search and select one contact...' : 'Search and select one or more contacts...'}
            options={contactOptions}
            style={{ width: '100%' }}
            maxTagCount="responsive"
            notFoundContent={contactsLoading ? 'Searching…' : 'No contacts found — try typing a name or email'}
          />
          <p className="text-xs text-gray-500 mt-2">
            {effectiveContactIds.length > 0
              ? (isDoc
                  ? <><strong>1</strong> contact selected.</>
                  : <><strong>{effectiveContactIds.length}</strong> contact{effectiveContactIds.length === 1 ? '' : 's'} selected.</>)
              : (isDoc ? 'Required: pick one contact.' : 'Required: pick at least one contact.')}
          </p>
        </div>

        {/* Doc-only: output format + in-app sample preview. */}
        {isDoc && (
          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 mb-2">Output format</label>
            <Select
              value={docFormat}
              onChange={setDocFormat}
              style={{ width: '100%', maxWidth: 360 }}
              options={[
                { value: 'both', label: 'Both — PDF + HTML (a .zip with both files)' },
                { value: 'pdf', label: 'Only PDF' },
                { value: 'html', label: 'Only HTML' },
              ]}
            />
            <p className="text-xs text-gray-500 mt-2">
              Not sure which to pick? Preview a sample:{' '}
              <a href="/sample-contact-bundle.pdf" target="_blank" rel="noopener noreferrer" className="text-green-700 font-medium hover:underline">View sample PDF</a>
              {' · '}
              <a href="/sample-contact-bundle.html" target="_blank" rel="noopener noreferrer" className="text-green-700 font-medium hover:underline">View sample HTML</a>
            </p>
          </div>
        )}

        <Button
          type="primary"
          size="large"
          onClick={handleGetEstimate}
          loading={estimating}
          disabled={!location?.id || effectiveContactIds.length === 0}
          className="bg-green-600 hover:bg-green-700 border-green-600"
        >
          Get Estimate & Export
        </Button>

        <div className="mt-4 p-3 bg-amber-50 border border-amber-200 rounded-lg">
          <p className="text-sm text-amber-800">
            <strong>Heavy task:</strong> we walk each selected contact's conversations to collect every message,
            fetch emails via bulk export, and pull a transcript for every eligible call.
            {isDoc ? (
              <>
                {' '}Output is laid out like your GHL conversation view — chat bubbles, a channel summary, and call
                transcripts. Pick <strong>PDF</strong>, <strong>HTML</strong>, or <strong>both</strong> (delivered as a .zip).
                Pricing: <strong>$0.08 per record</strong> — no volume discount.
              </>
            ) : (
              <>
                {' '}Pricing: <strong>$0.02 / message</strong> + <strong>$0.04 / email</strong> + <strong>$0.05 / call transcription</strong>
                {' '}— no volume discount.
              </>
            )}
          </p>
        </div>
      </div>
    </div>
  );
}
