import SiteService from './siteService';

// helpers for constructing fetch responses easily
function makeResponse(body, options = {}) {
  const init = {
    status: options.status || 200,
    headers: options.headers || {},
  };
  return new Response(
    typeof body === 'string' ? body : JSON.stringify(body),
    init
  );
}

describe('SiteService.request', () => {
  const ORIGINAL_FETCH = global.fetch;
  beforeEach(() => {
    global.fetch = jest.fn();
  });
  afterEach(() => {
    global.fetch = ORIGINAL_FETCH;
    jest.clearAllMocks();
  });

  it('does not add a Content-Type header for GET requests', async () => {
    const service = new SiteService('https://api.host');
    global.fetch.mockResolvedValue(makeResponse({ ok: true }));

    await service.request('/foo');
    const [[url, opts]] = global.fetch.mock.calls;
    expect(opts.headers).not.toHaveProperty('Content-Type');
  });

  it('adds Content-Type header for POST requests', async () => {
    const service = new SiteService('https://api.host');
    global.fetch.mockResolvedValue(makeResponse({ ok: true }));

    await service.request('/foo', { method: 'POST', body: '{}' });
    const [[url, opts]] = global.fetch.mock.calls;
    expect(opts.headers['Content-Type']).toBe('application/json');
  });

  it('does not retry when original response is a 500 JSON error', async () => {
    const service = new SiteService('https://api.host');
    const errorBody = { error: 'oops' };
    global.fetch.mockResolvedValue(makeResponse(errorBody, { status: 500 }));

    await expect(service.request('/api/articles/weather')).rejects.toBeDefined();
    // should not attempt a fallback
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('retries against fallback when first response is HTML/SPA', async () => {
    const service = new SiteService('https://api.host');
    // first call returns HTML
    global.fetch
      .mockResolvedValueOnce(makeResponse('<!doctype html><html></html>', { status: 200, headers: { 'content-type': 'text/html' } }))
      // second call returns good JSON
      .mockResolvedValueOnce(makeResponse({ foo: 'bar' }));

    const data = await service.request('/api/foo');
    expect(data).toEqual({ foo: 'bar' });
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(global.fetch.mock.calls[1][0]).toContain('worker.jamesbrock25.workers.dev');
  });

  it('getPostBySlug includes isNational flag when worker returns is_national', async () => {
    const service = new SiteService();
    const articleData = { id: 5, slug: 'xyz', category: 'weather', is_national: 1 };
    global.fetch.mockResolvedValue(makeResponse({ item: articleData }));

    const post = await service.getPostBySlug('xyz');
    expect(post.isNational).toBe(true);
  });
});
