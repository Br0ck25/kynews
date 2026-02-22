import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "prompt",
      includeAssets: ["favicon.svg", "logo.png"],
      manifest: {
        name: "Kentucky News",
        short_name: "Kentucky News",
        description: "Curated RSS reader (Feedly-style) — local device state, no accounts.",
        theme_color: "#ffffff",
        background_color: "#f3f4f6",
        display: "standalone",
        start_url: "/",
        icons: [
          { src: "/logo.png", sizes: "1024x1024", type: "image/png", purpose: "any maskable" }
        ]
      },
      workbox: {
        navigateFallback: "/index.html",
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.startsWith("/api/"),
            handler: "NetworkFirst",
            options: {
              cacheName: "api-cache",
              expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 } // 1h
            }
          },
          {
            urlPattern: ({ request }) => request.destination === "image",
            handler: "StaleWhileRevalidate",
            options: {
              cacheName: "image-cache",
              expiration: { maxEntries: 300, maxAgeSeconds: 60 * 60 * 24 * 7 } // 7d
            }
          }
        ]
      }
    })
  ],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": "http://localhost:8787"
    }
  }
});
