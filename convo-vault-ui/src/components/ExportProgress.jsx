import React from 'react';
import { Progress, Tag, Button, Tooltip } from 'antd';

export default function ExportProgress({ job, onDownload, onRefresh }) {
  if (!job) return null;

  // Get status color and text
  const getStatusConfig = (status) => {
    switch (status) {
      case 'completed':
        return { color: 'green', text: 'Completed', icon: '✓' };
      case 'processing':
        return { color: 'blue', text: 'Processing', icon: '⟳' };
      case 'pending':
        return { color: 'orange', text: 'Pending', icon: '○' };
      case 'failed':
        return { color: 'red', text: 'Failed', icon: '✕' };
      default:
        return { color: 'default', text: status, icon: '?' };
    }
  };

  const statusConfig = getStatusConfig(job.status);

  // Format date
  const formatDate = (dateStr) => {
    if (!dateStr) return '-';
    const date = new Date(dateStr);
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  // Handle download click
  const handleDownload = () => {
    if (job.downloadUrl) {
      window.open(job.downloadUrl, '_blank');
      if (onDownload) onDownload(job.downloadUrl);
    }
  };

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4 shadow-sm">
      {/* Header */}
      <div className="flex justify-between items-start mb-3">
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <h4 className="font-semibold text-gray-800 capitalize">
              {job.exportType === 'contactBundleDoc' ? 'Contact Bundle (Google Doc)' : job.exportType} Export
            </h4>
            {/* contactBundleDoc always outputs a .docx regardless of job.format (which stays
                schema-valid csv/json), so show DOCX for it. */}
            <Tag className="uppercase text-xs">{job.exportType === 'contactBundleDoc' ? 'DOCX' : (job.format || 'csv')}</Tag>
          </div>
          <p className="text-xs text-gray-500 mt-0.5">
            Started {formatDate(job.startedAt || job.createdAt)}
          </p>
        </div>
        <Tag color={statusConfig.color}>
          {statusConfig.icon} {statusConfig.text}
        </Tag>
      </div>

      {/* Progress Bar (for processing status) */}
      {job.status === 'processing' && (
        <div className="mb-4">
          <Progress
            percent={job.progress?.percent || 0}
            status="active"
            strokeColor={{
              '0%': '#10B981',
              '100%': '#059669'
            }}
            trailColor="#E5E7EB"
          />
          <p className="text-xs text-gray-500 mt-1">
            {job.progress?.processed?.toLocaleString() || 0} / {job.progress?.total?.toLocaleString() || 0} items processed
          </p>
        </div>
      )}

      {/* Completed State */}
      {job.status === 'completed' && job.downloadUrl && (
        <div className="space-y-3">
          <div className="flex items-center justify-between text-sm">
            <span className="text-gray-600">Items Exported</span>
            <span className="font-medium text-gray-800">
              {job.progress?.processed?.toLocaleString() || job.totalItems?.toLocaleString() || '-'}
            </span>
          </div>

          <Button
            type="primary"
            onClick={handleDownload}
            className="w-full bg-green-600 hover:bg-green-700 border-green-600 hover:border-green-700"
            icon={
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
            }
          >
            Download Export
          </Button>

          {job.downloadUrlExpiresAt && (
            <p className="text-xs text-gray-500 text-center">
              Link expires {formatDate(job.downloadUrlExpiresAt)}
            </p>
          )}
        </div>
      )}

      {/* Failed State */}
      {job.status === 'failed' && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3">
          <div className="flex items-start gap-2">
            <svg className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <div>
              <p className="text-sm text-red-800 font-medium">Export Failed</p>
              <p className="text-xs text-red-600 mt-1">
                {job.errorMessage || 'An error occurred during export. Please try again.'}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Pending State */}
      {job.status === 'pending' && (
        <div className="flex items-center gap-2 text-sm text-gray-600">
          <div className="animate-pulse w-2 h-2 bg-orange-400 rounded-full"></div>
          <span>Waiting to start...</span>
        </div>
      )}

      {/* Info message for pending/processing - user can close page */}
      {['pending', 'processing'].includes(job.status) && (
        <div className="mt-4 bg-blue-50 border border-blue-200 rounded-lg p-3">
          <div className="flex items-start gap-2">
            <svg className="w-5 h-5 text-blue-500 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <div>
              <p className="text-sm text-blue-800 font-medium">You can close this page</p>
              <p className="text-xs text-blue-600 mt-1">
                We'll send you an email with the download link when your export is ready.
                You can also check the <span className="font-semibold">Exports</span> tab anytime to view your export history and download files.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Billing Info */}
      {/* {job.billing && (
        <div className="mt-3 pt-3 border-t border-gray-100 flex justify-between items-center text-xs text-gray-500">
          <span>Amount Charged</span>
          <span className="font-medium text-gray-700">${job.billing.amount}</span>
        </div>
      )} */}

      {/* Refresh Button (for non-completed jobs) */}
      {onRefresh && ['pending', 'processing'].includes(job.status) && (
        <div className="mt-3 pt-3 border-t border-gray-100">
          <Tooltip title="Check for updates">
            <Button
              type="link"
              size="small"
              onClick={onRefresh}
              className="text-xs p-0 h-auto text-gray-500 hover:text-gray-700"
            >
              Refresh Status
            </Button>
          </Tooltip>
        </div>
      )}
    </div>
  );
}
