import React, { useState, useEffect } from 'react';
import { useAuth } from '../../context/AuthContext';
import { billingAPI } from '../../api/billing';
import { Button, Select, DatePicker, Input, message as antMessage } from 'antd';
import ExportEstimateModal from '../ExportEstimateModal';
import ExportProgress from '../ExportProgress';
import dayjs from 'dayjs';

const SUB_LIMIT = 25;

export default function FormSubmissionsTab() {
  const { location } = useAuth();

  // Export state
  const [exportModalVisible, setExportModalVisible] = useState(false);
  const [estimating, setEstimating] = useState(false);
  const [estimate, setEstimate] = useState(null);
  const [estimateError, setEstimateError] = useState(null);
  const [processing, setProcessing] = useState(false);
  const [activeJob, setActiveJob] = useState(null);

  // Forms list
  const [forms, setForms] = useState([]);
  const [loadingForms, setLoadingForms] = useState(false);

  // Filters
  const [formId, setFormId] = useState('');
  const [query, setQuery] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  // Preview results
  const [submissions, setSubmissions] = useState([]);
  const [submissionsTotal, setSubmissionsTotal] = useState(0);
  const [submissionsLoading, setSubmissionsLoading] = useState(false);
  const [submissionsError, setSubmissionsError] = useState(null);
  const [searched, setSearched] = useState(false);
  const [page, setPage] = useState(1);

  // Build form name lookup
  const formMap = Object.fromEntries(forms.map(f => [f.id, f.name]));

  // Load forms + initial search on mount
  useEffect(() => {
    if (!location?.id) return;

    setLoadingForms(true);
    billingAPI.getForms(location.id)
      .then(res => { if (res.success) setForms(res.data.forms || []); })
      .catch(console.error)
      .finally(() => setLoadingForms(false));

    handleSearch(1);
  }, [location?.id]);

  // Poll active job
  useEffect(() => {
    if (!activeJob || !['pending', 'processing'].includes(activeJob.status)) return;
    const interval = setInterval(async () => {
      try {
        const res = await billingAPI.getExportStatus(activeJob.jobId, location?.id);
        if (res.success) {
          setActiveJob(res.data);
          if (res.data.status === 'completed') antMessage.success('Export completed! Click Download to get your file.');
        }
      } catch { /* silent */ }
    }, 5000);
    return () => clearInterval(interval);
  }, [activeJob?.jobId, activeJob?.status, location?.id]);

  const getFilters = () => {
    const f = {};
    if (formId) f.formId = formId;
    if (query) f.query = query;
    if (startDate) f.startDate = dayjs(startDate).format('YYYY-MM-DD');
    if (endDate) f.endDate = dayjs(endDate).format('YYYY-MM-DD');
    return f;
  };

  const handleSearch = async (targetPage = 1) => {
    setSubmissionsLoading(true);
    setSubmissionsError(null);
    setSearched(true);
    setPage(targetPage);
    try {
      const res = await billingAPI.searchFormSubmissions(location.id, getFilters(), targetPage, SUB_LIMIT);
      if (res.success) {
        setSubmissions(res.data.submissions || []);
        setSubmissionsTotal(res.data.total || 0);
      } else {
        setSubmissionsError(res.error || 'Failed to load submissions');
        setSubmissions([]);
        setSubmissionsTotal(0);
      }
    } catch (err) {
      setSubmissionsError(err.message || 'Failed to load submissions');
      setSubmissions([]);
      setSubmissionsTotal(0);
    } finally {
      setSubmissionsLoading(false);
    }
  };

  const handleNewSearch = () => handleSearch(1);

  const handleGetEstimate = async () => {
    setExportModalVisible(true);
    setEstimating(true);
    setEstimate(null);
    setEstimateError(null);
    try {
      const res = await billingAPI.getEstimate(location.id, 'formSubmissions', getFilters());
      if (res.success) setEstimate(res.data.estimate);
      else setEstimateError(res.error || 'Failed to calculate estimate');
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
      const res = await billingAPI.chargeAndExport(location.id, 'formSubmissions', format, getFilters(), notificationEmail);
      if (res.success) {
        setActiveJob({ jobId: res.data.jobId, status: res.data.status, totalItems: res.data.totalItems, progress: { total: res.data.totalItems, processed: 0, percent: 0 } });
        setExportModalVisible(false);
        setEstimate(null);
        antMessage.success("Export started! We'll notify you by email when it's ready.");
      } else {
        setEstimateError(res.error || 'Export failed');
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

  const formatDate = (val) => {
    if (!val) return null;
    try { return new Date(val).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
    catch { return null; }
  };

  const isExporting = activeJob && ['pending', 'processing'].includes(activeJob.status);
  const totalPages = Math.ceil(submissionsTotal / SUB_LIMIT);
  const hasPrev = page > 1;
  const hasNext = page < totalPages;

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
        exportType="formSubmissions"
      />

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Form Submissions</h2>
          <p className="text-sm text-gray-500 mt-1">
            {searched && submissionsTotal > 0
              ? `${submissionsTotal.toLocaleString()} submission${submissionsTotal !== 1 ? 's' : ''} found`
              : 'Search and export form submissions from this sub-account'}
          </p>
        </div>
        <Button
          onClick={handleGetEstimate}
          disabled={isExporting}
          size="large"
          type="primary"
          className="bg-green-600 hover:bg-green-700 border-green-600"
          icon={
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
          }
        >
          Export Submissions
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
      <div className="bg-white border border-gray-200 rounded-xl p-5 shadow-sm">
        <h3 className="text-sm font-semibold text-gray-700 mb-4 flex items-center gap-2">
          <svg className="w-4 h-4 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
          </svg>
          Filter Submissions
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {/* Form */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Form</label>
            <Select
              value={formId || undefined}
              onChange={(val) => setFormId(val || '')}
              placeholder="All Forms"
              allowClear
              loading={loadingForms}
              style={{ width: '100%' }}
              size="large"
            >
              {forms.map(f => (
                <Select.Option key={f.id} value={f.id}>{f.name}</Select.Option>
              ))}
            </Select>
          </div>

          {/* Search */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Search</label>
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by contact, email..."
              size="large"
              onPressEnter={handleNewSearch}
            />
          </div>

          {/* Start Date */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Start Date</label>
            <DatePicker
              value={startDate ? dayjs(startDate) : null}
              onChange={(date) => setStartDate(date ? date.format('YYYY-MM-DD') : '')}
              style={{ width: '100%' }}
              size="large"
              placeholder="From"
            />
          </div>

          {/* End Date */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">End Date</label>
            <DatePicker
              value={endDate ? dayjs(endDate) : null}
              onChange={(date) => setEndDate(date ? date.format('YYYY-MM-DD') : '')}
              style={{ width: '100%' }}
              size="large"
              placeholder="To"
            />
          </div>

          {/* Search Button */}
          <div className="flex items-end">
            <Button
              onClick={handleNewSearch}
              loading={submissionsLoading}
              size="large"
              type="primary"
              className="px-8"
              icon={!submissionsLoading && (
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
              )}
            >
              Search
            </Button>
          </div>
        </div>
      </div>

      {/* Loading */}
      {submissionsLoading && (
        <div className="text-center py-14">
          <div className="animate-spin rounded-full h-10 w-10 border-4 border-blue-600 border-t-transparent mx-auto mb-3"></div>
          <p className="text-gray-500 text-sm">Loading submissions...</p>
        </div>
      )}

      {/* Error */}
      {submissionsError && !submissionsLoading && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-5 flex items-start gap-3">
          <svg className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <div>
            <p className="font-medium text-red-800 text-sm">Error loading submissions</p>
            <p className="text-red-600 text-xs mt-1">{submissionsError}</p>
          </div>
        </div>
      )}

      {/* No results */}
      {searched && !submissionsLoading && !submissionsError && submissions.length === 0 && (
        <div className="text-center py-16 bg-gradient-to-br from-yellow-50 to-orange-50 rounded-xl border-2 border-dashed border-yellow-300">
          <div className="text-4xl mb-3">📋</div>
          <h3 className="text-base font-semibold text-gray-900 mb-1">No Submissions Found</h3>
          <p className="text-gray-500 text-sm mb-4">Try adjusting your filters and search again</p>
        </div>
      )}

      {/* Results */}
      {!submissionsLoading && !submissionsError && submissions.length > 0 && (
        <>
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 bg-blue-50 border border-blue-200 rounded-xl p-4">
            <div className="flex items-start gap-2">
              <svg className="w-5 h-5 text-blue-600 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <p className="text-sm text-blue-800">
                <strong>Sample preview</strong> of {submissions.length.toLocaleString()} of{' '}
                <strong>{submissionsTotal.toLocaleString()}</strong> submissions. Export to download the full data.
              </p>
            </div>
            <Button type="primary" size="large" onClick={handleGetEstimate} className="flex-shrink-0">
              Export Full Data
            </Button>
          </div>

          <div className="space-y-2">
            {submissions.map((sub, i) => {
              const formName = formMap[sub.formId] || null;
              const displayName = sub.name || sub.contactName || null;
              const others = sub.others || {};
              const otherFields = Object.entries(others).filter(([, v]) => v).slice(0, 3);

              return (
                <div key={sub.id || i} className="bg-white border border-gray-200 rounded-lg p-4 hover:border-blue-300 hover:shadow-sm transition-all">
                  <div className="flex items-start gap-3">
                    <div className="w-8 h-8 bg-teal-50 border border-teal-100 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5">
                      <svg className="w-4 h-4 text-teal-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                      </svg>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap mb-1">
                        {displayName && <p className="font-medium text-sm text-gray-900">{displayName}</p>}
                        {formName && (
                          <span className="text-xs px-2 py-0.5 rounded-full bg-teal-50 text-teal-700 border border-teal-200 font-medium flex-shrink-0">
                            {formName}
                          </span>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-500">
                        {sub.email && (
                          <span className="flex items-center gap-1">
                            <svg className="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                            </svg>
                            {sub.email}
                          </span>
                        )}
                        {otherFields.map(([k, v]) => (
                          <span key={k} className="text-gray-400">{k}: {String(v)}</span>
                        ))}
                        {sub.createdAt && <span className="ml-auto">{formatDate(sub.createdAt)}</span>}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {hasNext && (
            <div className="flex justify-center pt-2">
              <Button type="primary" onClick={handleGetEstimate}>Export Full Data</Button>
            </div>
          )}
        </>
      )}

      {/* Export Columns */}
      <div className="bg-white border border-gray-200 rounded-xl p-5">
        <h3 className="text-sm font-semibold text-gray-700 mb-3">Export Columns</h3>
        <div className="flex flex-wrap gap-2">
          {['SubmissionID', 'FormID', 'FormName', 'ContactID', 'Name', 'Email', 'CreatedAt', 'OtherFields'].map((col) => (
            <span key={col} className="px-3 py-1 bg-gray-100 text-gray-700 text-xs font-mono rounded-full">{col}</span>
          ))}
        </div>
      </div>
    </div>
  );
}
