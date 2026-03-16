import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  // loadEnv reads .env files so we can bake VITE_* values into the bundle
  // via the define option.  This fixes the issue where Vite replaces
  // `process.env` with a literal `{}` at build time, making any
  // process.env.REACT_APP_* references undefined at runtime.
  const env = loadEnv(mode, process.cwd(), '');
  return {
  define: {
    'process.env.PUBLIC_URL': JSON.stringify(''),
    'process.env.REACT_APP_VAPID_PUBLIC_KEY': JSON.stringify(env.VITE_VAPID_PUBLIC_KEY || ''),
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
  };
});
