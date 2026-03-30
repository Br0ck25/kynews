import { env, createExecutionContext } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import worker from '../src/index';
import { WEATHER_ALERT_AUTOPOST_KEYS } from '../src/lib/weatherAlerts';

function adminEnv(password = 'pw') {
  return {
    ...env,
    ADMIN_PANEL_PASSWORD: password,
  } as any;
}

async function clearSettings() {
  if (!env.CACHE) return;
  await Promise.all(
    Object.values(WEATHER_ALERT_AUTOPOST_KEYS).map((key) => env.CACHE!.delete(key)),
  );
}

describe('weather alert posts auto-post settings endpoints', () => {
  beforeEach(async () => {
    await clearSettings();
  });

  it('reads default disabled settings and saves toggles', async () => {
    const getReq = new Request('https://example.com/api/admin/weather-alert-posts/autopost', {
      headers: { 'x-admin-key': 'pw' },
    });
    const getCtx = createExecutionContext();
    const getResp = await worker.fetch(getReq, adminEnv(), getCtx);
    expect(getResp.status).toBe(200);
    await expect(getResp.json()).resolves.toEqual({
      warnings: false,
      watches: false,
      others: false,
    });

    const postReq = new Request('https://example.com/api/admin/weather-alert-posts/autopost', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-admin-key': 'pw',
      },
      body: JSON.stringify({ warnings: true, others: true }),
    });
    const postCtx = createExecutionContext();
    const postResp = await worker.fetch(postReq, adminEnv(), postCtx);
    expect(postResp.status).toBe(200);
    await expect(postResp.json()).resolves.toMatchObject({
      ok: true,
      warnings: true,
      watches: false,
      others: true,
    });

    const getAgainReq = new Request('https://example.com/api/admin/weather-alert-posts/autopost', {
      headers: { 'x-admin-key': 'pw' },
    });
    const getAgainCtx = createExecutionContext();
    const getAgainResp = await worker.fetch(getAgainReq, adminEnv(), getAgainCtx);
    expect(getAgainResp.status).toBe(200);
    await expect(getAgainResp.json()).resolves.toEqual({
      warnings: true,
      watches: false,
      others: true,
    });
  });
});
