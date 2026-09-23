import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../../context/AuthContext';
import { exportAPI } from '../../api/export';
import { billingAPI } from '../../api/billing';
import { contactsAPI } from '../../api/contacts';
import { usersAPI } from '../../api/users';
import { Button, Select, DatePicker, Input, Tooltip, message as antMessage } from 'antd';
import { useErrorModal } from '../ErrorModal';
import { useInfoModal } from '../InfoModal';
import ExportEstimateModal from '../ExportEstimateModal';
import ExportProgress from '../ExportProgress';
import { getMessageTypeDisplay, getMessageTypeIcon } from '../../utils/messageTypes';
import { copyToClipboard } from '../../utils/clipboard';
import dayjs from 'dayjs';

// Default date range: 2 years
const getDefaultDates = () => ({
  startDate: dayjs().subtract(2, 'year').format('YYYY-MM-DD'),
  endDate: dayjs().format('YYYY-MM-DD')
});

export default function MessagesTab() {
  const { location } = useAuth();
  const defaultDates = getDefaultDates();
  const [filters, setFilters] = useState({
    channel: '',
    startDate: defaultDates.startDate,
    endDate: defaultDates.endDate,
    contactId: '',
    conversationId: '',
    userId: '',
    limit: 50
  });
  const [cursor, setCursor] = useState(null);
  const [appliedFilters, setAppliedFilters] = useState({
    channel: '',
    startDate: defaultDates.startDate,
    endDate: defaultDates.endDate,
    contactId: '',
    conversationId: '',
    userId: '',
    limit: 50
  }); // Filters actually used for API
  const [shouldFetch, setShouldFetch] = useState(true); // Trigger for initial load
  const [searchTimestamp, setSearchTimestamp] = useState(Date.now()); // Force refetch even with same filters
  const [exportModalVisible, setExportModalVisible] = useState(false);
  const [estimating, setEstimating] = useState(false);
  const [estimate, setEstimate] = useState(null);
  const [estimateError, setEstimateError] = useState(null);
  const [processing, setProcessing] = useState(false);
  const [activeJob, setActiveJob] = useState(null);
  // Contacts (for Contact filter)
  const [contactOptions, setContactOptions] = useState([]);
  const [contactsLoading, setContactsLoading] = useState(false);
  const contactSearchTimer = useRef(null);

  // Users (for User filter)
  const [userOptions, setUserOptions] = useState([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const userSearchTimer = useRef(null);

  const handleUserSearch = useCallback((searchText) => {
    if (userSearchTimer.current) clearTimeout(userSearchTimer.current);
    userSearchTimer.current = setTimeout(async () => {
      if (!location?.id) return;
      setUsersLoading(true);
      try {
        const res = await usersAPI.search(location.id, searchText || '');
        if (res.success) {
          const list = res.data?.users || [];
          setUserOptions(list.map(u => ({
            id: u.id,
            name: u.name || `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.email || '(No name)',
            email: u.email || '',
          })));
        }
      } catch (err) {
        console.error('User search failed:', err);
      } finally {
        setUsersLoading(false);
      }
    }, 300);
  }, [location?.id]);

  // Load users on mount
  useEffect(() => {
    if (location?.id) handleUserSearch('');
  }, [location?.id]);

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

  // Load contacts on mount
  useEffect(() => {
    if (location?.id) handleContactSearch('');
  }, [location?.id]);


  const { showError, ErrorModalComponent } = useErrorModal();
  const { showInfo, InfoModalComponent } = useInfoModal();

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['all-messages', location?.id, appliedFilters, cursor, shouldFetch, searchTimestamp],
    queryFn: async () => {
      const response = await exportAPI.exportMessages(location.id, {
        channel: appliedFilters.channel || undefined,
        startDate: appliedFilters.startDate || undefined,
        endDate: appliedFilters.endDate || undefined,
        contactId: appliedFilters.contactId || undefined,
        conversationId: appliedFilters.conversationId || undefined,
        userIds: appliedFilters.userId ? [appliedFilters.userId] : undefined,
        limit: appliedFilters.limit,
        cursor: cursor || undefined
      });
      
      // Check if response has no messages
      if (!response.data?.messages || response.data.messages.length === 0) {
        throw new Error('NO_RESULTS_FOUND');
      }
      
      return response;
    },
    enabled: !!location?.id && shouldFetch, // Load on tab open or when search is clicked
    cacheTime: 0, // Don't cache - always fetch fresh
    staleTime: 0, // Data is immediately stale
    refetchOnMount: 'always', // Always refetch on mount
    refetchOnWindowFocus: false, // Don't refetch on window focus
    retry: false, // Don't retry on error
    onError: (error) => {
      // Transform 400 errors to friendly message
      if (error.message?.includes('Failed to export') || 
          error.message?.includes('400') || 
          error.message?.includes('Bad Request') ||
          error.message?.includes('Internal server error')) {
        // This is likely an invalid filter, not a real error
        return;
      }
    }
  });

  // When appliedFilters changes, enable fetch
  useEffect(() => {
    if (JSON.stringify(appliedFilters) !== JSON.stringify(filters)) {
      setShouldFetch(true);
    }
  }, [appliedFilters]);

  const messages = data?.data?.messages || [];
  const totalMessages = data?.data?.total || messages.length;
  const loadedMessages = data?.data?.loaded || messages.length;
  const hasMore = data?.data?.pagination?.hasMore || false;
  const nextCursorValue = data?.data?.pagination?.nextCursor;

  // Helper to safely format dates
  const formatDate = (dateValue) => {
    if (!dateValue) return '';
    try {
      const date = new Date(dateValue);
      if (isNaN(date.getTime())) return '';
      return date.toLocaleString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true
      });
    } catch (e) {
      return '';
    }
  };

  // Check if this is a "no results" situation
  const isNoResults = error && (
    error.message === 'NO_RESULTS_FOUND' ||
    error.message?.includes('Failed to export') ||
    error.message?.includes('400') ||
    error.message?.includes('Internal server error')
  );

  // Poll active job status
  useEffect(() => {
    if (!activeJob || !['pending', 'processing'].includes(activeJob.status)) return;

    const pollInterval = setInterval(async () => {
      try {
        const response = await billingAPI.getExportStatus(activeJob.jobId, location?.id);
        if (response.success) {
          setActiveJob(response.data);
          // Stop polling if completed or failed
          if (['completed', 'failed'].includes(response.data.status)) {
            if (response.data.status === 'completed') {
              antMessage.success('Export completed! Click Download to get your file.');
            }
          }
        }
      } catch (err) {
        console.error('Failed to poll job status:', err);
      }
    }, 5000);

    return () => clearInterval(pollInterval);
  }, [activeJob?.jobId, activeJob?.status, location?.id]);

  // Track if using default dates for export
  const [usingDefaultDates, setUsingDefaultDates] = useState(false);

  // Handle get estimate - opens modal and fetches estimate
  const handleGetEstimate = async () => {
    setExportModalVisible(true);
    setEstimating(true);
    setEstimate(null);
    setEstimateError(null);

    // Check if user selected dates - if not, use last 31 days
    const hasUserDates = filters.startDate || filters.endDate;
    setUsingDefaultDates(!hasUserDates);

    // Calculate default dates (last 2 years) if user didn't select any
    const defaultEndDate = dayjs().endOf('day');
    const defaultStartDate = dayjs().subtract(2, 'year').startOf('day');

    try {
      // Build filters for estimate - use current filter state or defaults
      const exportFilters = {
        channel: filters.channel || undefined,
        startDate: filters.startDate
          ? dayjs(filters.startDate).startOf('day').valueOf()
          : defaultStartDate.valueOf(),
        endDate: filters.endDate
          ? dayjs(filters.endDate).endOf('day').valueOf()
          : defaultEndDate.valueOf(),
        contactId: filters.contactId || undefined,
        conversationId: filters.conversationId || undefined,
        userIds: filters.userId ? [filters.userId] : undefined
      };

      const response = await billingAPI.getEstimate(location.id, 'messages', exportFilters);
      if (response.success) {
        setEstimate(response.data.estimate);
      } else {
        setEstimateError(response.error || 'Failed to calculate estimate');
      }
    } catch (err) {
      setEstimateError(err.message || 'Failed to calculate estimate');
    } finally {
      setEstimating(false);
    }
  };

  // Handle pay and export
  const handlePayAndExport = async (notificationEmail, format = 'csv') => {
    setProcessing(true);
    setEstimateError(null);

    // Calculate default dates (last 2 years) if user didn't select any
    const defaultEndDate = dayjs().endOf('day');
    const defaultStartDate = dayjs().subtract(2, 'year').startOf('day');

    try {
      const exportFilters = {
        channel: filters.channel || undefined,
        startDate: filters.startDate
          ? dayjs(filters.startDate).startOf('day').valueOf()
          : defaultStartDate.valueOf(),
        endDate: filters.endDate
          ? dayjs(filters.endDate).endOf('day').valueOf()
          : defaultEndDate.valueOf(),
        contactId: filters.contactId || undefined,
        conversationId: filters.conversationId || undefined,
        userIds: filters.userId ? [filters.userId] : undefined,
        estimatedTotal: estimate?.itemCounts?.total || undefined
      };

      const response = await billingAPI.chargeAndExport(
        location.id,
        'messages',
        format,
        exportFilters,
        notificationEmail
      );

      if (response.success) {
        setActiveJob({
          jobId: response.data.jobId,
          status: response.data.status,
          totalItems: response.data.totalItems,
          progress: { total: response.data.totalItems, processed: 0, percent: 0 }
        });
        setExportModalVisible(false);
        setEstimate(null);
        antMessage.success('Export started! We\'ll process it in the background.');
      } else {
        setEstimateError(response.error || 'Export failed');
      }
    } catch (err) {
      setEstimateError(err.code === 'INSUFFICIENT_FUNDS' ? err : (err.message || 'Export failed'));
    } finally {
      setProcessing(false);
    }
  };

  // Handle modal close
  const handleModalClose = () => {
    if (!processing) {
      setExportModalVisible(false);
      setEstimate(null);
      setEstimateError(null);
    }
  };

  return (
    <div className="space-y-6">
      {ErrorModalComponent}
      {InfoModalComponent}

      {/* Export Estimate Modal */}
      <ExportEstimateModal
        visible={exportModalVisible}
        onCancel={handleModalClose}
        onConfirm={handlePayAndExport}
        loading={processing}
        estimating={estimating}
        estimate={estimate}
        error={estimateError}
        exportType="messages"
        usingDefaultDates={usingDefaultDates}
      />

      {/* Header with Stats */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Messages</h2>
          <p className="text-sm text-gray-500 mt-1">View, filter, and export all messages from this sub-account</p>
        </div>
        <div className="flex items-center gap-3">
          {data?.data && (
            <>
              <div className="bg-green-50 px-4 py-2 rounded-lg">
                <div className="text-2xl font-bold text-green-600">{totalMessages.toLocaleString()}</div>
                <div className="text-xs text-green-600 font-medium">Total Messages</div>
              </div>
              <div className="bg-blue-50 px-4 py-2 rounded-lg">
                <div className="text-2xl font-bold text-blue-600">{loadedMessages.toLocaleString()}</div>
                <div className="text-xs text-blue-600 font-medium">Loaded</div>
              </div>
            </>
          )}
          <div className="flex items-center gap-2">
          <Button
            onClick={handleGetEstimate}
            disabled={activeJob && ['pending', 'processing'].includes(activeJob.status)}
            size="large"
            type="primary"
            className="bg-green-600 hover:bg-green-700 border-green-600"
            icon={
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
            }
          >
              Export Messages
          </Button>
            <Tooltip
              title={
                <div style={{ fontSize: '13px', lineHeight: '1.6' }}>
                  <strong>Pay-per-use export</strong>
                  <br />
                  1 cent per text message, 3 cents per email. Volume discounts up to 70%!
                </div>
              }
              placement="left"
            >
              <div className="w-6 h-6 bg-blue-100 rounded-full flex items-center justify-center cursor-help">
                <svg className="w-4 h-4 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
            </Tooltip>
          </div>
        </div>
      </div>

      {/* Active Export Job Progress */}
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

      {/* Filters Card */}
      <div className="bg-white border-1 border-solid border-gray-200 rounded-xl p-6 shadow-sm">
        <h3 className="text-sm font-semibold text-gray-700 mb-4 flex items-center gap-2">
          <svg className="w-5 h-5 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
          </svg>
          Filter Messages
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Channel</label>
            <Select
              value={filters.channel}
              onChange={(value) => setFilters({ ...filters, channel: value })}
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
                // { value: 'GMB', label: 'Google My Business' },
                // { value: 'Call', label: 'Call' }
              ]}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Start Date</label>
            <DatePicker
              value={filters.startDate ? dayjs(filters.startDate) : null}
              onChange={(date) => setFilters({ ...filters, startDate: date ? date.format('YYYY-MM-DD') : '' })}
              className="w-full"
              size="large"
              placeholder="Select start date"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">End Date</label>
            <DatePicker
              value={filters.endDate ? dayjs(filters.endDate) : null}
              onChange={(date) => setFilters({ ...filters, endDate: date ? date.format('YYYY-MM-DD') : '' })}
              className="w-full"
              size="large"
              placeholder="Select end date"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Contact</label>
            <Select
              showSearch
              value={filters.contactId || undefined}
              onChange={(val) => setFilters({ ...filters, contactId: val || '' })}
              onSearch={handleContactSearch}
              placeholder="Search contacts..."
              allowClear
              loading={contactsLoading}
              filterOption={false}
              notFoundContent={contactsLoading ? 'Searching...' : 'No contacts found'}
              className="w-full"
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

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Contact ID</label>
            <Input
              value={filters.contactId}
              onChange={(e) => setFilters({ ...filters, contactId: e.target.value })}
              placeholder="Paste contact ID..."
              size="large"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">User</label>
            <Select
              showSearch
              value={filters.userId || undefined}
              onChange={(val) => setFilters({ ...filters, userId: val || '' })}
              onSearch={handleUserSearch}
              placeholder="Search users..."
              allowClear
              loading={usersLoading}
              filterOption={false}
              notFoundContent={usersLoading ? 'Searching...' : 'No users found'}
              className="w-full"
              size="large"
            >
              {userOptions.map(u => (
                <Select.Option key={u.id} value={u.id}>
                  <div className="flex flex-col leading-tight">
                    <span className="text-sm">{u.name}</span>
                    {u.email && (
                      <span className="text-xs text-gray-400">{u.email}</span>
                    )}
                  </div>
                </Select.Option>
              ))}
            </Select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Conversation ID</label>
            <Input
              value={filters.conversationId}
              onChange={(e) => setFilters({ ...filters, conversationId: e.target.value })}
              placeholder="Filter by conversation ID"
              size="large"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Page Size</label>
            <Select
              value={filters.limit}
              onChange={(value) => setFilters({ ...filters, limit: value })}
              className="w-full"
              size="large"
              options={[
                { value: 20, label: '20' },
                { value: 50, label: '50' },
                { value: 100, label: '100' },
                { value: 200, label: '200' },
                { value: 500, label: '500' }
              ]}
            />
          </div>

          <div className="flex items-end">
            <Button
              onClick={() => {
                setAppliedFilters({...filters}); // Apply current filters (create new object)
                setCursor(null); // Reset pagination
                setShouldFetch(true); // Enable fetch
                setSearchTimestamp(Date.now()); // Force refetch even if filters unchanged
              }}
              type="primary"
              size="large"
              className="w-full"
              loading={isLoading}
              icon={
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
              }
            >
              Search
            </Button>
          </div>
        </div>
      </div>

      {/* Loading State */}
      {isLoading && (
        <div className="text-center py-16">
          <div className="animate-spin rounded-full h-12 w-12 border-4 border-blue-600 border-t-transparent mx-auto mb-4"></div>
          <p className="text-gray-600 font-medium">Loading messages...</p>
        </div>
      )}

      {/* No Results State */}
      {isNoResults && (
        <div className="text-center py-20 bg-gradient-to-br from-yellow-50 to-orange-50 rounded-xl border-2 border-dashed border-yellow-300">
          <div className="text-5xl mb-4">🔍</div>
          <h3 className="text-lg font-semibold text-gray-900 mb-2">No Messages Found</h3>
          <p className="text-gray-600 mb-4">No messages match your current filters</p>
          <div className="text-sm text-gray-500 space-y-2">
            <p className="font-medium">Try adjusting:</p>
            <ul className="list-none space-y-1">
              {appliedFilters.conversationId && <li>• Conversation ID (check if it's correct)</li>}
              {appliedFilters.contactId && <li>• Contact ID</li>}
              {appliedFilters.channel && <li>• Channel filter</li>}
              {(appliedFilters.startDate || appliedFilters.endDate) && <li>• Date range</li>}
            </ul>
            <p className="mt-3 text-xs text-gray-400">Or clear all filters and try again</p>
          </div>
        </div>
      )}
      
      {/* Real Error State */}
      {error && !isNoResults && (
        <div className="bg-red-50 border-1 border-solid border-red-300 rounded-xl p-6">
          <div className="flex items-start gap-3">
            <svg className="w-6 h-6 text-red-600 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <div>
              <h4 className="font-semibold text-red-900">Error Loading Messages</h4>
              <p className="text-sm text-red-700 mt-1">{error.message}</p>
            </div>
          </div>
        </div>
      )}

      {/* Pagination Controls */}
      {!isLoading && !error && messages.length > 0 && (
        <div className="flex items-center justify-between bg-white border-1 border-solid border-gray-200 rounded-xl p-4">
          <span className="text-sm text-gray-600">Showing {loadedMessages.toLocaleString()} of {totalMessages.toLocaleString()} messages</span>
          <div className="flex gap-2">
            <Button onClick={() => setCursor(null)} disabled={!cursor} size="large">
              First Page
            </Button>
            <Button onClick={() => setCursor(nextCursorValue)} disabled={!hasMore} type="primary" size="large">
              Next Page
            </Button>
          </div>
        </div>
      )}

      {/* Messages List */}
      {!isLoading && !error && (
        <div className="space-y-3">
          {messages.length === 0 ? (
            <div className="text-center py-20 bg-gradient-to-br from-gray-50 to-white rounded-xl border-2 border-dashed border-gray-300">
              <div className="text-5xl mb-4">💬</div>
              <h3 className="text-lg font-semibold text-gray-900 mb-2">No Messages Found</h3>
              <p className="text-gray-500">Try adjusting your filters</p>
            </div>
          ) : (
            messages.map((message) => {
              const isOutbound = message.direction === 'outbound';
              return (
                <div
                  key={message.id}
                  className="bg-white border-1 border-solid border-gray-200 rounded-lg p-4 hover:border-blue-400 hover:shadow-md transition-all"
                >
                  <div className="flex items-start gap-4">
                    {/* Avatar */}
                    <div className={`w-10 h-10 rounded-full flex items-center justify-center text-white font-bold ${
                      isOutbound ? 'bg-gradient-to-br from-blue-500 to-blue-600' : 'bg-gray-400'
                    }`}>
                      {isOutbound ? 'You' : (message.contactId || 'C')[0].toUpperCase()}
                    </div>

                    {/* Content */}
                    <div className="flex-1">
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-gray-900">
                            {isOutbound ? 'Outbound' : 'Inbound'}
                          </span>
                          <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded flex items-center gap-1">
                            <span>{getMessageTypeIcon(message.type)}</span>
                            <span>{getMessageTypeDisplay(message.type)}</span>
                          </span>
                          {message.status && (
                            <span className={`text-xs px-2 py-0.5 rounded ${
                              message.status === 'delivered' || message.status === 'sent'
                                ? 'bg-green-100 text-green-700'
                                : message.status === 'failed'
                                ? 'bg-red-100 text-red-700'
                                : 'bg-gray-100 text-gray-600'
                            }`}>
                              {message.status}
                            </span>
                          )}
                        </div>
                        <span className="text-xs text-gray-500">
                          {new Date(message.dateAdded).toLocaleString()}
                        </span>
                      </div>
                        {/* Email Thread Notice */}
                        {(message.type === 'TYPE_EMAIL' || message.type === 'Email' || message.type === 3) && 
                        message.meta?.email?.messageIds && 
                        message.meta.email.messageIds.length > 1 && (
                          <div className="mb-2 px-3 py-1.5 bg-blue-50 border border-blue-200 rounded-lg flex items-center gap-2 text-xs text-blue-700">
                            <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                            </svg>
                            <span className="font-medium">
                              📧 Email Thread ({message.meta.email.messageIds.length} messages)
                            </span>
                            <Tooltip
                              title="Click on this conversation in the Conversations tab to view all messages in the thread. Download from there to get the complete email thread with all replies."
                              placement="top"
                            >
                              <svg className="w-4 h-4 cursor-help" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                              </svg>
                            </Tooltip>
                          </div>
                        )}

                      <p className="text-sm text-gray-700 mb-2">{message.body}</p>
                      
                      {/* Attachments */}
                      {message.attachments && message.attachments.length > 0 && (
                        <div className="mb-2 flex items-center gap-2 text-xs text-gray-600">
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                          </svg>
                          <span className="font-medium">
                            {message.attachments.length} attachment{message.attachments.length > 1 ? 's' : ''}
                          </span>
                          <Tooltip
                            title="Attachment URLs are included in the CSV export. Click 'Export CSV' to download all attachment links."
                            placement="top"
                          >
                            <svg className="w-4 h-4 cursor-help text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                            </svg>
                          </Tooltip>
                        </div>
                      )}

                      <div className="flex items-center gap-4 text-xs text-gray-500">
                        <Tooltip title="Click to copy Conversation ID">
                          <button
                            onClick={async (e) => {
                              e.stopPropagation();
                              const success = await copyToClipboard(message.conversationId);
                              if (success) {
                                antMessage.success('Conversation ID copied!');
                              } else {
                                antMessage.error('Failed to copy. Please try selecting and copying manually.');
                              }
                            }}
                            className="flex items-center gap-1 hover:text-blue-600 transition-colors group/conv"
                          >
                            <span className="font-mono">conversationId: {message.conversationId}</span>
                            <svg className="w-3 h-3 opacity-0 group-hover/conv:opacity-100 transition-opacity" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                            </svg>
                          </button>
                        </Tooltip>
                        <Tooltip title="Click to copy Contact ID">
                          <button
                            onClick={async (e) => {
                              e.stopPropagation();
                              const success = await copyToClipboard(message.contactId);
                              if (success) {
                                antMessage.success('Contact ID copied!');
                              } else {
                                antMessage.error('Failed to copy. Please try selecting and copying manually.');
                              }
                            }}
                            className="flex items-center gap-1 hover:text-blue-600 transition-colors group/contact"
                          >
                            <span className="font-mono">contactId: {message.contactId}</span>
                            <svg className="w-3 h-3 opacity-0 group-hover/contact:opacity-100 transition-opacity" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                            </svg>
                          </button>
                        </Tooltip>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}

      {/* Footer Stats */}
      {messages.length > 0 && (
        <div className="bg-gray-50 border-1 border-solid border-gray-200 rounded-xl p-4">
          <div className="text-sm text-gray-600">
            💬 Showing {loadedMessages.toLocaleString()} of {totalMessages.toLocaleString()} messages •
            {messages.filter(m => m.direction === 'inbound').length} received •
            {messages.filter(m => m.direction === 'outbound').length} sent
            {hasMore && <span className="ml-4 text-blue-600 font-medium">• More pages available</span>}
          </div>
        </div>
      )}
    </div>
  );
}

