import SimpleExportTab from './SimpleExportTab';

const COLUMNS = ['FileID', 'Name', 'Type', 'URL', 'ParentID', 'AltType', 'AltID', 'CreatedAt', 'UpdatedAt'];

export default function MediaFilesTab() {
  return (
    <SimpleExportTab
      exportType="mediaFiles"
      title="Media Files"
      subtitle="Export the media library file list from this sub-account"
      buttonLabel="Export Media Files"
      unit="file"
      icon="🖼️"
      columns={COLUMNS}
    />
  );
}
