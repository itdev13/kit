import { useState, useRef, useEffect } from 'react';
import { useAuth } from '../../context/AuthContext';
import { Button, Table, Alert, Progress, message as antMessage } from 'antd';
import ExportEstimateModal from '../ExportEstimateModal';
import { importAPI } from '../../api/import';
import { DISCOUNT_TIERS } from '../../constants/pricing';

const UNIT_PRICE = 0.018; // mirrors backend importOpportunities / importTasks default unit price

const getDiscountPercent = (count) => {
  for (const tier of DISCOUNT_TIERS) {
    if (count >= tier.min && count < tier.max) return tier.discount;
  }
  return DISCOUNT_TIERS[DISCOUNT_TIERS.length - 1].discount;
};

const formatTierRange = (tier) =>
  tier.max === Infinity ? `${tier.min}+` : `${tier.min}-${tier.max}`;

// Minimal RFC-4180 CSV parser — handles quoted fields, escaped quotes, embedded commas/newlines.
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; }
      } else {
        field += c;
      }
    } else {
      if (c === '"') { inQuotes = true; }
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c === '\r') { /* skip */ }
      else { field += c; }
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter(r => r.length > 0 && !(r.length === 1 && r[0] === ''));
}

function rowsToObjects(rows) {
  if (rows.length === 0) return { headers: [], records: [] };
  const headers = rows[0].map(h => h.trim());
  const records = rows.slice(1).map(r => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = r[i] || ''; });
    return obj;
  });
  return { headers, records };
}

/**
 * Shared import tab for CSV-driven bulk creates (opportunities, tasks). The backend
 * resolves column aliases (camelCase / snake_case / TitleCase) so raw CSV records are
 * passed straight through as `rows`. Charges inline, then runs a background job.
 *
 * Props:
 *   title, subtitle  - headings
 *   importType       - 'opportunities' | 'tasks' (for the estimate modal label & copy)
 *   requiredCol      - the one column that must be present & non-empty (e.g. 'name')
 *   requiredColAliases - accepted header spellings for requiredCol
 *   requiredHint     - JSX describing required columns to the user
 *   previewColumns   - antd Table columns for the preview
 *   doImport         - (locationId, rows, fileName) => api promise
 *   itemCountKey     - key used inside estimate.itemCounts (e.g. 'opportunities')
 */
export default function SimpleImportTab({
  title, subtitle, importType, requiredColAliases, requiredHint,
  previewColumns, doImport, itemCountKey
}) {
  const { location } = useAuth();
  const fileInputRef = useRef(null);

  const [fileName, setFileName] = useState('');
  const [parsedRows, setParsedRows] = useState([]);
  const [parseError, setParseError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [activeJob, setActiveJob] = useState(null);
  const [estimateVisible, setEstimateVisible] = useState(false);

  const hasRequired = (rec) => requiredColAliases.some(a => (rec[a] || '').toString().trim());

  const handleFile = async (file) => {
    setParseError(null);
    setParsedRows([]);
    setActiveJob(null);
    setFileName(file.name);

    if (!file.name.toLowerCase().endsWith('.csv')) {
      setParseError('Only CSV files are supported. If you exported as XLSX, please re-export as CSV.');
      return;
    }

    try {
      const text = await file.text();
      const rawRows = parseCSV(text);
      const { headers, records } = rowsToObjects(rawRows);

      const hasReqHeader = requiredColAliases.some(a => headers.includes(a));
      if (!hasReqHeader) {
        setParseError(`File is missing a required column. Expected one of: ${requiredColAliases.join(', ')}.`);
        return;
      }

      const valid = records.filter(hasRequired);
      if (valid.length === 0) {
        setParseError('No rows with the required values were found in the file.');
        return;
      }

      setParsedRows(valid);
    } catch (err) {
      setParseError(`Failed to parse file: ${err.message}`);
    }
  };

  const handleConfirmCharge = async () => {
    if (!location?.id || parsedRows.length === 0) return;
    setSubmitting(true);
    try {
      const res = await doImport(location.id, parsedRows, fileName);
      if (res.success) {
        setActiveJob({ jobId: res.data.jobId, totalRows: res.data.totalRows, status: 'processing', processed: 0 });
        setEstimateVisible(false);
        antMessage.success(`Charged $${Number(res.data.amountCharged || 0).toFixed(2)}. Import processing in background.`);
      } else {
        antMessage.error(res.error || 'Failed to start import');
      }
    } catch (err) {
      antMessage.error(err.response?.data?.error || err.message || 'Import failed');
    } finally {
      setSubmitting(false);
    }
  };

  const baseAmount = Number((parsedRows.length * UNIT_PRICE).toFixed(4));
  const importDiscountPercent = getDiscountPercent(parsedRows.length);
  const importDiscountAmount = Number((baseAmount * (importDiscountPercent / 100)).toFixed(4));
  const finalImportAmount = Number((baseAmount - importDiscountAmount).toFixed(4));

  useEffect(() => {
    if (!activeJob?.jobId || activeJob.status === 'completed' || activeJob.status === 'failed') return;
    const interval = setInterval(async () => {
      try {
        const res = await importAPI.getStatus(activeJob.jobId);
        if (res.success) {
          setActiveJob({ ...activeJob, ...res.data });
          if (res.data.status === 'completed') {
            antMessage.success(`Import done: ${res.data.successful} created, ${res.data.skipped || 0} skipped, ${res.data.failed} failed`);
          }
        }
      } catch { /* silent */ }
    }, 3000);
    return () => clearInterval(interval);
  }, [activeJob?.jobId, activeJob?.status]);

  const progressPercent = activeJob && activeJob.totalRows
    ? Math.round(((activeJob.processed || 0) / activeJob.totalRows) * 100)
    : 0;

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-gray-900 mb-1">{title}</h2>
        <p className="text-gray-600 text-sm mb-2">{subtitle}</p>
        <p className="text-gray-500 text-xs">{requiredHint}</p>
      </div>

      <div className="mb-6 flex items-center gap-3">
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv"
          className="hidden"
          onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
        />
        <Button type="primary" onClick={() => fileInputRef.current?.click()} disabled={submitting}>
          Select CSV file
        </Button>
        {fileName && <span className="text-sm text-gray-700">{fileName}</span>}
      </div>

      {parseError && (
        <Alert type="error" message="Cannot import this file" description={parseError} className="mb-4" showIcon />
      )}

      {parsedRows.length > 0 && !activeJob && (
        <>
          <Alert
            type="info"
            message={`${parsedRows.length} rows ready to import`}
            description="Review the rows below, then click Submit to create records in this location."
            className="mb-4"
            showIcon
          />
          <Table
            rowKey={(_, i) => i}
            columns={previewColumns}
            dataSource={parsedRows}
            pagination={{ pageSize: 25, showSizeChanger: false }}
            size="small"
            scroll={{ x: 800 }}
            className="mb-4"
          />
          <div className="flex justify-end">
            <Button type="primary" size="large" onClick={() => setEstimateVisible(true)} loading={submitting}>
              Submit & Import {parsedRows.length} Rows
            </Button>
          </div>
        </>
      )}

      <ExportEstimateModal
        visible={estimateVisible}
        onCancel={() => !submitting && setEstimateVisible(false)}
        onConfirm={handleConfirmCharge}
        loading={submitting}
        estimating={false}
        exportType={importType}
        importMode={true}
        estimate={{
          itemCounts: { [itemCountKey]: parsedRows.length, total: parsedRows.length },
          breakdown: {
            [itemCountKey]: { count: parsedRows.length, unitPrice: UNIT_PRICE, subtotal: baseAmount }
          },
          baseAmount,
          discountPercent: importDiscountPercent,
          discountAmount: importDiscountAmount,
          finalAmount: finalImportAmount,
          discountTiers: DISCOUNT_TIERS.map(t => ({ range: formatTierRange(t), discount: t.discount }))
        }}
      />

      {activeJob && (
        <div className="border border-gray-200 rounded-lg p-5 bg-gray-50">
          <div className="flex items-center justify-between mb-3">
            <span className="font-semibold text-gray-900">
              {activeJob.status === 'completed' ? 'Import complete' : 'Importing...'}
            </span>
            <span className="text-sm text-gray-600">
              {activeJob.processed || 0} / {activeJob.totalRows}
            </span>
          </div>
          <Progress percent={progressPercent} status={activeJob.status === 'completed' ? 'success' : 'active'} />
          {activeJob.status === 'completed' && (
            <div className="mt-4 grid grid-cols-3 gap-3 text-sm">
              <div className="bg-green-50 border border-green-200 rounded p-3">
                <div className="text-green-700 font-semibold text-lg">{activeJob.successful || 0}</div>
                <div className="text-green-700 text-xs">Created</div>
              </div>
              <div className="bg-yellow-50 border border-yellow-200 rounded p-3">
                <div className="text-yellow-700 font-semibold text-lg">{activeJob.skipped || 0}</div>
                <div className="text-yellow-700 text-xs">Skipped</div>
              </div>
              <div className="bg-red-50 border border-red-200 rounded p-3">
                <div className="text-red-700 font-semibold text-lg">{activeJob.failed || 0}</div>
                <div className="text-red-700 text-xs">Failed</div>
              </div>
            </div>
          )}
          {activeJob.status === 'completed' && activeJob.errors && activeJob.errors.length > 0 && (
            <details className="mt-4">
              <summary className="cursor-pointer text-sm text-gray-700">View {activeJob.errors.length} error{activeJob.errors.length > 1 ? 's' : ''}</summary>
              <ul className="mt-2 space-y-1 text-xs text-red-700 max-h-48 overflow-y-auto">
                {activeJob.errors.slice(0, 50).map((e, i) => (
                  <li key={i}>Row {e.row}: {e.error}</li>
                ))}
              </ul>
            </details>
          )}
          {activeJob.status === 'completed' && (
            <div className="mt-4 flex justify-end">
              <Button onClick={() => { setActiveJob(null); setParsedRows([]); setFileName(''); }}>
                Import another file
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
