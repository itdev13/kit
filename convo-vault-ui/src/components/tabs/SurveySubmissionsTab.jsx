import SimpleExportTab from './SimpleExportTab';

const COLUMNS = ['SubmissionID', 'SurveyID', 'ContactID', 'Name', 'Email', 'CreatedAt', 'OtherFields'];

export default function SurveySubmissionsTab() {
  return (
    <SimpleExportTab
      exportType="surveySubmissions"
      title="Surveys"
      subtitle="Export all survey submissions from this sub-account"
      buttonLabel="Export Surveys"
      unit="submission"
      icon="📝"
      columns={COLUMNS}
    />
  );
}
