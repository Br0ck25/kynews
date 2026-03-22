// ensure process.env is available during Vite dev (fixes runtime errors)
import './env-shim';

import React from 'react';
import ReactDOM from 'react-dom';
import './index.css';
import App from './App';
import * as serviceWorkerRegistration from './serviceWorkerRegistration';
import reportWebVitals from './reportWebVitals';

ReactDOM.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
  document.getElementById('root')
);

// Service worker caching is disabled here because stale SW/precached assets
// can result in JS chunk mismatch errors (e.g. admin-page-502bebb7.js). See:
// "Failed to fetch dynamically imported module".
serviceWorkerRegistration.unregister();

// If you want to start measuring performance in your app, pass a function
// to log results (for example: reportWebVitals(console.log))
// or send to an analytics endpoint. Learn more: https://bit.ly/CRA-vitals
reportWebVitals((metric) => {
  if (process.env.NODE_ENV === 'development') {
    console.log('[Web Vitals]', metric.name, metric.value);
  }
  // TODO: replace with your analytics endpoint
  // fetch('/api/vitals', { method: 'POST', body: JSON.stringify(metric) });
});
