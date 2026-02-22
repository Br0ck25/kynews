import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { HelmetProvider } from "react-helmet-async";
import App from "./ui/App";
import stylesText from "./ui/styles.css?inline";

if (typeof document !== "undefined" && !document.querySelector("style[data-app-styles='1']")) {
  const styleEl = document.createElement("style");
  styleEl.setAttribute("data-app-styles", "1");
  styleEl.textContent = stylesText;
  document.head.appendChild(styleEl);
}

if (typeof window !== "undefined" && "serviceWorker" in navigator) {
  // Clean up old PWA registrations so stale bundles do not keep controlling the app.
  window.addEventListener("load", () => {
    void navigator.serviceWorker.getRegistrations().then((registrations) => {
      for (const registration of registrations) {
        void registration.unregister();
      }
    });

    if ("caches" in window) {
      void caches.keys().then((keys) => {
        for (const key of keys) {
          if (/workbox|pwa|image-cache|api-cache/i.test(key)) {
            void caches.delete(key);
          }
        }
      });
    }
  });
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <HelmetProvider>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </HelmetProvider>
  </React.StrictMode>
);
