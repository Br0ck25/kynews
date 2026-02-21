import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../src/index';

// For now, you'll need to do something like this to get a correctly-typed
// `Request` to pass to `worker.fetch()`.
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe('EKY News worker', () => {
	it('responds with health payload (unit style)', async () => {
		const request = new IncomingRequest('http://example.com/api/health');
		// Create an empty context to pass to `worker.fetch()`.
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		// Wait for all `Promise`s passed to `ctx.waitUntil()` to settle before running test assertions
		await waitOnExecutionContext(ctx);
		const data = await response.json();
		expect(response.status).toBe(200);
		expect(data.ok).toBe(true);
		expect(typeof data.now).toBe('string');
	});

	it('responds with health payload (integration style)', async () => {
		const response = await SELF.fetch('https://example.com/api/health');
		const data = await response.json();
		expect(response.status).toBe(200);
		expect(data.ok).toBe(true);
	});
});
