import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import CategoryFeedPage from './category-feed-page';
import SiteService from '../services/siteService';
import { Provider } from 'react-redux';
import store from '../redux/store/store';
import { setSelectedCounties } from '../redux/actions/actions';

jest.mock('../services/siteService');

const createPost = (overrides) => ({
  title: 'Test',
  date: new Date().toISOString(),
  shortDesc: 'desc',
  description: 'desc',
  image: '',
  imageTitle: '',
  originalLink: '',
  isKentucky: false,
  county: '',
  tags: [],
  ...overrides,
});

describe('CategoryFeedPage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    store.dispatch(setSelectedCounties([]));
  });

  it('uses paged API and ignores county filter for national category', async () => {
    store.dispatch(setSelectedCounties(['Boone']));

    const natPost = createPost({ title: 'Nat post', isKentucky: false });
    const fetchSpy = jest
      .spyOn(SiteService.prototype, 'fetchPage')
      .mockResolvedValue({ posts: [natPost], nextCursor: null });

    render(
      <Provider store={store}>
        <CategoryFeedPage category="national" title="National" />
      </Provider>
    );

    await waitFor(() => expect(screen.getByText('Nat post')).toBeInTheDocument());
    expect(fetchSpy).toHaveBeenCalledWith({
      category: 'national',
      counties: [],
      cursor: null,
      limit: 20,
    });
    expect(screen.getByText('Nat post')).toBeInTheDocument();
  });

  it('sets noindex robots tag when cursor query parameter present', async () => {
    store.dispatch(setSelectedCounties([]));
    jest.spyOn(SiteService.prototype, 'fetchPage').mockResolvedValue({ posts: [], nextCursor: null });

    // render page with cursor in window location
    window.history.pushState({}, 'test', '/today?cursor=xyz');
    render(
      <Provider store={store}>
        <CategoryFeedPage category="today" title="Kentucky Today" />
      </Provider>
    );

    await waitFor(() => {
      const robots = document.querySelector('meta[name="robots"]');
      expect(robots).not.toBeNull();
      expect(robots.getAttribute('content')).toBe('noindex, follow');
    });
  });
});
