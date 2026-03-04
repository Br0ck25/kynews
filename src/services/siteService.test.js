import SiteService, { mapWorkerArticleToPost } from './siteService';

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

  it('maps isKentucky correctly and preserves it even when no county', async () => {
    const service = new SiteService();
    const articleData = { id: 6, slug: 'abc', category: 'today', isKentucky: true, county: '' };
    global.fetch.mockResolvedValue(makeResponse({ item: articleData }));

    const post = await service.getPostBySlug('abc');
    expect(post.isKentucky).toBe(true);
    expect(post.county).toBe('');
  });

  it('handles boolean isNational flag when mapping single post', async () => {
    const service = new SiteService();
    const articleData = { id: 8, slug: 'bool', category: '', isNational: true };
    global.fetch.mockResolvedValue(makeResponse({ item: articleData }));

    const post = await service.getPostBySlug('bool');
    expect(post.isNational).toBe(true);
  });

  it('getPosts string argument defaults to category all', async () => {
    const service = new SiteService('https://api.example');
    global.fetch.mockResolvedValue(makeResponse({ items: [] }));

    await service.getPosts('something');
    const [[url]] = global.fetch.mock.calls;
    expect(url).toContain('/api/articles/all?');
  });

  it('maps counties array from worker response into post.tags', async () => {
    const service = new SiteService();
    const articleData = {
      id: 7,
      slug: 'abc',
      county: 'Boone',
      counties: ['Boone', 'Campbell'],
    };
    global.fetch.mockResolvedValue(makeResponse({ item: articleData }));

    const post = await service.getPostBySlug('abc');
    expect(post.tags).toEqual(['Boone', 'Campbell']);
  });

  it('getPosts object with search but no category also uses all', async () => {
    const service = new SiteService('https://api.example');
    global.fetch.mockResolvedValue(makeResponse({ items: [] }));

    await service.getPosts({ search: 'foo', limit: 5 });
    const [[url]] = global.fetch.mock.calls;
    expect(url).toContain('/api/articles/all?');
  });

  it('getPosts includes national category when articles carry is_national flag', async () => {
    const service = new SiteService();
    // prevent automatic dev seeding (which would retry the same Response)
    service.devSeedAttempted = true;
    const articles = [{ id: 20, category: '', is_national: 1 }];
    global.fetch.mockResolvedValue(makeResponse({ items: articles }));

    const result = await service.getPosts();
    // getPosts returns the posts array directly
    expect(result[0].categories).toEqual(['national']);
  });

  it('getPosts omits limit parameter when the caller does not specify one', async () => {
    const service = new SiteService('https://api.example');
    global.fetch.mockResolvedValue(makeResponse({ items: [] }));

    await service.getPosts({ search: 'foo' });
    const [[url]] = global.fetch.mock.calls;
    expect(url).toContain('/api/articles/all?');
    expect(url).not.toContain('limit=');
  });

  it('explicit category all is not overwritten by allowed-category check', async () => {
    const service = new SiteService('https://api.example');
    // avoid seeding retry path
    service.devSeedAttempted = true;
    global.fetch.mockResolvedValue(makeResponse({ items: [] }));

    await service.getPosts({ category: 'all', limit: 3 });
    const [[url]] = global.fetch.mock.calls;
    expect(url).toContain('/api/articles/all');
  });

  describe('mapWorkerArticleToPost category mapping', () => {
    it('includes national when flag is set and category blank', () => {
      const articleData = { id: 10, category: '', is_national: 1 };
      const post = mapWorkerArticleToPost(articleData);
      expect(post.categories).toEqual(['national']);
    });

    it('does not duplicate national when category already national', () => {
      const articleData = { id: 11, category: 'national', is_national: 1 };
      const post = mapWorkerArticleToPost(articleData);
      expect(post.categories).toEqual(['national']);
    });

    it('preserves explicit category alongside national flag', () => {
      const articleData = { id: 12, category: 'sports', is_national: 1 };
      const post = mapWorkerArticleToPost(articleData);
      expect(post.categories).toEqual(['sports', 'national']);
    });

    it('also works when worker returns boolean isNational field', () => {
      const articleData = { id: 13, category: '', isNational: true };
      const post = mapWorkerArticleToPost(articleData);
      expect(post.categories).toEqual(['national']);
    });
  });
});
