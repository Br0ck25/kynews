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
    shortDesc: 'Paragraph one.\n\nParagraph two.',
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

// list-handling regression test
test('does not merge numbered-heading with following paragraph', () => {
  const post = {
    title: 'List Test',
    image: '',
    originalLink: 'http://example.com',
    date: '2020-01-01',
    contentText: '1. Heading\n\nFollowing text.',
    shortDesc: '1. Heading\n\nFollowing text.',
    isKentucky: true,
    tags: [],
  };

  const { container } = render(
    <Provider store={store}>
      <Post post={post} />
    </Provider>
  );

  // there should be two separate <p> elements in the description area
  const paras = container.querySelectorAll('.description p');
  expect(paras.length).toBe(2);
  expect(paras[0].textContent).toBe('1. Heading');
  expect(paras[1].textContent).toBe('Following text.');
});

// quick-facts regression test
test('keeps key:value lines separate in summary', () => {
  const post = {
    title: 'Facts Test',
    image: '',
    originalLink: 'http://example.com',
    date: '2020-01-01',
    contentText: 'Quick Facts About Pike County\n\nEstablished: 1821\n\nCounty Seat: Pikeville',
    shortDesc: 'Quick Facts About Pike County\n\nEstablished: 1821\n\nCounty Seat: Pikeville',
    isKentucky: true,
    tags: [],
  };

  const { container } = render(
    <Provider store={store}>
      <Post post={post} />
    </Provider>
  );

  const paras = container.querySelectorAll('.description p');
  expect(paras.length).toBe(3);
  expect(paras[0].textContent).toBe('Quick Facts About Pike County');
  expect(paras[1].textContent).toBe('Established: 1821');
  expect(paras[2].textContent).toBe('County Seat: Pikeville');
});

// formatting preservation test
test('bold/HTML in shortDesc is rendered correctly', () => {
  const post = {
    title: 'HTML Test',
    image: '',
    originalLink: 'http://example.com',
    date: '2020-01-01',
    contentText: '',
    shortDesc: 'This is <strong>bold</strong> text',
    isKentucky: true,
    tags: [],
  };

  const { container } = render(
    <Provider store={store}>
      <Post post={post} />
    </Provider>
  );

  const paras = container.querySelectorAll('.description p');
  expect(paras.length).toBe(1);
  expect(paras[0].innerHTML).toBe('This is <strong>bold</strong> text');
});

// new case for multiple counties
test('renders multiple county chips when post.tags include several counties', () => {
  const post = {
    title: 'Multi County',
    image: '',
    originalLink: 'http://example.com',
    date: '2020-01-01',
    contentText: 'Text',
    shortDesc: 'Text',
    tags: ['Boone', 'Campbell'],
    county: 'Boone',
    isKentucky: true,
  };

  render(
    <Provider store={store}>
      <Post post={post} />
    </Provider>
  );

  // expect both county chips to appear (only exact county names)
  expect(screen.getByText(/^Boone County$/i)).toBeInTheDocument();
  expect(screen.getByText(/^Campbell County$/i)).toBeInTheDocument();
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

test('detail actions show read full story button without share or save button', () => {
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

  // Share button was removed from the post page action row (per design decision)
  expect(screen.queryByLabelText(/Share/i)).toBeNull();
  expect(screen.queryByLabelText(/Save/i)).toBeNull();
  // Read Full Story button should still be present
  expect(screen.getAllByRole('link', { name: /Read Full Story/i }).length).toBeGreaterThan(0);
});
