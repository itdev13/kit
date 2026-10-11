import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useAuth } from '../../context/AuthContext';
import { billingAPI } from '../../api/billing';
import { contactsAPI } from '../../api/contacts';
import { Button, Select, DatePicker, Input, message as antMessage } from 'antd';
import ExportEstimateModal from '../ExportEstimateModal';
import ExportProgress from '../ExportProgress';
import dayjs from 'dayjs';

const STATUS_COLORS = {
  open:      { bg: 'bg-blue-100',  text: 'text-blue-700'  },
  won:       { bg: 'bg-green-100', text: 'text-green-700' },
  lost:      { bg: 'bg-red-100',   text: 'text-red-700'   },
  abandoned: { bg: 'bg-gray-100',  text: 'text-gray-600'  },
};

export default function OpportunitiesTab() {
  const { location } = useAuth();

  // Export state
  const [exportModalVisible, setExportModalVisible] = useState(false);
  const [estimating, setEstimating] = useState(false);
  const [estimate, setEstimate] = useState(null);
  const [estimateError, setEstimateError] = useState(null);
  const [processing, setProcessing] = useState(false);
  const [activeJob, setActiveJob] = useState(null);

  // Pipelines
  const [pipelines, setPipelines] = useState([]);
  const [stages, setStages] = useState([]);
  const [loadingPipelines, setLoadingPipelines] = useState(false);

  // Users (for Assigned To filter)
  const [allUsers, setAllUsers] = useState([]);
  const [usersLoading, setUsersLoading] = useState(false);

  // Contacts (for Contact filter)
  const [contactOptions, setContactOptions] = useState([]);
  const [contactsLoading, setContactsLoading] = useState(false);
  const contactSearchTimer = useRef(null);

  // Filters
  const [pipelineId, setPipelineId] = useState('');
  const [pipelineStageId, setPipelineStageId] = useState('');
  const [status, setStatus] = useState('');
  const [query, setQuery] = useState('');
  const [assignedTo, setAssignedTo] = useState('');
  const [contactId, setContactId] = useState('');
  const [monetaryValueMin, setMonetaryValueMin] = useState('');
  const [monetaryValueMax, setMonetaryValueMax] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [sortBy, setSortBy] = useState('');

  // Preview results
  const [opportunities, setOpportunities] = useState([]);
  const [opportunitiesTotal, setOpportunitiesTotal] = useState(0);
  const [opportunitiesLoading, setOpportunitiesLoading] = useState(false);
  const [opportunitiesError, setOpportunitiesError] = useState(null);
  const [searched, setSearched] = useState(false);
  const [currentSearchAfter, setCurrentSearchAfter] = useState(null);
  const [searchAfterHistory, setSearchAfterHistory] = useState([]);
  const [nextSearchAfter, setNextSearchAfter] = useState(null);
  const OPP_LIMIT = 20;

  const getUserName = (u) => `${u?.firstName || ''} ${u?.lastName || ''}`.trim() || u?.name || u?.email || 'Unknown';

  const handleContactSearch = useCallback((searchText) => {
    if (contactSearchTimer.current) clearTimeout(contactSearchTimer.current);
    contactSearchTimer.current = setTimeout(async () => {
      if (!location?.id) return;
      setContactsLoading(true);
      try {
        const res = await contactsAPI.search(location.id, searchText || '', 100);
        if (res.success) {
          setContactOptions((res.data?.contacts || res.contacts || []).map(c => ({
            id: c.id,
            name: `${c.firstName || ''} ${c.lastName || ''}`.trim() || c.name || '',
            email: c.email || '',
            phone: c.phone || '',
          })));
        }
      } catch (err) {
        console.error('Contact search failed:', err);
      } finally {
        setContactsLoading(false);
      }
    }, 300);
  }, [location?.id]);

  // Lookup maps for pipeline/stage names
  const pipelineMap = Object.fromEntries(pipelines.map(p => [p.id, p.name]));
  const stageMap = Object.fromEntries(pipelines.flatMap(p => (p.stages || []).map(s => [s.id, s.name])));

  // Load pipelines + users on mount, initial search
  useEffect(() => {
    if (!location?.id) return;

    setLoadingPipelines(true);
    billingAPI.getPipelines(location.id)
      .then(res => { if (res.success) setPipelines(res.data.pipelines || []); })
      .catch(console.error)
      .finally(() => setLoadingPipelines(false));

    setUsersLoading(true);
    billingAPI.searchUsers(location.id, '')
      .then(res => { if (res.success) setAllUsers(res.data.users || []); })
      .catch(console.error)
      .finally(() => setUsersLoading(false));

    // Load initial contacts
    handleContactSearch('');

    handleSearch(null, []);
  }, [location?.id]);

  // Update stages when pipeline changes
  useEffect(() => {
    if (pipelineId) {
      const pipeline = pipelines.find(p => p.id === pipelineId);
      setStages(pipeline?.stages || []);
    } else {
      setStages([]);
    }
    setPipelineStageId('');
  }, [pipelineId, pipelines]);

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
    if (pipelineId) f.pipelineId = pipelineId;
    if (pipelineStageId) f.pipelineStageId = pipelineStageId;
    if (status) f.status = status;
    if (query) f.query = query;
    if (assignedTo) f.assignedTo = assignedTo;
    if (contactId) f.contactId = contactId;
    if (monetaryValueMin !== '') f.monetaryValueMin = parseFloat(monetaryValueMin);
    if (monetaryValueMax !== '') f.monetaryValueMax = parseFloat(monetaryValueMax);
    if (startDate) f.startDate = dayjs(startDate).startOf('day').valueOf();
    if (endDate) f.endDate = dayjs(endDate).endOf('day').valueOf();
    if (sortBy) {
      const lastUnderscore = sortBy.lastIndexOf('_');
      f.sortField = sortBy.substring(0, lastUnderscore);
      f.sortDirection = sortBy.substring(lastUnderscore + 1);
    }
    return f;
  };

  const handleSearch = async (searchAfter = null, history = null) => {
    setOpportunitiesLoading(true);
    setOpportunitiesError(null);
    setSearched(true);
    try {
      const res = await billingAPI.searchOpportunities(location.id, getFilters(), searchAfter, OPP_LIMIT);
      if (res.success) {
        setOpportunities(res.data.opportunities || []);
        setOpportunitiesTotal(res.data.total || 0);
        setCurrentSearchAfter(searchAfter);
        setNextSearchAfter(res.data.nextSearchAfter || null);
        if (history !== null) setSearchAfterHistory(history);
      } else {
        setOpportunitiesError(res.error || 'Failed to search opportunities');
        setOpportunities([]);
        setOpportunitiesTotal(0);
      }
    } catch (err) {
      setOpportunitiesError(err.message || 'Failed to search opportunities');
      setOpportunities([]);
      setOpportunitiesTotal(0);
    } finally {
      setOpportunitiesLoading(false);
    }
  };

  const handleNewSearch = () => {
    setSearchAfterHistory([]);
    setCurrentSearchAfter(null);
    setNextSearchAfter(null);
    handleSearch(null, []);
  };

  const handleNext = () => {
    const newHistory = [...searchAfterHistory, currentSearchAfter];
    handleSearch(nextSearchAfter, newHistory);
  };

  const handlePrev = () => {
    const newHistory = [...searchAfterHistory];
    const prevCursor = newHistory.pop();
    handleSearch(prevCursor, newHistory);
  };

  const handleGetEstimate = async () => {
    setExportModalVisible(true);
    setEstimating(true);
    setEstimate(null);
    setEstimateError(null);
    try {
      const res = await billingAPI.getEstimate(location.id, 'opportunities', getFilters());
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
      const res = await billingAPI.chargeAndExport(location.id, 'opportunities', format, getFilters(), notificationEmail);
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

  const formatCurrency = (val) =>
    val != null ? `$${Number(val).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}` : null;

  const formatDate = (val) => {
    if (!val) return null;
    try { return new Date(val).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }); }
    catch { return null; }
  };

  const isExporting = activeJob && ['pending', 'processing'].includes(activeJob.status);
  const hasPrev = searchAfterHistory.length > 0;
  const hasNext = !!nextSearchAfter && opportunities.length >= OPP_LIMIT;

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
        exportType="opportunities"
      />

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Opportunities</h2>
          <p className="text-sm text-gray-500 mt-1">
            {searched && opportunitiesTotal > 0
              ? `${opportunitiesTotal.toLocaleString()} opportunit${opportunitiesTotal !== 1 ? 'ies' : 'y'} found`
              : 'Search and export opportunities from this sub-account'}
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
          Export Opportunities
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
          Filter Opportunities
        </h3>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {/* Pipeline */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Pipeline</label>
            <Select
              value={pipelineId || undefined}
              onChange={(val) => setPipelineId(val || '')}
              placeholder="All Pipelines"
              loading={loadingPipelines}
              allowClear
              style={{ width: '100%' }}
              size="large"
            >
              {pipelines.map(p => (
                <Select.Option key={p.id} value={p.id}>{p.name}</Select.Option>
              ))}
            </Select>
          </div>

          {/* Stage */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Stage</label>
            <Select
              value={pipelineStageId || undefined}
              onChange={(val) => setPipelineStageId(val || '')}
              placeholder="All Stages"
              allowClear
              disabled={!pipelineId}
              style={{ width: '100%' }}
              size="large"
            >
              {stages.map(s => (
                <Select.Option key={s.id} value={s.id}>{s.name}</Select.Option>
              ))}
            </Select>
          </div>

          {/* Status */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Status</label>
            <Select
              value={status || undefined}
              onChange={(val) => setStatus(val || '')}
              placeholder="All Statuses"
              allowClear
              style={{ width: '100%' }}
              size="large"
            >
              <Select.Option value="open">Open</Select.Option>
              <Select.Option value="won">Won</Select.Option>
              <Select.Option value="lost">Lost</Select.Option>
              <Select.Option value="abandoned">Abandoned</Select.Option>
            </Select>
          </div>

          {/* Search Query */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Search</label>
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search opportunities..."
              size="large"
              onPressEnter={handleNewSearch}
            />
          </div>

          {/* Assigned To */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Assigned To</label>
            <Select
              showSearch
              value={assignedTo || undefined}
              onChange={(val) => setAssignedTo(val || '')}
              placeholder="All Users"
              allowClear
              loading={usersLoading}
              filterOption={(input, option) =>
                (option?.children ?? '').toLowerCase().includes(input.toLowerCase())
              }
              style={{ width: '100%' }}
              size="large"
            >
              {allUsers.map(u => (
                <Select.Option key={u.id} value={u.id}>{getUserName(u)}</Select.Option>
              ))}
            </Select>
          </div>

          {/* Assigned To ID (text) */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Assigned To ID</label>
            <Input
              value={assignedTo}
              onChange={(e) => setAssignedTo(e.target.value)}
              placeholder="Paste user ID..."
              size="large"
            />
          </div>

          {/* Contact */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Contact</label>
            <Select
              showSearch
              value={contactId || undefined}
              onChange={(val) => setContactId(val || '')}
              onSearch={handleContactSearch}
              placeholder="Search contacts..."
              allowClear
              loading={contactsLoading}
              filterOption={false}
              notFoundContent={contactsLoading ? 'Searching...' : 'No contacts found'}
              style={{ width: '100%' }}
              size="large"
            >
              {contactOptions.map(c => (
                <Select.Option key={c.id} value={c.id}>
                  <div className="flex flex-col leading-tight">
                    <span className="text-sm">{c.name || '(No name)'}</span>
                    {(c.email || c.phone) && (
                      <span className="text-xs text-gray-400">{c.email || c.phone}</span>
                    )}
                  </div>
                </Select.Option>
              ))}
            </Select>
          </div>

          {/* Contact ID (text) */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Contact ID</label>
            <Input
              value={contactId}
              onChange={(e) => setContactId(e.target.value)}
              placeholder="Paste contact ID..."
              size="large"
            />
          </div>

          {/* Monetary Value Min */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Value Min ($)</label>
            <Input
              value={monetaryValueMin}
              onChange={(e) => setMonetaryValueMin(e.target.value)}
              placeholder="Min value"
              size="large"
              type="number"
              min="0"
              onPressEnter={handleNewSearch}
            />
          </div>

          {/* Monetary Value Max */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Value Max ($)</label>
            <Input
              value={monetaryValueMax}
              onChange={(e) => setMonetaryValueMax(e.target.value)}
              placeholder="Max value"
              size="large"
              type="number"
              min="0"
              onPressEnter={handleNewSearch}
            />
          </div>

          {/* Date Added From */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Date Added From</label>
            <DatePicker
              value={startDate ? dayjs(startDate) : null}
              onChange={(date) => setStartDate(date ? date.format('YYYY-MM-DD') : '')}
              style={{ width: '100%' }}
              size="large"
              placeholder="From"
            />
          </div>

          {/* Date Added To */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Date Added To</label>
            <DatePicker
              value={endDate ? dayjs(endDate) : null}
              onChange={(date) => setEndDate(date ? date.format('YYYY-MM-DD') : '')}
              style={{ width: '100%' }}
              size="large"
              placeholder="To"
            />
          </div>

          {/* Sort By */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Sort By</label>
            <Select
              value={sortBy || undefined}
              onChange={(val) => setSortBy(val || '')}
              placeholder="Default"
              allowClear
              style={{ width: '100%' }}
              size="large"
            >
              <Select.Option value="date_added_desc">Date Added (Newest)</Select.Option>
              <Select.Option value="date_added_asc">Date Added (Oldest)</Select.Option>
              <Select.Option value="date_updated_desc">Date Updated (Newest)</Select.Option>
              <Select.Option value="date_updated_asc">Date Updated (Oldest)</Select.Option>
              <Select.Option value="monetary_value_desc">Value (Highest)</Select.Option>
              <Select.Option value="monetary_value_asc">Value (Lowest)</Select.Option>
              <Select.Option value="name_asc">Name (A–Z)</Select.Option>
              <Select.Option value="name_desc">Name (Z–A)</Select.Option>
              <Select.Option value="last_status_change_date_desc">Status Changed (Newest)</Select.Option>
              <Select.Option value="last_stage_change_date_desc">Stage Changed (Newest)</Select.Option>
            </Select>
          </div>

          {/* Search Button */}
          <div className="flex items-end">
            <Button
              onClick={handleNewSearch}
              loading={opportunitiesLoading}
              size="large"
              type="primary"
              className="px-8"
              icon={!opportunitiesLoading && (
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
      {opportunitiesLoading && (
        <div className="text-center py-14">
          <div className="animate-spin rounded-full h-10 w-10 border-4 border-blue-600 border-t-transparent mx-auto mb-3"></div>
          <p className="text-gray-500 text-sm">Searching opportunities...</p>
        </div>
      )}

      {/* Error */}
      {opportunitiesError && !opportunitiesLoading && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-5 flex items-start gap-3">
          <svg className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <div>
            <p className="font-medium text-red-800 text-sm">Error loading opportunities</p>
            <p className="text-red-600 text-xs mt-1">{opportunitiesError}</p>
          </div>
        </div>
      )}

      {/* No results */}
      {searched && !opportunitiesLoading && !opportunitiesError && opportunities.length === 0 && (
        <div className="text-center py-16 bg-gradient-to-br from-yellow-50 to-orange-50 rounded-xl border-2 border-dashed border-yellow-300">
          <div className="text-4xl mb-3">🔍</div>
          <h3 className="text-base font-semibold text-gray-900 mb-1">No Opportunities Found</h3>
          <p className="text-gray-500 text-sm mb-4">Try adjusting your filters and search again</p>
        </div>
      )}

      {/* Results */}
      {!opportunitiesLoading && !opportunitiesError && opportunities.length > 0 && (
        <>
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 bg-blue-50 border border-blue-200 rounded-xl p-4">
            <div className="flex items-start gap-2">
              <svg className="w-5 h-5 text-blue-600 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <p className="text-sm text-blue-800">
                <strong>Sample preview</strong> of {opportunities.length.toLocaleString()} of{' '}
                <strong>{opportunitiesTotal.toLocaleString()}</strong> opportunities. Export to download the full data.
              </p>
            </div>
            <Button type="primary" size="large" onClick={handleGetEstimate} className="flex-shrink-0">
              Export Full Data
            </Button>
          </div>

          <div className="space-y-2">
            {opportunities.map((opp) => {
              const statusColor = STATUS_COLORS[opp.status] || STATUS_COLORS.open;
              const pipelineName = pipelineMap[opp.pipelineId] || null;
              const stageName = stageMap[opp.pipelineStageId] || null;
              const assignedUser = allUsers.find(u => u.id === opp.assignedTo);
              const contact = opp.contact || {};
              const contactDisplay = contact.name || contact.email || contact.phone || null;
              const contactSub = contact.name && (contact.email || contact.phone) ? (contact.email || contact.phone) : null;

              return (
                <div key={opp.id} className="bg-white border border-gray-200 rounded-lg p-4 hover:border-blue-300 hover:shadow-sm transition-all">
                  <div className="flex items-start gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap mb-1.5">
                        <p className="font-semibold text-sm text-gray-900 truncate">{opp.name || '(No name)'}</p>
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium flex-shrink-0 ${statusColor.bg} ${statusColor.text}`}>
                          {opp.status || 'open'}
                        </span>
                        {opp.monetaryValue != null && (
                          <span className="text-xs font-semibold text-green-700 bg-green-50 border border-green-200 px-2 py-0.5 rounded-full flex-shrink-0">
                            {formatCurrency(opp.monetaryValue)}
                          </span>
                        )}
                      </div>

                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-500">
                        {contactDisplay && (
                          <span className="flex items-center gap-1">
                            <svg className="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                            </svg>
                            <span>{contactDisplay}</span>
                            {contactSub && <span className="text-gray-400">{contactSub}</span>}
                          </span>
                        )}
                        {pipelineName && (
                          <span className="flex items-center gap-1">
                            <svg className="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7" />
                            </svg>
                            <span>{pipelineName}{stageName ? ` · ${stageName}` : ''}</span>
                          </span>
                        )}
                        {(assignedUser || opp.assignedTo) && (
                          <span className="flex items-center gap-1">
                            <svg className="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
                            </svg>
                            <span>{assignedUser ? getUserName(assignedUser) : opp.assignedTo}</span>
                          </span>
                        )}
                        {opp.createdAt && <span>Added {formatDate(opp.createdAt)}</span>}
                        {opp.source && <span className="text-gray-400">via {opp.source}</span>}
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
          {['OpportunityID', 'Name', 'MonetaryValue', 'PipelineId', 'PipelineName', 'PipelineStageId', 'StageName', 'Status', 'Source', 'ContactId', 'ContactName', 'ContactEmail', 'ContactPhone', 'CompanyName', 'AssignedTo', 'LostReasonId', 'Followers', 'LastActionDate', 'CreatedAt', 'UpdatedAt', 'LastStatusChangeAt', 'LastStageChangeAt'].map((col) => (
            <span key={col} className="px-3 py-1 bg-gray-100 text-gray-700 text-xs font-mono rounded-full">{col}</span>
          ))}
        </div>
      </div>
    </div>
  );
}
