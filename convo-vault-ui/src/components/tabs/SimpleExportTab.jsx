import { useState, useEffect } from 'react';
import { useAuth } from '../../context/AuthContext';
import { billingAPI } from '../../api/billing';
import { Button, Alert, message as antMessage, Tooltip } from 'antd';
import ExportEstimateModal from '../ExportEstimateModal';
import ExportProgress from '../ExportProgress';

/**
 * Shared export tab for "filter-less" record types (invoices, payments, surveys,
 * businesses, products, media files). Estimate → charge → background export.
 * No preview listing — the count comes from the estimate. Appointments has its own
 * tab because it needs a calendar + date-range selector.
 *
 * Props:
 *   exportType  - billing export type key (e.g. 'invoices')
 *   title       - page heading
 *   subtitle    - one-line description
 *   buttonLabel - export button text (e.g. 'Export Invoices')
 *   unit        - singular noun for the pricing tooltip (e.g. 'invoice')
 *   icon        - emoji for the empty/intro card
 *   columns     - array of CSV column names for the "Export Columns" card
 */
export default function SimpleExportTab({ exportType, title, subtitle, buttonLabel, unit, icon = '📤', columns = [] }) {
  const { location } = useAuth();

  const [exportModalVisible, setExportModalVisible] = useState(false);
  const [estimating, setEstimating] = useState(false);
  const [estimate, setEstimate] = useState(null);
  const [estimateError, setEstimateError] = useState(null);
  const [processing, setProcessing] = useState(false);
  const [activeJob, setActiveJob] = useState(null);

  useEffect(() => {
    if (!activeJob || !['pending', 'processing'].includes(activeJob.status)) return;
    const t = setInterval(async () => {
      try {
        const res = await billingAPI.getExportStatus(activeJob.jobId, location?.id);
        if (res.success) {
          setActiveJob(res.data);
          if (res.data.status === 'completed') antMessage.success('Export completed! Click Download to get your file.');
        }
      } catch (err) {
        console.error('Failed to poll job status:', err);
      }
    }, 5000);
    return () => clearInterval(t);
  }, [activeJob?.jobId, activeJob?.status, location?.id]);

  const handleGetEstimate = async () => {
    setExportModalVisible(true);
    setEstimating(true);
    setEstimate(null);
    setEstimateError(null);
    try {
      const res = await billingAPI.getEstimate(location.id, exportType, {});
      if (res.success && res.data?.estimate) setEstimate(res.data.estimate);
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
      const exportFilters = { estimatedTotal: estimate?.itemCounts?.total || undefined };
      const res = await billingAPI.chargeAndExport(location.id, exportType, format, exportFilters, notificationEmail);
      if (res.success) {
        setActiveJob({
          jobId: res.data.jobId,
          status: res.data.status,
          totalItems: res.data.totalItems,
          progress: { total: res.data.totalItems, processed: 0, percent: 0 }
        });
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
        exportType={exportType}
      />

      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">{title}</h2>
          <p className="text-sm text-gray-500 mt-1">{subtitle}</p>
        </div>
        <div className="flex items-center gap-3">
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
            {buttonLabel}
          </Button>
          <Tooltip
            title={
              <div style={{ fontSize: '13px', lineHeight: '1.6' }}>
                <strong>Pay-per-use export</strong>
                <br />
                $0.018 per {unit}. Volume discounts up to 70%!
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

      {activeJob && (
        <ExportProgress
          job={activeJob}
          onRefresh={() => {
            billingAPI.getExportStatus(activeJob.jobId, location?.id)
              .then(r => r.success && setActiveJob(r.data))
              .catch(console.error);
          }}
        />
      )}

      {/* Intro / call-to-action card. Kept compact and actionable so a filter-less export doesn't
          read as an empty placeholder: icon badge, a short explainer, an in-card estimate button,
          and three reassurance steps. */}
      <div className="bg-gradient-to-br from-gray-50 to-white border border-solid border-gray-200 rounded-xl px-6 py-7 shadow-sm">
        <div className="flex flex-col items-center text-center max-w-lg mx-auto">
          <div className="w-14 h-14 rounded-2xl bg-green-50 border border-green-100 flex items-center justify-center text-3xl mb-4">
            {icon}
          </div>
          <p className="text-gray-600 leading-relaxed">
            Click <strong className="text-gray-800">{buttonLabel}</strong> to see how many records are
            available and the exact price before you pay.
          </p>

          <div className="mt-5">
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
              {buttonLabel}
            </Button>
          </div>

          <div className="mt-6 pt-5 border-t border-gray-100 w-full grid grid-cols-1 sm:grid-cols-3 gap-4 text-left">
            <div className="flex items-start gap-2.5">
              <span className="flex-shrink-0 w-6 h-6 rounded-full bg-blue-50 text-blue-600 flex items-center justify-center text-xs font-bold">1</span>
              <div>
                <div className="text-xs font-semibold text-gray-800">See the count</div>
                <div className="text-xs text-gray-500">Records &amp; price up front</div>
              </div>
            </div>
            <div className="flex items-start gap-2.5">
              <span className="flex-shrink-0 w-6 h-6 rounded-full bg-blue-50 text-blue-600 flex items-center justify-center text-xs font-bold">2</span>
              <div>
                <div className="text-xs font-semibold text-gray-800">Pay per use</div>
                <div className="text-xs text-gray-500">$0.018/{unit}, volume discounts</div>
              </div>
            </div>
            <div className="flex items-start gap-2.5">
              <span className="flex-shrink-0 w-6 h-6 rounded-full bg-blue-50 text-blue-600 flex items-center justify-center text-xs font-bold">3</span>
              <div>
                <div className="text-xs font-semibold text-gray-800">Emailed when ready</div>
                <div className="text-xs text-gray-500">Download link sent to you</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {columns.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-gray-700 mb-3">Export Columns</h3>
          <div className="flex flex-wrap gap-2">
            {columns.map((col) => (
              <span key={col} className="px-3 py-1 bg-gray-100 text-gray-700 text-xs font-mono rounded-full">{col}</span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
