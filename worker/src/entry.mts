import './index.ts';

// The worker runtime expects a default export for ES module workers.
// This file acts as a lightweight adapter so the main code can remain a
// plain script (no exports) while still supporting module worker deployment.

export default {
  async fetch(request: Request, env: any, ctx: any) {
    // The underlying logic is attached to globalThis by src/index.ts.
    return (globalThis as any).handleRequest(request, env, ctx);
  },
  async scheduled(event: any, env: any, ctx: any) {
    return (globalThis as any).scheduledHandler(event, env, ctx);
  },
  async queue(batch: any, env: any, ctx: any) {
    return (globalThis as any).queue(batch, env, ctx);
  },
};

export const __testables = (globalThis as any).__testables;
export const BASE_URL = (globalThis as any).BASE_URL;
export const buildArticleUrl = (globalThis as any).buildArticleUrl;
export const TODAY_RSS_LIMIT = (globalThis as any).TODAY_RSS_LIMIT;
