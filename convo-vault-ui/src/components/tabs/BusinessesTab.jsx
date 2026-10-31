import SimpleExportTab from './SimpleExportTab';

const COLUMNS = ['BusinessID', 'Name', 'Email', 'Phone', 'Website', 'Address', 'City', 'State', 'Country', 'PostalCode', 'LocationID', 'CreatedAt', 'UpdatedAt'];

export default function BusinessesTab() {
  return (
    <SimpleExportTab
      exportType="businesses"
      title="Businesses"
      subtitle="Export all businesses from this sub-account"
      buttonLabel="Export Businesses"
      unit="business"
      icon="🏢"
      columns={COLUMNS}
    />
  );
}
