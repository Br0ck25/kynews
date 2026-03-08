// supply a FB app id so the component will render the tag
process.env.REACT_APP_FB_APP_ID = 'testid';
import React from 'react';
import { render, waitFor } from '@testing-library/react';
import { MemoryRouter, Route } from 'react-router-dom';
import PostPage from './post-page';

function getMeta(name, attr = 'property') {
  const el = document.querySelector(`meta[${attr}="${name}"]`);
  return el ? el.getAttribute('content') : null;
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

    render(
      <MemoryRouter
        initialEntries={[{ pathname: '/post', state: { post } }]}
      >
        <Route path="/post">
          <PostPage />
        </Route>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(getMeta('og:image')).toBe('https://localkynews.com/img/preview.png');
      expect(getMeta('fb:app_id')).toBe('testid');
      const json = document.getElementById('json-ld-article')?.textContent || '';
      expect(json).toContain('"publisher":');
      expect(json).toContain('Local KY News');
      expect(json).toContain('"sourceOrganization"');
    });
  });
});
