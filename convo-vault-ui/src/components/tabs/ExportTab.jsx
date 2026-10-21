import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../../context/AuthContext';
import { billingAPI } from '../../api/billing';
import { Pagination } from 'antd';
import dayjs from 'dayjs';

export default function ExportTab() {
  const { location } = useAuth();

  // Export history state
  const [exportHistory, setExportHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [refreshingJobId, setRefreshingJobId] = useState(null);

  // Pagination state
  const [currentPage, setCurrentPage] = useState(1);
  const [totalItems, setTotalItems] = useState(0);
  const [pageSize] = useState(10);

  // Check if download URL is expired
  const isUrlExpired = (expiresAt) => {
    if (!expiresAt) return false;
    return new Date(expiresAt) < new Date();
  };

  // Format date for display
  const formatDate = (date) => {
    if (!date) return '-';
    return dayjs(date).format('MMM D, YYYY');
  };

  // Format filter value for display
  const formatFilterValue = (key, value) => {
    if (!value) return null;
    if (key === 'startDate' || key === 'endDate') {
      return formatDate(value);
    }
    return value;
  };

  // Get applied filters as array of {label, value}
  const getAppliedFilters = (filters) => {
    if (!filters) return [];
    const applied = [];

    // Common filters
    if (filters.channel) {
      applied.push({ label: 'Channel', value: filters.channel });
    }
    if (filters.startDate) {
      applied.push({ label: 'From', value: formatDate(filters.startDate) });
    }
    if (filters.endDate) {
      applied.push({ label: 'To', value: formatDate(filters.endDate) });
    }
    if (filters.contactId) {
      applied.push({ label: 'Contact', value: filters.contactId.substring(0, 8) + '...' });
    }
    // Conversation-specific filters
    if (filters.query) {
      applied.push({ label: 'Search', value: filters.query.substring(0, 20) + (filters.query.length > 20 ? '...' : '') });
    }
    if (filters.conversationId) {
      applied.push({ label: 'Conversation', value: filters.conversationId.substring(0, 8) + '...' });
    }
    if (filters.lastMessageType) {
      applied.push({ label: 'Type', value: filters.lastMessageType });
    }
    if (filters.lastMessageDirection) {
      applied.push({ label: 'Direction', value: filters.lastMessageDirection });
    }
    if (filters.status) {
      applied.push({ label: 'Status', value: filters.status });
    }
    if (filters.lastMessageAction) {
      applied.push({ label: 'Action', value: filters.lastMessageAction });
    }

    return applied;
  };

  // Load export history with pagination
  const loadExportHistory = useCallback(async (page = currentPage) => {
    if (!location?.id) return;

    try {
      setHistoryLoading(true);
      const response = await billingAPI.getExportHistory(location.id, page, pageSize);
      if (response.success) {
        setExportHistory(response.data.jobs || []);
        setTotalItems(response.data.total || 0);
        setCurrentPage(response.data.page || 1);
      }
    } catch (err) {
      console.error('Failed to load export history:', err);
    } finally {
      setHistoryLoading(false);
    }
  }, [location?.id, currentPage, pageSize]);

  // Refresh single job status (for processing jobs)
  const refreshJobStatus = async (jobId) => {
    setRefreshingJobId(jobId);
    try {
      const response = await billingAPI.getExportStatus(jobId, location?.id);
      if (response.success) {
        // Update the job in the list
        setExportHistory(prev => prev.map(job =>
          job.jobId === jobId ? {
            ...job,
            status: response.data.status,
            processedItems: response.data.progress?.processed,
            downloadUrl: response.data.downloadUrl,
            downloadUrlExpiresAt: response.data.downloadUrlExpiresAt,
            errorMessage: response.data.errorMessage
          } : job
        ));
      }
    } catch (err) {
      console.error('Failed to refresh job status:', err);
    } finally {
      setRefreshingJobId(null);
    }
  };

  // Download: fetch a FRESH presigned URL from the backend (generated on the fly), then open it.
  // We no longer open the stored downloadUrl directly — that signature dies within hours.
  const [downloadingJobId, setDownloadingJobId] = useState(null);
  const handleDownload = async (jobId) => {
    setDownloadingJobId(jobId);
    try {
      const response = await billingAPI.getDownloadUrl(jobId, location?.id);
      if (response.success && response.data?.url) {
        window.open(response.data.url, '_blank');
      } else {
        alert(response.error || 'Could not generate download link. Please try again.');
      }
    } catch (err) {
      // Backend returns 410 with code DOWNLOAD_EXPIRED once past the 7-day window.
      const msg = err?.code === 'DOWNLOAD_EXPIRED'
        ? 'This download link has expired (7-day limit). Please run the export again.'
        : (err?.message || 'Could not generate download link. Please try again.');
      alert(msg);
    } finally {
      setDownloadingJobId(null);
    }
  };

  // Handle page change
  const handlePageChange = (page) => {
    setCurrentPage(page);
    loadExportHistory(page);
  };

  // Load history on mount
  useEffect(() => {
    loadExportHistory(1);
  }, [location?.id]);

  // Auto-poll for processing jobs
  useEffect(() => {
    const hasProcessingJobs = exportHistory.some(
      job => ['pending', 'processing'].includes(job.status)
    );

    if (!hasProcessingJobs) return;

    const pollInterval = setInterval(() => {
      loadExportHistory(currentPage);
    }, 5000); // Poll every 5 seconds

    return () => clearInterval(pollInterval);
  }, [exportHistory, currentPage, loadExportHistory]);

  return (
    <div>
      {/* Export History */}
      <div className="bg-white border border-gray-200 rounded-xl p-6 shadow-sm">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
            <svg className="w-5 h-5 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            Export History
            {totalItems > 0 && (
              <span className="text-xs text-gray-400 font-normal">({totalItems} total)</span>
            )}
          </h3>
          <button
            onClick={() => loadExportHistory(currentPage)}
            disabled={historyLoading}
            className="text-xs text-blue-600 hover:text-blue-700 flex items-center gap-1 disabled:opacity-50"
          >
            <svg className={`w-4 h-4 ${historyLoading ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            Refresh
          </button>
        </div>

        {historyLoading && exportHistory.length === 0 ? (
          <div className="text-center py-8 text-gray-500">Loading...</div>
        ) : exportHistory.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mb-4">
              <svg className="w-8 h-8 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
            </div>
            <h4 className="text-lg font-semibold text-gray-700 mb-2">No Exports Yet</h4>
            <p className="text-sm text-gray-500 max-w-xs">
              You haven't exported any data yet. Go to the Messages or Conversations tab to start an export.
            </p>
          </div>
        ) : (
          <>
            <div className="space-y-3">
              {exportHistory.map((job) => {
                const urlExpired = job.status === 'completed' && isUrlExpired(job.downloadUrlExpiresAt);
                const appliedFilters = getAppliedFilters(job.filters);
                const isProcessing = ['pending', 'processing'].includes(job.status);
                const isRefreshing = refreshingJobId === job.jobId;

                return (
                  <div
                    key={job.jobId}
                    className="p-4 bg-gray-50 rounded-lg border border-gray-100"
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        {/* Header row */}
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium text-gray-800 capitalize">
                            {job.exportType === 'contactBundleDoc' ? 'Contact Bundle (Google Doc)' : job.exportType} Export
                          </span>
                          <span className="text-xs px-2 py-0.5 bg-gray-200 text-gray-600 rounded uppercase">
                            {job.exportType === 'contactBundleDoc' ? 'PDF' : (job.format || 'csv')}
                          </span>
                        </div>

                        {/* Date and items */}
                        <div className="text-xs text-gray-500 mt-1">
                          {new Date(job.createdAt).toLocaleDateString()} at {new Date(job.createdAt).toLocaleTimeString()} • {job.totalItems?.toLocaleString()} items
                        </div>

                        {/* Applied Filters */}
                        {appliedFilters.length > 0 && (
                          <div className="flex items-center gap-2 mt-2 flex-wrap">
                            <span className="text-xs text-gray-400">Filters:</span>
                            {appliedFilters.map((filter, idx) => (
                              <span
                                key={idx}
                                className="text-xs px-2 py-0.5 bg-blue-50 text-blue-700 rounded border border-blue-100"
                              >
                                {filter.label}: {filter.value}
                              </span>
                            ))}
                          </div>
                        )}

                        {/* Progress bar for processing jobs */}
                        {isProcessing && (
                          <div className="mt-2">
                            <div className="flex items-center justify-between text-xs text-blue-600 mb-1">
                              <div className="flex items-center gap-2">
                                <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                </svg>
                                Processing...
                              </div>
                              <button
                                onClick={() => refreshJobStatus(job.jobId)}
                                disabled={isRefreshing}
                                className="text-blue-600 hover:text-blue-700 disabled:opacity-50"
                              >
                                {isRefreshing ? (
                                  <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                  </svg>
                                ) : (
                                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                                  </svg>
                                )}
                              </button>
                            </div>
                          </div>
                        )}

                        {/* Error message for failed jobs */}
                        {job.status === 'failed' && job.errorMessage && (
                          <div className="text-xs text-red-600 mt-1">
                            Error: {job.errorMessage}
                          </div>
                        )}

                        {/* Expiration warning */}
                        {job.status === 'completed' && urlExpired && (
                          <div className="text-xs text-amber-600 mt-1 flex items-center gap-1">
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                            </svg>
                            Download link expired
                          </div>
                        )}
                      </div>

                      {/* Status/Action buttons */}
                      <div className="flex items-center gap-2 ml-4">
                        {job.status === 'completed' ? (
                          urlExpired ? (
                            <span className="text-xs px-2 py-1 rounded bg-amber-100 text-amber-700">
                              Expired
                            </span>
                          ) : (
                            <button
                              onClick={() => handleDownload(job.jobId)}
                              disabled={downloadingJobId === job.jobId}
                              className="px-3 py-1.5 bg-green-600 text-white text-sm rounded hover:bg-green-700 flex items-center gap-1 disabled:bg-gray-400"
                            >
                              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                              </svg>
                              {downloadingJobId === job.jobId ? 'Preparing…' : 'Download'}
                            </button>
                          )
                        ) : (
                          <span className={`text-xs px-2 py-1 rounded ${
                            job.status === 'processing' ? 'bg-blue-100 text-blue-700' :
                            job.status === 'pending' ? 'bg-yellow-100 text-yellow-700' :
                            job.status === 'failed' ? 'bg-red-100 text-red-700' :
                            'bg-gray-100 text-gray-600'
                          }`}>
                            {job.status}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Pagination */}
            {totalItems > pageSize && (
              <div className="flex justify-center mt-6">
                <Pagination
                  current={currentPage}
                  total={totalItems}
                  pageSize={pageSize}
                  onChange={handlePageChange}
                  showSizeChanger={false}
                  showTotal={(total, range) => `${range[0]}-${range[1]} of ${total} exports`}
                />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
