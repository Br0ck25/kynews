// supply a FB app id so the component will render the tag
process.env.REACT_APP_FB_APP_ID = 'testid';
import React from 'react';
import { render, waitFor } from '@testing-library/react';
import { MemoryRouter, Route } from 'react-router-dom';
import { Provider } from 'react-redux';
import { createStore } from 'redux';
import PostPage from './post-page';

function getMeta(name, attr = 'property') {
  const el = document.querySelector(`meta[${attr}="${name}"]`);
  return el ? el.getAttribute('content') : null;
}

function renderPostPage(post) {
  const store = createStore((state = { post }) => state);
  render(
    <Provider store={store}>
      <MemoryRouter
        initialEntries={[{ pathname: '/post', state: { post } }]}
      >
        <Route path="/post">
          <PostPage />
        </Route>
      </MemoryRouter>
    </Provider>
  );
}

describe('PostPage metadata', () => {
  beforeEach(() => {
    document.head.innerHTML = '';
  });

  it('uses fallback image when post.image is missing', async () => {
    const post = {
      id: 42,
      title: 'Legacy Post',
      seoDescription: 'desc',
      shortDesc: 'short',
      slug: null,
      categories: [],
    };

    renderPostPage(post);

    await waitFor(() => {
      expect(getMeta('og:image')).toBe('https://localkynews.com/img/og-default.png');
      expect(getMeta('fb:app_id')).toBe('testid');
      expect(getMeta('robots', 'name')).toBe('noindex,follow');
      const json = document.getElementById('json-ld-article')?.textContent || '';
      expect(json).toContain('"publisher":');
      expect(json).toContain('Local KY News');
      expect(json).toContain('"sourceOrganization"');
      // speakable spec must be present for voice search
      expect(json).toContain('"speakable"');
      expect(json).toContain('"SpeakableSpecification"');
      const parsed = JSON.parse(json);
      expect(parsed.speakable.cssSelector).toEqual(['h1', '.article-summary']);
    });
  });

  it('sets robots meta to max-snippet for intermediate word counts', async () => {
    const post = {
      id: 42,
      title: 'Legacy Post',
      seoDescription: 'desc',
      shortDesc: 'short',
      slug: null,
      categories: [],
      rawWordCount: 50,
    };

    renderPostPage(post);

    await waitFor(() => {
      expect(getMeta('robots', 'name')).toBe('index,follow,max-snippet:160');
    });
  });

  it('sets robots meta to index for posts with sufficient word count', async () => {
    const post = {
      id: 42,
      title: 'Legacy Post',
      seoDescription: 'desc',
      shortDesc: 'short',
      slug: null,
      categories: [],
      rawWordCount: 150,
    };

    renderPostPage(post);

    await waitFor(() => {
      expect(getMeta('robots', 'name')).toBe('index,follow');
    });
  });
});
