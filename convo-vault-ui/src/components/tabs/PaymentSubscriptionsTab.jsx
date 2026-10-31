import SimpleExportTab from './SimpleExportTab';

const COLUMNS = ['SubscriptionID', 'Status', 'ContactID', 'ContactName', 'ContactEmail', 'Currency', 'Amount', 'Interval', 'ProductID', 'PriceID', 'LiveMode', 'CreatedAt', 'UpdatedAt'];

export default function PaymentSubscriptionsTab() {
  return (
    <SimpleExportTab
      exportType="paymentSubscriptions"
      title="Subscriptions"
      subtitle="Export all payment subscriptions from this sub-account"
      buttonLabel="Export Subscriptions"
      unit="subscription"
      icon="🔁"
      columns={COLUMNS}
    />
  );
}
