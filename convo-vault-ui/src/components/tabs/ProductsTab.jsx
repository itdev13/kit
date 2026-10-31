import SimpleExportTab from './SimpleExportTab';

const COLUMNS = ['ProductID', 'Name', 'Description', 'ProductType', 'Available', 'Currency', 'Prices', 'LocationID', 'CreatedAt', 'UpdatedAt'];

export default function ProductsTab() {
  return (
    <SimpleExportTab
      exportType="products"
      title="Products"
      subtitle="Export all products from this sub-account"
      buttonLabel="Export Products"
      unit="product"
      icon="📦"
      columns={COLUMNS}
    />
  );
}
