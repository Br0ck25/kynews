import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route } from 'react-router-dom';
import SearchPage from './search-page';
import EditorialPolicyPage from './editorial-policy-page';
import { Provider } from 'react-redux';
import store from '../redux/store/store';
import { setSearchPosts } from '../redux/actions/actions';
import SiteService from '../services/siteService';

// simple smoke test and robots meta check

test('search page sets robots noindex meta', async () => {
  jest.spyOn(SiteService.prototype, 'fetchPage').mockResolvedValue({ posts: [], nextCursor: null });
  render(
    <Provider store={store}>
      <MemoryRouter initialEntries={["/search?q=test"]}>
        <Route path="/search">
          <SearchPage />
        </Route>
      </MemoryRouter>
    </Provider>
  );

  await screen.findByLabelText(/Search articles/i);
  const robots = document.querySelector('meta[name="robots"]');
  expect(robots).toBeTruthy();
  expect(robots.getAttribute('content')).toBe('noindex');
});

// pagination behavior

describe('search pagination', () => {
  beforeAll(() => {
    // spy on fetchPage; component should call this instead of getPosts
    jest.spyOn(SiteService.prototype, 'fetchPage');

    // stub IntersectionObserver so that observe() immediately fires
    global.IntersectionObserver = class {
      constructor(cb) {
        this.cb = cb;
      }
      observe(el) {
        // simulate element entering viewport
        this.cb([{ isIntersecting: true }]);
      }
      disconnect() {}
    };
  });
  afterAll(() => {
    delete global.IntersectionObserver;
  });

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    store.dispatch(setSearchPosts({ searchValue: '', posts: [] }));
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('calls paged API and appends results when scrolling', async () => {
    const first = { posts: [{ title: 'one' }], nextCursor: 'abc' };
    const second = { posts: [{ title: 'two' }], nextCursor: null };
    SiteService.prototype.fetchPage
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);

    render(
      <Provider store={store}>
        <MemoryRouter>
          <SearchPage />
        </MemoryRouter>
      </Provider>
    );

    // type a query
    const input = screen.getByLabelText(/Search articles/i);
    fireEvent.change(input, { target: { value: 'hello' } });

    // advance debounce timer
    jest.advanceTimersByTime(1000);

    // wait for first fetch
    await waitFor(() => expect(SiteService.prototype.fetchPage).toHaveBeenCalledTimes(1));
    expect(SiteService.prototype.fetchPage).toHaveBeenCalledWith({
      search: 'hello',
      category: 'all',
      limit: 20,
      cursor: null,
    });

    // IntersectionObserver stub should trigger second fetch automatically
    await waitFor(() => expect(SiteService.prototype.fetchPage).toHaveBeenCalledTimes(2));
    expect(SiteService.prototype.fetchPage).toHaveBeenLastCalledWith({
      search: 'hello',
      category: 'all',
      limit: 20,
      cursor: 'abc',
    });

    // verify Redux store was updated with both pages
    const state = store.getState();
    expect(state.searchPosts.posts).toEqual([...first.posts, ...second.posts]);
  });
});

// ensure error handling from the catch block works and loading state is reset
test('search page shows an error snackbar and stops loading when the search fails', async () => {
  store.dispatch(setSearchPosts({ searchValue: '', posts: [] }));
  jest.useFakeTimers();
  jest.spyOn(SiteService.prototype, 'fetchPage').mockRejectedValue({ errorMessage: 'Search failed. Please try again.' });
  render(
    <Provider store={store}>
      <MemoryRouter initialEntries={["/search"]}>
        <Route path="/search">
          <SearchPage />
        </Route>
      </MemoryRouter>
    </Provider>
  );

  const input = screen.getByLabelText(/Search articles/i);
  input.focus();
  fireEvent.change(input, { target: { value: 'abc' } });

  // advance past debounce delay
  jest.advanceTimersByTime(1000);

  const snack = await screen.findByText(/Search failed/i);
  expect(snack).toBeTruthy();

  // after error is shown we should no longer be in loading state; skeletons are removed
  expect(screen.queryByRole('progressbar')).toBeNull();
});

// editorial policy page must expose an AI disclosure anchor and JSON-LD
test('editorial policy page includes AI disclosure section and structured data', () => {
  document.head.innerHTML = '';
  render(<EditorialPolicyPage />);
  expect(document.title).toBe('Editorial Policy — Local KY News');

  const section = document.getElementById('ai-disclosure');
  expect(section).toBeTruthy();
  expect(section.textContent).toMatch(/AI Disclosure/i);

  const script = document.getElementById('json-ld-ai-disclosure');
  expect(script).toBeTruthy();
  const json = JSON.parse(script.textContent);
  expect(json.name).toBe('AI Disclosure');
  expect(json.author.name).toBe('Local KY News');
});
