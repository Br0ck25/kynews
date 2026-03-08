// ensure FB app id constant is populated
process.env.REACT_APP_FB_APP_ID = 'testid';
import React from 'react';
import { render, waitFor } from '@testing-library/react';
import { MemoryRouter, Route } from 'react-router-dom';
import ArticleSlugPage from './article-slug-page';

// helpers for metadata
function getMeta(name, attr = 'property') {
  const el = document.querySelector(`meta[${attr}="${name}"]`);
  return el ? el.getAttribute('content') : null;
}

describe('ArticleSlugPage metadata', () => {
  beforeEach(() => {
    document.head.innerHTML = ''; // clear any previous tags
  });

  it('adds absolute og:image when article has no image', async () => {
    const post = {
      title: 'No Image Title',
      slug: 'test-slug',
      seoDescription: 'seo desc',
      shortDesc: 'short',
      categories: [],
    };

    render(
      <MemoryRouter
        initialEntries={[{ pathname: '/news/kentucky/boone-county/test-slug', state: { post } }]}
      >
        <Route path="/news/kentucky/:countySlug/:articleSlug">
          <ArticleSlugPage />
        </Route>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(getMeta('og:image')).toBe('https://localkynews.com/img/preview.png');
      expect(getMeta('fb:app_id')).toBe('testid');
      // JSON-LD should include our site as publisher and retain original name
      const json = document.getElementById('json-ld-article')?.textContent || '';
      expect(json).toContain('"publisher":');
      expect(json).toContain('Local KY News');
      expect(json).toContain('"sourceOrganization"');
    });
  });
});
