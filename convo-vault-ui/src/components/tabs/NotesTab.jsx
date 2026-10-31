import React, { useState, useEffect } from 'react';
import { useAuth } from '../../context/AuthContext';
import { billingAPI } from '../../api/billing';
import { contactsAPI } from '../../api/contacts';
import { Button, Input, message as antMessage, Spin } from 'antd';
import ExportEstimateModal from '../ExportEstimateModal';
import ExportProgress from '../ExportProgress';

/**
 * Notes By Tag — export notes for every contact carrying a given tag. On export we resolve ALL
 * contacts matching the tag, then the Lambda walks each contact's notes. Priced per note
 * ($0.018/note). For a contact-free, location-wide notes search use the "Notes" tab (notesSearch).
 */
export default function NotesTab() {
  const { location } = useAuth();

  // Export state
  const [exportModalVisible, setExportModalVisible] = useState(false);
  const [estimating, setEstimating] = useState(false);
  const [estimate, setEstimate] = useState(null);
  const [estimateError, setEstimateError] = useState(null);
  const [postExportBilling, setPostExportBilling] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [activeJob, setActiveJob] = useState(null);
  // Resolved contactIds from estimate (for tag-based exports — avoids re-resolving)
  const [resolvedFromEstimate, setResolvedFromEstimate] = useState(null);

  // Tag filter
  const [tagFilter, setTagFilter] = useState('');
  const [tagContacts, setTagContacts] = useState([]); // contacts found by tag (preview)
  const [tagSearching, setTagSearching] = useState(false);

  // Notes results — flat list with contactName attached (preview only)
  const [notes, setNotes] = useState([]);
  const [notesLoading, setNotesLoading] = useState(false);
  const [notesLoaded, setNotesLoaded] = useState(false);

  const getContactName = (c) =>
    c?.contactName || `${c?.firstName || ''} ${c?.lastName || ''}`.trim() || 'Unknown';

  // Tag search: find contacts by tag, fetch their notes for preview
  const handleTagSearch = async () => {
    const tag = tagFilter.trim();
    if (!tag) return;
    setTagSearching(true);
    setNotesLoading(true);
    setNotesLoaded(false);
    setNotes([]);
    setTagContacts([]);
    try {
      const res = await contactsAPI.searchByTag(location.id, tag, 10);
      if (res.success) {
        const contacts = res.data.contacts || [];
        setTagContacts(contacts);
        if (contacts.length > 0) {
          const results = await Promise.all(
            contacts.map(contact => {
              const name = getContactName(contact);
              return contactsAPI.fetchNotes(location.id, contact.id)
                .then(res2 => (res2.success ? res2.data.notes || [] : []).map(n => ({ ...n, _contactName: name, _contactEmail: contact.email || contact.phone, _contactId: contact.id })))
                .catch(() => []);
            })
          );
          setNotes(results.flat());
        }
        setNotesLoaded(true);
      }
    } catch (err) {
      antMessage.error('Failed to search contacts by tag');
    } finally {
      setTagSearching(false);
      setNotesLoading(false);
    }
  };

  const clearTagFilter = () => {
    setTagFilter('');
    setTagContacts([]);
    setNotes([]);
    setNotesLoaded(false);
  };

  // Poll active job
  useEffect(() => {
    if (!activeJob || !['pending', 'processing'].includes(activeJob.status)) return;
    const interval = setInterval(async () => {
      try {
        const res = await billingAPI.getExportStatus(activeJob.jobId, location?.id);
        if (res.success) {
          setActiveJob(res.data);
          if (res.data.status === 'completed') antMessage.success('Export completed! Click Download to get your file.');
        }
      } catch (err) { /* silent */ }
    }, 5000);
    return () => clearInterval(interval);
  }, [activeJob?.jobId, activeJob?.status, location?.id]);

  const getFilters = () => ({ tags: tagFilter.trim() });

  // For export: use resolved contactIds from estimate if available (avoids re-resolving tags)
  const getExportFilters = () => {
    if (resolvedFromEstimate) {
      const ids = resolvedFromEstimate.contactIds;
      const names = resolvedFromEstimate.contactNames;
      const meta = resolvedFromEstimate.contactsMeta || {};
      if (ids.length === 1) return { contactId: ids[0], contactNames: names, contactsMeta: meta };
      return { contactIds: ids, contactNames: names, contactsMeta: meta };
    }
    return getFilters();
  };

  const handleGetEstimate = async () => {
    if (!isTagMode) {
      antMessage.warning('Please enter a tag to export');
      return;
    }
    setExportModalVisible(true);
    setEstimating(true);
    setEstimate(null);
    setEstimateError(null);
    setPostExportBilling(false);
    setResolvedFromEstimate(null);
    try {
      // Resolve ALL contacts for the tag and count notes server-side.
      const res = await billingAPI.getEstimate(location.id, 'notes', getFilters());
      if (res.success) {
        setEstimate(res.data.estimate);
        if (res.data.resolvedContactIds) {
          setResolvedFromEstimate({
            contactIds: res.data.resolvedContactIds,
            contactNames: res.data.resolvedContactNames,
            contactsMeta: res.data.resolvedContactsMeta || {}
          });
        }
      } else {
        setEstimateError(res.error || 'Failed to calculate estimate');
      }
    } catch (err) {
      setEstimateError(err.message || 'Failed to calculate estimate');
    } finally {
      setEstimating(false);
    }
  };

  const handlePayAndExport = async (notificationEmail, format = 'csv') => {
    setProcessing(true);
    setEstimateError(null);
    try {
      const exportFilters = getExportFilters();
      // Pass the note count from estimate so backend doesn't re-count
      if (estimate?.itemCounts?.notes) {
        exportFilters.estimatedNoteCount = estimate.itemCounts.notes;
      }
      const res = await billingAPI.chargeAndExport(location.id, 'notes', format, exportFilters, notificationEmail);
      if (res.success) {
        setActiveJob({
          jobId: res.data.jobId,
          status: res.data.status,
          totalItems: res.data.totalItems,
          progress: { total: res.data.totalItems, processed: 0, percent: 0 }
        });
        setExportModalVisible(false);
        setEstimate(null);
        antMessage.success("Export started! We'll notify you by email when it's ready.");
      } else {
        setEstimateError(res.error || 'Export failed');
      }
    } catch (err) {
      setEstimateError(err.code === 'INSUFFICIENT_FUNDS' ? err : (err.message || 'Export failed'));
    } finally {
      setProcessing(false);
    }
  };

  const handleModalClose = () => {
    if (!processing) { setExportModalVisible(false); setEstimate(null); setEstimateError(null); setPostExportBilling(false); }
  };

  const formatDate = (val) => {
    if (!val) return '—';
    try { return new Date(val).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
    catch { return '—'; }
  };

  const isExporting = activeJob && ['pending', 'processing'].includes(activeJob.status);
  const isTagMode = tagFilter.trim().length > 0;

  return (
    <div className="space-y-6">
      <ExportEstimateModal
        visible={exportModalVisible}
        onCancel={handleModalClose}
        onConfirm={handlePayAndExport}
        loading={processing}
        estimating={estimating}
        estimate={estimate}
        error={estimateError}
        exportType="notes"
        postExportBilling={postExportBilling}
        estimatingMessage="Finding all contacts for this tag and counting notes... This may take a moment, please stay with us!"
      />

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Notes By Tag</h2>
          <p className="text-sm text-gray-500 mt-1">
            {isTagMode
              ? `Filtering by tag: "${tagFilter.trim()}"`
              : 'Enter a tag to export notes for every contact carrying it'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {notesLoaded && notes.length > 0 && (
            <div className="bg-blue-50 border border-blue-200 rounded-lg px-4 py-2 text-center mr-1">
              <div className="text-xl font-bold text-blue-700">{notes.length}</div>
              <div className="text-xs text-blue-500">Notes Found</div>
            </div>
          )}
          <Button
            onClick={handleGetEstimate}
            disabled={isExporting || !isTagMode}
            size="large"
            type="primary"
            icon={
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
            }
          >
            Export Notes by Tag
          </Button>
        </div>
      </div>

      {/* Active Export Progress */}
      {activeJob && (
        <ExportProgress
          job={activeJob}
          onRefresh={() => {
            billingAPI.getExportStatus(activeJob.jobId, location?.id)
              .then(res => res.success && setActiveJob(res.data))
              .catch(console.error);
          }}
        />
      )}

      {/* Tag Filter */}
      <div className="bg-white border border-gray-200 rounded-xl p-5">
        <div className="flex items-center gap-2 mb-4">
          <svg className="w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
          </svg>
          <span className="text-sm font-semibold text-gray-700">Tag Filter</span>
        </div>

        <label className="block text-xs font-medium text-gray-600 mb-1">
          Tag <span className="text-gray-400">(find contacts by tag)</span>
        </label>
        <div className="flex gap-2">
          <Input
            placeholder="Enter tag to find contacts..."
            size="large"
            value={tagFilter}
            onChange={(e) => setTagFilter(e.target.value)}
            onPressEnter={handleTagSearch}
          />
          <Button
            onClick={handleTagSearch}
            disabled={!tagFilter.trim() || tagSearching}
            size="large"
            loading={tagSearching}
            icon={
              !tagSearching && (
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
              )
            }
          >
            Search
          </Button>
          {tagFilter && (
            <Button onClick={clearTagFilter} size="large">Clear</Button>
          )}
        </div>
        {tagContacts.length > 0 && (
          <p className="mt-2 text-xs text-green-700 bg-green-50 border border-green-200 rounded px-3 py-2">
            Showing notes from top {tagContacts.length} contacts with this tag. On export, we'll find <strong>all</strong> contacts matching this tag and calculate the exact pricing.
          </p>
        )}
        {isTagMode && (
          <p className="text-xs text-green-700 bg-green-50 border border-green-200 rounded px-3 py-2 mt-3">
            <strong>Export by Tag:</strong> Will find all contacts with tag "{tagFilter.trim()}" and export their notes.
          </p>
        )}
      </div>

      {/* Notes Results (preview) */}
      {notesLoading ? (
        <div className="bg-white border border-gray-200 rounded-xl p-12 flex items-center justify-center gap-3">
          <Spin />
          <span className="text-gray-400 text-sm">
            Loading notes for contacts with tag "{tagFilter.trim()}"...
          </span>
        </div>
      ) : notesLoaded && (
        notes.length === 0 ? (
          <div className="bg-white border border-gray-200 rounded-xl p-12 flex flex-col items-center justify-center text-center gap-3">
            <div className="w-14 h-14 bg-gray-100 rounded-full flex items-center justify-center">
              <svg className="w-7 h-7 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
              </svg>
            </div>
            <div>
              <p className="text-sm font-semibold text-gray-600">No notes found</p>
              <p className="text-xs text-gray-400 mt-1">No contacts with this tag have notes yet</p>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {notes.map((note, i) => (
              <div key={note.id || i} className="bg-white border border-gray-200 rounded-xl p-5 hover:border-blue-200 transition-colors">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-start gap-3 flex-1 min-w-0">
                    <div className="w-8 h-8 bg-blue-50 border border-blue-100 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5">
                      <svg className="w-4 h-4 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                      </svg>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-xs font-semibold text-blue-600">{note._contactName}</span>
                        {note._contactEmail && <span className="text-xs text-gray-400">{note._contactEmail}</span>}
                      </div>
                      <p className="text-sm text-gray-800 whitespace-pre-wrap">{note.body || note.bodyText || '(empty note)'}</p>
                    </div>
                  </div>
                  <div className="text-xs text-gray-400 flex-shrink-0 text-right">
                    <div>{formatDate(note.dateAdded)}</div>
                    {note.userId && <div className="mt-1 text-gray-300">by {note.userId}</div>}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )
      )}

      {/* CSV Columns Info */}
      <div className="bg-white border border-gray-200 rounded-xl p-6">
        <h3 className="text-sm font-semibold text-gray-700 mb-3">Export Columns</h3>
        <div className="flex flex-wrap gap-2">
          {['NoteID', 'ContactID', 'ContactName', 'ContactEmail', 'ContactPhone', 'Body', 'BodyText', 'UserID', 'DateAdded', 'Relations'].map((col) => (
            <span key={col} className="px-3 py-1 bg-gray-100 text-gray-700 text-xs font-mono rounded-full">
              {col}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
