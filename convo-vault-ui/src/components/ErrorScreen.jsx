import React from 'react';
import { OAUTH_AUTHORIZE_URL, buildMarketplaceUrl } from '../constants/api';

export default function ErrorScreen({ error }) {
  // Convert error object to string if needed
  const errorString = typeof error === 'string' ? error : (error?.message || error?.details || String(error));
  
  const isNotConnected = errorString && errorString.includes('not connected');
  const isInstallRequired = errorString === 'INSTALL_REQUIRED';
  const isRefreshRequired = errorString === 'REFRESH_REQUIRED';
  const isTokenExpired = errorString && (
    errorString.includes('token expired') ||
    errorString.includes('authentication has expired') ||
    errorString.includes('Authentication failed') ||
    errorString.includes('Please reconnect') ||
    errorString.includes('Company token expired')
  );

  const needsReconnect = isNotConnected || isInstallRequired || isTokenExpired;

  if (isRefreshRequired) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-lg shadow-lg p-8 max-w-md w-full text-center">
          <div className="text-5xl mb-4">🔄</div>
          <h2 className="text-2xl font-bold text-gray-800 mb-2">Page Load Issue</h2>
          <p className="text-gray-600 mb-6">
            We couldn't load the app properly. Please refresh the page to try again.
          </p>
          <button
            onClick={() => window.location.reload()}
            className="w-full px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-semibold text-lg"
          >
            🔄 Refresh Page
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow-lg p-8 max-w-2xl w-full">
        <div className="text-center">
          <div className="text-5xl mb-4">
            {isTokenExpired ? '🔐' : isInstallRequired ? '📦' : '⚠️'}
          </div>
          <h2 className="text-2xl font-bold text-gray-800 mb-2">
            {isTokenExpired
              ? 'Authentication Expired'
              : isInstallRequired
                ? 'App Not Installed'
                : 'Connection Error'
            }
          </h2>
          <p className="text-gray-600 mb-6">
            {isTokenExpired
              ? 'Your authentication session has expired. Please reconnect the app to continue.'
              : isInstallRequired
                ? 'ExportKit is not installed in this sub-account. Please install the app first.'
                : errorString
            }
          </p>
          
          {needsReconnect ? (
            <div className="text-left space-y-4">
              <div className="bg-gradient-to-br from-purple-50 to-blue-50 border-2 border-purple-200 rounded-xl p-6">
                <h3 className="font-bold text-purple-900 mb-4 text-lg">
                  {isTokenExpired ? '🔐 Reconnection Required' : '📌 Installation Required'}
                </h3>
                <ol className="list-decimal list-inside space-y-3 text-sm text-purple-900">
                  <li className="font-medium">
                    <strong>{isTokenExpired ? 'Reconnect' : 'Install'} ExportKit via OAuth:</strong>
                    <br />
                    <a
                      href={buildMarketplaceUrl()}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-block mt-2 px-6 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors font-semibold"
                    >
                      {isTokenExpired ? '🔄 Reconnect Your Account' : '🔐 Connect Your Sub-Account'}
                    </a>
                  </li>
                  <li className="mt-3">Login to your account and select a sub-account to connect</li>
                  <li>After successful {isTokenExpired ? 'reconnection' : 'installation'}, refresh this page</li>
                  <li>Find "ExportKit" in your sub-account's left sidebar to access</li>
                </ol>
              </div>

              <div className="bg-yellow-50 border-2 border-yellow-200 rounded-lg p-4 text-sm">
                <p className="font-semibold mb-2 text-yellow-900">⚠️ Important:</p>
                <p className="text-yellow-800">
                  {isTokenExpired 
                    ? 'Your authentication has expired. Please reconnect the app to restore access. This is a security measure to protect your data.'
                    : 'This app must be installed via OAuth before it can be used. After installation, it will appear as "ExportKit" in your sub-account navigation menu.'
                  }
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-2 text-sm text-left bg-gray-50 p-4 rounded">
              <p className="font-semibold">Please ensure:</p>
              <ul className="list-disc list-inside space-y-1 text-gray-600">
                <li>The app is properly installed</li>
              </ul>
            </div>
          )}
          
          <div className="flex gap-3 mt-6">
            {!needsReconnect && (
              <button
                onClick={() => window.location.reload()}
                className="flex-1 px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium"
              >
                🔄 Retry
              </button>
            )}
            {needsReconnect && (
              <a
                href={buildMarketplaceUrl()}
                target="_blank"
                rel="noopener noreferrer"
                className="flex-1 px-6 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors text-center font-medium"
              >
                {isTokenExpired ? '🔄 Reconnect App' : '📦 Install ExportKit'}
              </a>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

