import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import CategoryFeedPage from './category-feed-page';
import SiteService from '../services/siteService';
import { Provider } from 'react-redux';
import store from '../redux/store/store';

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

  it('renders both Kentucky and national articles for national category', async () => {
    const kyPost = createPost({ title: 'KY post', isKentucky: true, county: 'Boone' });
    const natPost = createPost({ title: 'Nat post', isKentucky: false });
    jest.spyOn(SiteService.prototype, 'getPosts').mockResolvedValue([kyPost, natPost]);

    render(
      <Provider store={store}>
        <CategoryFeedPage category="national" title="National" />
      </Provider>
    );

    // wait for posts to appear
    await waitFor(() => expect(screen.getByText('KY post')).toBeInTheDocument());
    expect(screen.getByText('Nat post')).toBeInTheDocument();
  });
});
