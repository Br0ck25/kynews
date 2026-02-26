// Polyfill for process.env when running under Vite dev server
// Legacy CRA code references `process.env` heavily; Vite does not
// provide a `process` global by default which leads to "ReferenceError: process is not defined".
//
// This shim ensures `process.env` always exists in the browser and
// mirrors a few values from `import.meta.env` (Vite's preferred mechanism).
// It's intentionally lightweight and avoids introducing any real
// logic beyond environment variable mapping.  Tests running under Node
// already have `process.env`, so this file is safe to import there too.

(function () {
  // create `process` global if missing
  if (typeof process === 'undefined') {
    // eslint-disable-next-line no-undef, no-global-assign
    window.process = { env: {} };
  } else if (!process.env) {
    process.env = {};
  }

  const env = typeof import.meta !== 'undefined' && import.meta.env ? import.meta.env : {};

  // copy some common values so legacy code continues to work
  if (env.VITE_API_BASE_URL !== undefined) {
    process.env['REACT_APP_API_BASE_URL'] = env.VITE_API_BASE_URL;
  }
  if (env.MODE !== undefined) {
    // use bracket syntax so Vite's constant-replacement doesn’t turn the
    // left-hand side into a literal string (which would cause a syntax
    // error when we later try to assign to it in dev).
    process.env['NODE_ENV'] = env.MODE;
  }
  if (env.BASE_URL !== undefined) {
    process.env['PUBLIC_URL'] = env.BASE_URL;
  }
})();
