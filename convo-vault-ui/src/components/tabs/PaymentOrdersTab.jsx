import SimpleExportTab from './SimpleExportTab';

const COLUMNS = ['OrderID', 'Status', 'ContactID', 'ContactName', 'ContactEmail', 'Currency', 'Amount', 'Subtotal', 'Source', 'SourceType', 'LiveMode', 'CreatedAt', 'UpdatedAt'];

export default function PaymentOrdersTab() {
  return (
    <SimpleExportTab
      exportType="paymentOrders"
      title="Payment Orders"
      subtitle="Export all payment orders from this sub-account"
      buttonLabel="Export Orders"
      unit="order"
      icon="🛒"
      columns={COLUMNS}
    />
  );
}
