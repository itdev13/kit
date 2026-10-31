import SimpleExportTab from './SimpleExportTab';

const COLUMNS = ['TransactionID', 'Status', 'ContactID', 'ContactName', 'ContactEmail', 'Currency', 'Amount', 'PaymentProvider', 'EntityType', 'EntityID', 'ChargeID', 'CreatedAt', 'UpdatedAt'];

export default function PaymentTransactionsTab() {
  return (
    <SimpleExportTab
      exportType="paymentTransactions"
      title="Payment Transactions"
      subtitle="Export all payment transactions from this sub-account"
      buttonLabel="Export Transactions"
      unit="transaction"
      icon="💳"
      columns={COLUMNS}
    />
  );
}
