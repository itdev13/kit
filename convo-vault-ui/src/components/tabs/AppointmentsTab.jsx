import { useState, useEffect } from 'react';
import { useAuth } from '../../context/AuthContext';
import { billingAPI } from '../../api/billing';
import { Button, Alert, Select, DatePicker, message as antMessage, Tooltip } from 'antd';
import ExportEstimateModal from '../ExportEstimateModal';
import ExportProgress from '../ExportProgress';

const { RangePicker } = DatePicker;

const COLUMNS = ['AppointmentID', 'Title', 'CalendarID', 'ContactID', 'AssignedUserID', 'Status', 'AppointmentStatus', 'StartTime', 'EndTime', 'Address', 'Notes', 'DateAdded', 'DateUpdated'];

export default function AppointmentsTab() {
  const { location } = useAuth();

  const [calendars, setCalendars] = useState([]);
  const [loadingCalendars, setLoadingCalendars] = useState(false);
  const [calendarsError, setCalendarsError] = useState(null);
  const [calendarId, setCalendarId] = useState(null);
  const [dateRange, setDateRange] = useState(null);

  const [exportModalVisible, setExportModalVisible] = useState(false);
  const [estimating, setEstimating] = useState(false);
  const [estimate, setEstimate] = useState(null);
  const [estimateError, setEstimateError] = useState(null);
  const [processing, setProcessing] = useState(false);
  const [activeJob, setActiveJob] = useState(null);

  useEffect(() => {
    if (!location?.id) return;
    let cancelled = false;
    (async () => {
      setLoadingCalendars(true);
      setCalendarsError(null);
      try {
        const res = await billingAPI.getCalendars(location.id);
        if (cancelled) return;
        if (res.success) setCalendars(res.data?.calendars || []);
        else setCalendarsError(res.error || 'Failed to load calendars');
      } catch (err) {
        if (!cancelled) setCalendarsError(err.message || 'Failed to load calendars');
      } finally {
        if (!cancelled) setLoadingCalendars(false);
      }
    })();
    return () => { cancelled = true; };
  }, [location?.id]);

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

  const buildFilters = () => {
    const filters = { calendarId };
    if (dateRange && dateRange[0] && dateRange[1]) {
      filters.startDate = dateRange[0].startOf('day').toISOString();
      filters.endDate = dateRange[1].endOf('day').toISOString();
    }
    return filters;
  };

  const handleGetEstimate = async () => {
    if (!calendarId) { antMessage.warning('Please select a calendar first'); return; }
    setExportModalVisible(true);
    setEstimating(true);
    setEstimate(null);
    setEstimateError(null);
    try {
      const res = await billingAPI.getEstimate(location.id, 'appointments', buildFilters());
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
      const exportFilters = { ...buildFilters(), estimatedTotal: estimate?.itemCounts?.total || undefined };
      const res = await billingAPI.chargeAndExport(location.id, 'appointments', format, exportFilters, notificationEmail);
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
        exportType="appointments"
      />

      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Appointments</h2>
          <p className="text-sm text-gray-500 mt-1">Export calendar appointments from this sub-account</p>
        </div>
        <div className="flex items-center gap-3">
          <Button
            onClick={handleGetEstimate}
            disabled={isExporting || loadingCalendars || !calendarId}
            size="large"
            type="primary"
            className="bg-green-600 hover:bg-green-700 border-green-600"
            icon={
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
            }
          >
            Export Appointments
          </Button>
          <Tooltip
            title={
              <div style={{ fontSize: '13px', lineHeight: '1.6' }}>
                <strong>Pay-per-use export</strong>
                <br />
                $0.018 per appointment. Volume discounts up to 70%!
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

      {calendarsError && (
        <Alert type="error" message="Error loading calendars" description={calendarsError} showIcon />
      )}

      <div className="bg-white border-1 border-solid border-gray-200 rounded-xl p-6 shadow-sm space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">Calendar <span className="text-red-500">*</span></label>
          <Select
            value={calendarId}
            onChange={setCalendarId}
            placeholder={loadingCalendars ? 'Loading calendars…' : 'Select a calendar'}
            loading={loadingCalendars}
            size="large"
            className="w-full"
            options={calendars.map(c => ({ value: c.id, label: c.name || c.id }))}
            showSearch
            optionFilterProp="label"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">Date range <span className="text-gray-400">(optional)</span></label>
          <RangePicker value={dateRange} onChange={setDateRange} size="large" className="w-full" />
          <p className="text-xs text-gray-400 mt-1">Leave blank to export all appointments on the selected calendar.</p>
        </div>
      </div>

      <div className="bg-white border border-gray-200 rounded-xl p-5">
        <h3 className="text-sm font-semibold text-gray-700 mb-3">Export Columns</h3>
        <div className="flex flex-wrap gap-2">
          {COLUMNS.map((col) => (
            <span key={col} className="px-3 py-1 bg-gray-100 text-gray-700 text-xs font-mono rounded-full">{col}</span>
          ))}
        </div>
      </div>
    </div>
  );
}
