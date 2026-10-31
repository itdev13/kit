import SimpleExportTab from './SimpleExportTab';

const COLUMNS = ['InvoiceID', 'InvoiceNumber', 'Name', 'Status', 'ContactID', 'ContactName', 'ContactEmail', 'Currency', 'Total', 'AmountPaid', 'AmountDue', 'DueDate', 'IssueDate', 'CreatedAt', 'UpdatedAt'];

export default function InvoicesTab() {
  return (
    <SimpleExportTab
      exportType="invoices"
      title="Invoices"
      subtitle="Export all invoices from this sub-account"
      buttonLabel="Export Invoices"
      unit="invoice"
      icon="🧾"
      columns={COLUMNS}
    />
  );
}
