import React, { useState, useEffect, useRef } from 'react';
import { useAuth } from '../../context/AuthContext';
import { billingAPI } from '../../api/billing';
import { contactsAPI } from '../../api/contacts';
import { Button, Select, message as antMessage } from 'antd';
import ExportEstimateModal from '../ExportEstimateModal';
import ExportProgress from '../ExportProgress';

export default function CallRecordingsTab() {
  const { location } = useAuth();

  const [exportModalVisible, setExportModalVisible] = useState(false);
  const [estimating, setEstimating] = useState(false);
  const [estimate, setEstimate] = useState(null);
  const [estimateError, setEstimateError] = useState(null);
  const [specialExportId, setSpecialExportId] = useState(null);
  const [processing, setProcessing] = useState(false);
  const [activeJob, setActiveJob] = useState(null);

  // Contact filter — required. The backend scopes the conversation walk to these contacts.
  const [selectedContactIds, setSelectedContactIds] = useState([]);
  const [contactOptions, setContactOptions] = useState([]); // [{ value, label, contact }]
  const [contactsLoading, setContactsLoading] = useState(false);
  const searchTimeoutRef = useRef(null);

  const getContactName = (c) =>
    c?.contactName || `${c?.firstName || ''} ${c?.lastName || ''}`.trim() || c?.email || c?.phone || 'Unknown';

  // Load an initial pool of 100 contacts on mount, then refresh via debounced search.
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
      .catch(() => { /* silent — dropdown stays empty, user can search */ })
      .finally(() => setContactsLoading(false));
  }, [location?.id]);

  // Debounced server-side search — Select's onSearch callback.
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
      } catch { /* silent */ }
      finally { setContactsLoading(false); }
    }, 400);
  };

  // Poll active job status
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
      } catch (err) {
        console.error('Failed to poll job status:', err);
      }
    }, 5000);
    return () => clearInterval(pollInterval);
  }, [activeJob?.jobId, activeJob?.status, location?.id]);

  const buildExportFilters = () => ({ contactIds: selectedContactIds });

  const handleGetEstimate = async () => {
    if (selectedContactIds.length === 0) {
      antMessage.warning('Please select at least one contact to export.');
      return;
    }
    setExportModalVisible(true);
    setEstimating(true);
    setEstimate(null);
    setEstimateError(null);
    try {
      const response = await billingAPI.getEstimate(location.id, 'callRecordings', buildExportFilters());
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
      const response = await billingAPI.chargeAndExport(location.id, 'callRecordings', format, filters, notificationEmail);
      if (response.success) {
        setActiveJob({
          jobId: response.data.jobId,
          status: response.data.status,
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
        exportType="callRecordings"
      />

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Call Recordings</h2>
          <p className="text-sm text-gray-500 mt-1">
            Export recording download links for calls made to the selected contacts.
          </p>
        </div>
      </div>

      {/* Active Export Progress */}
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

      {/* Action card */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
        <div className="mb-4">
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
            placeholder="Search and select one or more contacts..."
            options={contactOptions}
            style={{ width: '100%' }}
            maxTagCount="responsive"
            notFoundContent={contactsLoading ? 'Searching…' : 'No contacts found — try typing a name or email'}
          />
          <p className="text-xs text-gray-500 mt-2">
            {selectedContactIds.length > 0
              ? <><strong>{selectedContactIds.length}</strong> contact{selectedContactIds.length === 1 ? '' : 's'} selected.</>
              : 'Required: pick at least one contact.'}
          </p>
        </div>

        <Button
          type="primary"
          size="large"
          onClick={handleGetEstimate}
          loading={estimating}
          disabled={!location?.id || selectedContactIds.length === 0}
          className="bg-green-600 hover:bg-green-700 border-green-600"
        >
          Get Estimate & Export
        </Button>

        <div className="mt-4 p-3 bg-amber-50 border border-amber-200 rounded-lg">
          <p className="text-sm text-amber-800">
            <strong>Heavy task:</strong> we walk conversations for the selected contacts, find call &amp; voicemail
            messages, and confirm a recording exists for each one. The export is a CSV with a
            <strong> one-click download link</strong> per recording. Pricing: <strong>$0.05 per recording</strong> (no volume discount).
          </p>
        </div>
      </div>
    </div>
  );
}
