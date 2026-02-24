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

test('renders playable YouTube iframe when article link is a YouTube video', () => {
  const post = {
    title: 'Video Detail',
    image: '',
    originalLink: 'https://www.youtube.com/watch?v=M7lc1UVf-VE',
    date: '2020-01-01',
    contentText: 'Video body.',
    description: '',
    shortDesc: '',
    tags: [],
  };

  render(
    <Provider store={store}>
      <Post post={post} />
    </Provider>
  );

  const frame = screen.getByTitle(/Video Detail video/i);
  expect(frame).toBeInTheDocument();
  expect(frame.getAttribute('src')).toContain('https://www.youtube.com/embed/M7lc1UVf-VE');
});

test('detail actions show share and original article, without save button', () => {
  const post = {
    title: 'Detail Actions',
    image: '',
    originalLink: 'https://example.com/article',
    date: '2020-01-01',
    contentText: 'Text',
    description: '',
    shortDesc: '',
    tags: [],
  };

  render(
    <Provider store={store}>
      <Post post={post} />
    </Provider>
  );

  expect(screen.getByLabelText(/Share/i)).toBeInTheDocument();
  expect(screen.getByRole('link', { name: /Original Article/i })).toBeInTheDocument();
  expect(screen.queryByLabelText(/Save/i)).toBeNull();
});
