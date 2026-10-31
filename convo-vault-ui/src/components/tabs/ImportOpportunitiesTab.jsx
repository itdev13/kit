import SimpleImportTab from './SimpleImportTab';
import { importAPI } from '../../api/import';

const columns = [
  { title: 'Name', dataIndex: 'name', key: 'name', width: 180, ellipsis: true,
    render: (v, r) => v || r.Name || r.opportunityName || '—' },
  { title: 'Pipeline ID', dataIndex: 'pipelineId', key: 'pipelineId', width: 180, ellipsis: true,
    render: (v, r) => v || r.PipelineID || r.pipeline_id || '—' },
  { title: 'Stage ID', dataIndex: 'pipelineStageId', key: 'pipelineStageId', width: 160, ellipsis: true,
    render: (v, r) => v || r.StageID || r.stageId || '—' },
  { title: 'Contact', dataIndex: 'contactName', key: 'contactName', width: 160, ellipsis: true,
    render: (v, r) => v || r.ContactName || r.email || r.Email || '—' },
  { title: 'Value', dataIndex: 'monetaryValue', key: 'monetaryValue', width: 100,
    render: (v, r) => v || r.value || r.MonetaryValue || '—' },
];

export default function ImportOpportunitiesTab() {
  return (
    <SimpleImportTab
      title="Import Opportunities"
      subtitle="Upload a CSV to bulk-create opportunities. Contacts are matched by email or phone, or created if new."
      importType="importOpportunities"
      itemCountKey="opportunities"
      requiredColAliases={['name', 'Name', 'opportunityName']}
      previewColumns={columns}
      doImport={importAPI.importOpportunities}
      requiredHint={
        <>
          Required: an opportunity <code className="bg-gray-100 px-1.5 py-0.5 rounded">name</code> and a{' '}
          <code className="bg-gray-100 px-1.5 py-0.5 rounded">pipelineId</code>. Optional:{' '}
          <code className="bg-gray-100 px-1.5 py-0.5 rounded">pipelineStageId</code>,{' '}
          <code className="bg-gray-100 px-1.5 py-0.5 rounded">status</code>,{' '}
          <code className="bg-gray-100 px-1.5 py-0.5 rounded">monetaryValue</code>, and contact fields{' '}
          <code className="bg-gray-100 px-1.5 py-0.5 rounded">contactName</code> /{' '}
          <code className="bg-gray-100 px-1.5 py-0.5 rounded">email</code> /{' '}
          <code className="bg-gray-100 px-1.5 py-0.5 rounded">phone</code>.
        </>
      }
    />
  );
}
