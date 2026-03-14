import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  define: {
    'process.env.PUBLIC_URL': JSON.stringify(''),
  },
  server: {
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
      },
    },
  },
  esbuild: {
    loader: "jsx",
    // also include .jsx files so import analysis doesn't choke on JSX syntax
    include: /src\/.*\.(js|jsx)$/,
    exclude: [],
  },
  optimizeDeps: {
    esbuildOptions: {
      loader: {
        ".js": "jsx",
        ".jsx": "jsx",
      },
    },
  },
  plugins: [
    react({
      jsxRuntime: "classic",
    }),
  ],
});
