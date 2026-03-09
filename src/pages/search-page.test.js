import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route } from 'react-router-dom';
import SearchPage from './search-page';
import EditorialPolicyPage from './editorial-policy-page';
import { Provider } from 'react-redux';
import store from '../redux/store/store';
import SiteService from '../services/siteService';

// simple smoke test and robots meta check

test('search page sets robots noindex meta', async () => {
  jest.spyOn(SiteService.prototype, 'getPosts').mockResolvedValue([]);
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

// ensure error handling from the catch block works and loading state is reset
test('search page shows an error snackbar and stops loading when the search fails', async () => {
  jest.useFakeTimers();
  jest.spyOn(SiteService.prototype, 'getPosts').mockRejectedValue({ errorMessage: 'Search failed. Please try again.' });
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
