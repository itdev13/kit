import apiClient from './client';
import { API_URL } from '../constants/api';

export const importAPI = {
  /**
   * Upload CSV/Excel file
   */
  upload: async (file, locationId) => {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('locationId', locationId);

    const response = await apiClient.post('/import/upload', formData, {
      headers: {
        'Content-Type': 'multipart/form-data'
      },
      timeout: 30000 // 30 second timeout for upload
    });
    return response;
  },

  /**
   * Get import job status
   */
  getStatus: async (jobId) => {
    const response = await apiClient.get(`/import/status/${jobId}`);
    return response;
  },

  /**
   * Get recent import jobs
   */
  getJobs: async (locationId) => {
    const response = await apiClient.get('/import/jobs', {
      params: { locationId }
    });
    return response;
  },

  /**
   * Import notes from parsed CSV rows
   */
  importNotes: async (locationId, rows, fileName) => {
    const response = await apiClient.post('/import/notes', { locationId, rows, fileName });
    return response;
  },

  /**
   * Import contacts from parsed CSV rows
   */
  importContacts: async (locationId, rows, fileName) => {
    const response = await apiClient.post('/import/contacts', { locationId, rows, fileName });
    return response;
  },

  /**
   * Import custom fields from parsed CSV rows
   */
  importCustomFields: async (locationId, rows, fileName) => {
    const response = await apiClient.post('/import/custom-fields', { locationId, rows, fileName });
    return response;
  },

  /**
   * Import custom values from parsed CSV rows
   */
  importCustomValues: async (locationId, rows, fileName) => {
    const response = await apiClient.post('/import/custom-values', { locationId, rows, fileName });
    return response;
  },

  /**
   * Import opportunities from parsed CSV rows
   */
  importOpportunities: async (locationId, rows, fileName) => {
    const response = await apiClient.post('/import/opportunities', { locationId, rows, fileName });
    return response;
  },

  /**
   * Import tasks from parsed CSV rows
   */
  importTasks: async (locationId, rows, fileName) => {
    const response = await apiClient.post('/import/tasks', { locationId, rows, fileName });
    return response;
  },

  /**
   * Download CSV template
   */
  downloadTemplate: async () => {
    const token = localStorage.getItem('sessionToken');
    
    const response = await fetch(`${API_URL}/import/template`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });
    
    if (!response.ok) {
      throw new Error('Failed to download template');
    }
    
    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'import_template.csv';
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(url);
    document.body.removeChild(a);
  }
};

