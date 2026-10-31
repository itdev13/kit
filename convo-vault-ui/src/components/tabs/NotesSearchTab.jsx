import React, { useState, useEffect, useRef } from 'react';
import { useAuth } from '../../context/AuthContext';
import { billingAPI } from '../../api/billing';
import { contactsAPI } from '../../api/contacts';
import { Button, Select, Input, message as antMessage } from 'antd';
import ExportEstimateModal from '../ExportEstimateModal';
import ExportProgress from '../ExportProgress';

/**
 * Notes (search) — notes export via POST /notes/search. GHL REQUIRES contact relations (1-200), so
 * contacts are mandatory here (there is no location-wide "all notes" mode on this endpoint). Filters:
 *   - contacts (1-200, REQUIRED) -> relations filter
 *   - search text (optional)     -> matches note title / body
 * Priced exactly like the per-contact Notes export ($0.018/note with volume discount). The backend
 * gathers + chunks the notes during /estimate and returns a specialExportId we reuse at charge time.
 */
export default function NotesSearchTab() {
  const { location } = useAuth();

  const [exportModalVisible, setExportModalVisible] = useState(false);
  const [estimating, setEstimating] = useState(false);
  const [estimate, setEstimate] = useState(null);
  const [estimateError, setEstimateError] = useState(null);
  const [specialExportId, setSpecialExportId] = useState(null);
  const [processing, setProcessing] = useState(false);
  const [activeJob, setActiveJob] = useState(null);

  // Optional contact filter (up to 200).
  const [selectedContactIds, setSelectedContactIds] = useState([]);
  const [contactOptions, setContactOptions] = useState([]);
  const [contactsLoading, setContactsLoading] = useState(false);
  const searchTimeoutRef = useRef(null);

  // Optional text search (title / body).
  const [queryText, setQueryText] = useState('');

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

  const buildExportFilters = () => {
    const filters = {};
    if (selectedContactIds.length > 0) filters.contactIds = selectedContactIds.slice(0, 200);
    if (queryText.trim()) filters.query = queryText.trim();
    return filters;
  };

  const handleGetEstimate = async () => {
    setExportModalVisible(true);
    setEstimating(true);
    setEstimate(null);
    setEstimateError(null);
    setSpecialExportId(null);
    try {
      const response = await billingAPI.getEstimate(location.id, 'notesSearch', buildExportFilters());
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
      const response = await billingAPI.chargeAndExport(location.id, 'notesSearch', format, filters, notificationEmail);
      if (response.success) {
        setActiveJob({
          jobId: response.data.jobId,
          status: response.data.status,
          exportType: 'notesSearch',
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

  const isExporting = activeJob && ['pending', 'processing'].includes(activeJob.status);

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
        exportType="notesSearch"
        estimatingMessage="Searching notes across this sub-account and counting them... This may take a moment, please stay with us!"
      />

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Notes</h2>
          <p className="text-sm text-gray-500 mt-1">
            Select contacts and export their notes — up to 200 contacts at a time.
          </p>
        </div>
        <Button
          onClick={handleGetEstimate}
          disabled={isExporting || !location?.id || selectedContactIds.length === 0}
          size="large"
          type="primary"
          className="bg-green-600 hover:bg-green-700 border-green-600"
          icon={
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
          }
        >
          Get Estimate &amp; Export
        </Button>
      </div>

      {/* Active Export Progress */}
      {activeJob && (
        <ExportProgress
          job={activeJob}
          onRefresh={() => {
            billingAPI.getExportStatus(activeJob.jobId, location?.id)
              .then(res => res.success && setActiveJob(res.data))
              .catch(console.error);
          }}
        />
      )}

      {/* Filters */}
      <div className="bg-white border border-gray-200 rounded-xl p-6 space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Contacts <span className="text-red-500">*</span>
          </label>
          <Select
            mode="multiple"
            allowClear
            showSearch
            value={selectedContactIds}
            onChange={setSelectedContactIds}
            onSearch={handleContactSearch}
            optionFilterProp="label"
            loading={contactsLoading}
            placeholder="Search and select contacts (up to 200)..."
            options={contactOptions}
            style={{ width: '100%' }}
            maxTagCount="responsive"
            notFoundContent={contactsLoading ? 'Searching…' : 'No contacts found — try typing a name or email'}
          />
          <p className="text-xs text-gray-500 mt-2">
            {selectedContactIds.length > 0
              ? <><strong>{selectedContactIds.length}</strong> contact{selectedContactIds.length === 1 ? '' : 's'} selected (max 200).</>
              : 'Select at least one contact — notes export requires contacts.'}
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Search text <span className="text-gray-400">(optional)</span>
          </label>
          <Input
            value={queryText}
            onChange={(e) => setQueryText(e.target.value)}
            onPressEnter={handleGetEstimate}
            placeholder="Match note title or body, e.g. follow up"
            allowClear
          />
          <p className="text-xs text-gray-500 mt-2">
            Matches the note title and body (case-insensitive).
          </p>
        </div>

        <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg">
          <p className="text-sm text-amber-800">
            We search every note that matches your filters, then charge{' '}
            <strong>$0.018 per note</strong> with volume discounts. Exact count and price are shown
            before you pay.
          </p>
        </div>
      </div>

      {/* CSV Columns Info */}
      <div className="bg-white border border-gray-200 rounded-xl p-6">
        <h3 className="text-sm font-semibold text-gray-700 mb-3">Export Columns</h3>
        <div className="flex flex-wrap gap-2">
          {['NoteID', 'ContactID', 'ContactName', 'ContactEmail', 'ContactPhone', 'Title', 'Body', 'BodyText', 'UserID', 'Source', 'Pinned', 'DateAdded', 'Relations'].map((col) => (
            <span key={col} className="px-3 py-1 bg-gray-100 text-gray-700 text-xs font-mono rounded-full">
              {col}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
