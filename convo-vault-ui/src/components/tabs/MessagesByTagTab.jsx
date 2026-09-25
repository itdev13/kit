import React, { useState, useEffect } from 'react';
import { useAuth } from '../../context/AuthContext';
import { billingAPI } from '../../api/billing';
import { tagsAPI } from '../../api/customFields';
import { Button, Select, message as antMessage } from 'antd';
import ExportEstimateModal from '../ExportEstimateModal';
import ExportProgress from '../ExportProgress';

/**
 * Messages by Contact Tag — the user selects one or more tags; we resolve every contact carrying
 * those tags, CAP at the first 100 contacts, then gather all of their messages (optionally filtered
 * by channel + date range) via the same message export API the Messages tab uses, once per
 * contact, and export. Flat $0.05/message rate.
 */
export default function MessagesByTagTab() {
  const { location } = useAuth();

  const [exportModalVisible, setExportModalVisible] = useState(false);
  const [estimating, setEstimating] = useState(false);
  const [estimate, setEstimate] = useState(null);
  const [estimateError, setEstimateError] = useState(null);
  const [specialExportId, setSpecialExportId] = useState(null);
  const [processing, setProcessing] = useState(false);
  const [activeJob, setActiveJob] = useState(null);

  // Resolution results returned by the estimate endpoint.
  const [resolvedContactCount, setResolvedContactCount] = useState(null);
  const [cappedAt500, setCappedAt500] = useState(false);

  // Tag multi-select — at least one required.
  const [tags, setTags] = useState([]);
  const [tagsLoading, setTagsLoading] = useState(false);
  const [selectedTags, setSelectedTags] = useState([]);

  // Filters
  const [channel, setChannel] = useState('');

  // Load tags on mount.
  useEffect(() => {
    if (!location?.id) return;
    setTagsLoading(true);
    tagsAPI.list(location.id)
      .then(res => {
        if (res.success) setTags(res.data?.tags || []);
      })
      .catch(() => {})
      .finally(() => setTagsLoading(false));
  }, [location?.id]);

  const tagOptions = tags.map(t => ({ value: t.name, label: t.name }));

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

  const buildExportFilters = () => ({
    tags: selectedTags,
    channel: channel || undefined
  });

  const handleGetEstimate = async () => {
    if (selectedTags.length === 0) {
      antMessage.warning('Please select at least one tag to export.');
      return;
    }
    setExportModalVisible(true);
    setEstimating(true);
    setEstimate(null);
    setEstimateError(null);
    setResolvedContactCount(null);
    setCappedAt500(false);
    try {
      const response = await billingAPI.getEstimate(location.id, 'messagesByTag', buildExportFilters());
      if (response.success) {
        setEstimate(response.data.estimate);
        setSpecialExportId(response.data.specialExportId || null);
        setResolvedContactCount(response.data.resolvedContactCount ?? null);
        setCappedAt500(!!response.data.cappedAt500);
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
      const response = await billingAPI.chargeAndExport(location.id, 'messagesByTag', format, filters, notificationEmail);
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
        exportType="messagesByTag"
      />

      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Messages by Tag</h2>
          <p className="text-sm text-gray-500 mt-1">
            Pick one or more tags — we gather every message for the matching contacts and export them as one CSV.
          </p>
        </div>
      </div>

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
        {/* Tags multi-select */}
        <div className="mb-4">
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Tags <span className="text-red-500">*</span>
          </label>
          <Select
            mode="multiple"
            allowClear
            showSearch
            value={selectedTags}
            onChange={setSelectedTags}
            optionFilterProp="label"
            loading={tagsLoading}
            placeholder="Select one or more tags..."
            options={tagOptions}
            style={{ width: '100%' }}
            maxTagCount="responsive"
            notFoundContent={tagsLoading ? 'Loading tags…' : 'No tags found for this sub-account'}
          />
          <p className="text-xs text-gray-500 mt-2">
            {selectedTags.length > 0
              ? <><strong>{selectedTags.length}</strong> tag{selectedTags.length === 1 ? '' : 's'} selected.</>
              : 'Required: pick at least one tag.'}
          </p>
        </div>

        {/* Channel filter */}
        <div className="mb-4">
          <label className="block text-sm font-medium text-gray-700 mb-2">Channel</label>
          <Select
            value={channel}
            onChange={setChannel}
            className="w-full"
            size="large"
            placeholder="All Channels"
            options={[
              { value: '', label: 'All Channels Except Email' },
              { value: 'SMS', label: 'SMS' },
              { value: 'Email', label: 'Email' },
              { value: 'WhatsApp', label: 'WhatsApp' },
              { value: 'Facebook', label: 'Facebook' },
              { value: 'Instagram', label: 'Instagram' },
              { value: 'LiveChat', label: 'Live Chat (Conversation AI)' },
              { value: 'WebChat', label: 'Web Chat' },
            ]}
          />
        </div>

        {/* Resolved contact count + explicit cap notice (shown after an estimate) */}
        {resolvedContactCount != null && (
          <div className={`mb-4 p-3 rounded-lg border ${cappedAt500 ? 'bg-amber-50 border-amber-200' : 'bg-blue-50 border-blue-200'}`}>
            <p className={`text-sm ${cappedAt500 ? 'text-amber-800' : 'text-blue-800'}`}>
              <strong>{resolvedContactCount.toLocaleString()}</strong> contact{resolvedContactCount === 1 ? '' : 's'} matched the selected tag{selectedTags.length === 1 ? '' : 's'}.
              {cappedAt500 && (
                <> <strong>Only the first 200 contacts are included</strong> in this export.</>
              )}
            </p>
          </div>
        )}

        <Button
          type="primary"
          size="large"
          onClick={handleGetEstimate}
          loading={estimating}
          disabled={!location?.id || selectedTags.length === 0}
          className="bg-green-600 hover:bg-green-700 border-green-600"
        >
          Get Estimate & Export
        </Button>

        <div className="mt-4 p-3 bg-amber-50 border border-amber-200 rounded-lg">
          <p className="text-sm text-amber-800">
            <strong>How it works:</strong> we resolve every contact carrying the selected tag(s), then gather their
            messages (filtered by channel when set). Choose <strong>Live Chat</strong> or <strong>Web Chat</strong>
            to export those conversation threads. <strong>Only the first 200 contacts</strong> are included.
            Pricing: <strong>$0.05 / message</strong> — no volume discount.
          </p>
        </div>
      </div>
    </div>
  );
}
