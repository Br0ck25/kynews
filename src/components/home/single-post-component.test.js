import React from 'react';
import { render, screen } from '@testing-library/react';
import SinglePost from './single-post-component';

// minimal redux store provider for dispatch; we can use same store
import { Provider } from 'react-redux';
import store from '../../redux/store/store';
import { MemoryRouter as Router } from 'react-router-dom';

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

// mock ShareAPI so we can inspect calls
import * as utils from '../../utils/functions';

jest.mock('../../utils/functions', () => {
  const original = jest.requireActual('../../utils/functions');
  return {
    ...original,
    ShareAPI: jest.fn(),
  };
});

test('renders tags for post', () => {
  render(
    <Provider store={store}>
      <Router>
        <SinglePost post={basePost} />
      </Router>
    </Provider>
  );

  expect(screen.getByText(/Kentucky/i)).toBeInTheDocument();
  expect(screen.getByText(/Boone/i)).toBeInTheDocument();
});

// verify share button fetches fresh article and builds correct URL
test('share button refetches slug and updates path', async () => {
  // stub service to return national article when called
  const fakeService = {
    getPostBySlug: jest.fn().mockResolvedValue({ slug: 'foo', isNational: true, title: 'Test Article' }),
  };
  jest.spyOn(require('../../components/home/single-post-component'), 'useMemo').mockReturnValue(fakeService);

  // render post with old KY flag
  render(
    <Provider store={store}>
      <Router>
        <SinglePost post={{ ...basePost, slug: 'foo', isNational: false }} />
      </Router>
    </Provider>
  );

  // click share icon
  const shareBtn = screen.getByRole('button', { name: /share/i });
  shareBtn.click();

  // allow async
  await new Promise((r) => setTimeout(r, 0));

  expect(utils.ShareAPI).toHaveBeenCalled();
  const calledUrl = utils.ShareAPI.mock.calls[0][2];
  expect(calledUrl).toContain('/news/national/foo');
});
