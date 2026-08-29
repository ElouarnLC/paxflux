import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './app/App.js';
import { initOfflineSyncEngine } from './offline/retry.js';
import './styles/index.css';

// Initialize offline sync engine (event listeners, reconnect, backoff)
initOfflineSyncEngine();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
