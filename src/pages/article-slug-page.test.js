// ensure FB app id constant is populated
process.env.REACT_APP_FB_APP_ID = 'testid';
import React from 'react';
import { render, waitFor } from '@testing-library/react';
import { MemoryRouter, Route } from 'react-router-dom';
import { Provider } from 'react-redux';
import { createStore } from 'redux';
import SiteService from '../services/siteService';
import ArticleSlugPage from './article-slug-page';

// helpers for metadata
function getMeta(name, attr = 'property') {
  const el = document.querySelector(`meta[${attr}="${name}"]`);
  return el ? el.getAttribute('content') : null;
}

function renderArticleSlugPage(post) {
  const store = createStore((state = {}) => state);
  render(
    <Provider store={store}>
      <MemoryRouter
        initialEntries={[{ pathname: `/news/kentucky/boone-county/${post.slug}`, state: { post } }]}
      >
        <Route path="/news/kentucky/:countySlug/:articleSlug">
          <ArticleSlugPage />
        </Route>
      </MemoryRouter>
    </Provider>
  );
}

describe('ArticleSlugPage metadata', () => {
  beforeEach(() => {
    document.head.innerHTML = ''; // clear any previous tags
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('adds absolute og:image when article has no image', async () => {
    const post = {
      title: 'No Image Title',
      slug: 'test-slug',
      seoDescription: 'seo desc',
      shortDesc: 'short',
      categories: [],
    };
    jest.spyOn(SiteService.prototype, 'getPostBySlug').mockResolvedValue(post);

    renderArticleSlugPage(post);

    await waitFor(() => {
      expect(getMeta('og:image')).toBe('https://localkynews.com/img/preview.png');
      expect(getMeta('fb:app_id')).toBe('testid');
      expect(getMeta('robots', 'name')).toBe('noindex,follow');
      // JSON-LD should include our site as publisher and retain original name
      const json = document.getElementById('json-ld-article')?.textContent || '';
      expect(json).toContain('"publisher":');
      expect(json).toContain('Local KY News');
      expect(json).toContain('"sourceOrganization"');
      // alternate plain-text link should exist
      const alt = document.querySelector('link[rel="alternate"][type="text/plain"]');
      expect(alt).toBeTruthy();
      expect(alt.getAttribute('href')).toContain('?format=text');
    });
  });

  it('sets og:image to the article image URL when post.image is set', async () => {
    const post = {
      title: 'Test',
      slug: 'test-slug',
      image: 'https://example.com/photo.jpg',
      seoDescription: 'desc',
      categories: [],
      rawWordCount: 200,
    };
    jest.spyOn(SiteService.prototype, 'getPostBySlug').mockResolvedValue(post);

    renderArticleSlugPage(post);

    await waitFor(() => {
      expect(getMeta('og:image')).toBe('https://example.com/photo.jpg');
      expect(getMeta('og:image:width')).toBe('1200');
      expect(getMeta('og:image:height')).toBe('630');
    });
  });

  it('sets robots meta to max-snippet for intermediate word counts', async () => {
    const post = {
      title: 'Medium Word Count Title',
      slug: 'medium-word-count',
      seoDescription: 'seo desc',
      shortDesc: 'short',
      categories: [],
      rawWordCount: 50,
    };
    jest.spyOn(SiteService.prototype, 'getPostBySlug').mockResolvedValue(post);

    renderArticleSlugPage(post);

    await waitFor(() => {
      expect(getMeta('robots', 'name')).toBe('index,follow,max-snippet:160');
    });
  });

  it('sets robots meta to index for articles with sufficient word count', async () => {
    const post = {
      title: 'High Word Count Title',
      slug: 'high-word-count',
      seoDescription: 'seo desc',
      shortDesc: 'short',
      categories: [],
      rawWordCount: 150,
    };
    jest.spyOn(SiteService.prototype, 'getPostBySlug').mockResolvedValue(post);

    renderArticleSlugPage(post);

    await waitFor(() => {
      expect(getMeta('robots', 'name')).toBe('index,follow');
    });
  });
});
