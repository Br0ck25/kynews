import React from 'react';
import { render, screen } from '@testing-library/react';
import SinglePost from './single-post-component';

// minimal redux store provider for dispatch; we can use same store
import { Provider } from 'react-redux';
import store from '../../redux/store/store';

const basePost = {
  title: 'Test Article',
  date: '2021-01-01T00:00:00Z',
  shortDesc: 'short',
  description: 'desc',
  image: '',
  imageTitle: 'img',
  originalLink: 'http://example.com',
  isKentucky: true,
  county: 'Boone',
  tags: [],
};

test('renders tags for post', () => {
  render(
    <Provider store={store}>
      <SinglePost post={basePost} />
    </Provider>
  );

  expect(screen.getByText(/Kentucky/i)).toBeInTheDocument();
  expect(screen.getByText(/Boone/i)).toBeInTheDocument();
});
