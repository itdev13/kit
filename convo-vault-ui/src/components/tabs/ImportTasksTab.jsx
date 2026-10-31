import SimpleImportTab from './SimpleImportTab';
import { importAPI } from '../../api/import';

const columns = [
  { title: 'Title', dataIndex: 'title', key: 'title', width: 200, ellipsis: true,
    render: (v, r) => v || r.Title || r.taskTitle || '—' },
  { title: 'Body', dataIndex: 'body', key: 'body', width: 220, ellipsis: true,
    render: (v, r) => v || r.Body || r.description || r.Description || '—' },
  { title: 'Due Date', dataIndex: 'dueDate', key: 'dueDate', width: 140, ellipsis: true,
    render: (v, r) => v || r.DueDate || r.due_date || '—' },
  { title: 'Contact', dataIndex: 'contactName', key: 'contactName', width: 160, ellipsis: true,
    render: (v, r) => v || r.ContactName || r.email || r.Email || '—' },
  { title: 'Completed', dataIndex: 'completed', key: 'completed', width: 100,
    render: (v, r) => v || r.Completed || '—' },
];

export default function ImportTasksTab() {
  return (
    <SimpleImportTab
      title="Import Tasks"
      subtitle="Upload a CSV to bulk-create contact tasks. Contacts are matched by email or phone, or created if new."
      importType="importTasks"
      itemCountKey="tasks"
      requiredColAliases={['title', 'Title', 'taskTitle']}
      previewColumns={columns}
      doImport={importAPI.importTasks}
      requiredHint={
        <>
          Required: a task <code className="bg-gray-100 px-1.5 py-0.5 rounded">title</code>. Optional:{' '}
          <code className="bg-gray-100 px-1.5 py-0.5 rounded">body</code>,{' '}
          <code className="bg-gray-100 px-1.5 py-0.5 rounded">dueDate</code>,{' '}
          <code className="bg-gray-100 px-1.5 py-0.5 rounded">completed</code>,{' '}
          <code className="bg-gray-100 px-1.5 py-0.5 rounded">assignedTo</code>, and contact fields{' '}
          <code className="bg-gray-100 px-1.5 py-0.5 rounded">contactName</code> /{' '}
          <code className="bg-gray-100 px-1.5 py-0.5 rounded">email</code> /{' '}
          <code className="bg-gray-100 px-1.5 py-0.5 rounded">phone</code> /{' '}
          <code className="bg-gray-100 px-1.5 py-0.5 rounded">contactId</code>.
        </>
      }
    />
  );
}
