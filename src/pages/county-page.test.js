import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route } from 'react-router-dom';
import CountyPage from './county-page';
import SiteService from '../services/siteService';
import { Provider } from 'react-redux';
import store from '../redux/store/store';

test('renders error state when slug is invalid', () => {
  render(
    <Provider store={store}>
      <MemoryRouter initialEntries={["/news/not-a-county"]}>
        <Route path="/news/:countySlug">
          <CountyPage />
        </Route>
      </MemoryRouter>
    </Provider>
  );

  expect(screen.getByText(/County not found/i)).toBeInTheDocument();
});

// simulate fetch error (e.g. due to caching) and ensure message shown
// we spy on the service prototype so the component's `new SiteService()`
// instance uses our mocked methods.

test('shows error message when service fails', async () => {
  jest.spyOn(SiteService.prototype, 'getTags').mockResolvedValue([]);
  jest.spyOn(SiteService.prototype, 'getPosts').mockRejectedValue({ errorMessage: 'failed' });

  render(
    <Provider store={store}>
      <MemoryRouter initialEntries={["/news/boyle-county"]}>
        <Route path="/news/:countySlug">
          <CountyPage />
        </Route>
      </MemoryRouter>
    </Provider>
  );

  // wait for effect to run and error message appear
  const errorEl = await screen.findByText(/failed/i);
  expect(errorEl).toBeInTheDocument();
});
