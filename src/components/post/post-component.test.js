import React from 'react';
import { render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import store from '../../redux/store/store';
import Post from './post-component';

test('renders title and plain body text on full post component', () => {
  const post = {
    title: 'Detail',
    image: '',
    originalLink: 'http://example.com',
    date: '2020-01-01',
    contentText: 'Paragraph one.\n\nParagraph two.',
    isKentucky: true,
    county: 'Campbell',
    tags: [],
  };
  render(
    <Provider store={store}>
      <Post post={post} />
    </Provider>
  );
  expect(screen.getByText(/Detail/i)).toBeInTheDocument();
  expect(screen.getByText(/Paragraph one/i)).toBeInTheDocument();
  expect(screen.getByText(/Paragraph two/i)).toBeInTheDocument();
});
