import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route } from 'react-router-dom';
import CountyPage from './county-page';
import SiteService from '../services/siteService';
import { Provider } from 'react-redux';
import store from '../redux/store/store';
import Constants from '../constants/constants';
import { setSelectedCounties } from '../redux/actions/actions';

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

test('save county only updates saved counties and does not alter feed filters', async () => {
  const storagePrefix = Constants.localStoragePrefix;
  const initialTags = [
    { value: 'Fayette', active: true },
    { value: 'Boyle', active: false },
  ];

  localStorage.setItem(`${storagePrefix}tags`, JSON.stringify(initialTags));
  localStorage.setItem(`${storagePrefix}savedCounties`, JSON.stringify([]));

  jest.spyOn(SiteService.prototype, 'getPosts').mockResolvedValue([]);
  store.dispatch(setSelectedCounties(['Fayette']));

  render(
    <Provider store={store}>
      <MemoryRouter initialEntries={["/news/boyle-county"]}>
        <Route path="/news/:countySlug">
          <CountyPage />
        </Route>
      </MemoryRouter>
    </Provider>
  );

  fireEvent.click(await screen.findByLabelText(/Save county/i));

  await waitFor(() => {
    const savedCounties = JSON.parse(localStorage.getItem(`${storagePrefix}savedCounties`));
    expect(savedCounties).toContain('Boyle');
  });

  const tagsAfter = JSON.parse(localStorage.getItem(`${storagePrefix}tags`));
  expect(tagsAfter).toEqual(initialTags);
  expect(store.getState().selectedCounties).toEqual(['Fayette']);
});

// verify share button constructs canonical county URL rather than "local"
test('share button uses county URL', async () => {
  jest.spyOn(SiteService.prototype, 'getPosts').mockResolvedValue([]);
  // mock navigator.share
  const shareMock = jest.fn().mockResolvedValue();
  Object.defineProperty(window.navigator, 'share', {
    configurable: true,
    value: shareMock,
  });

  render(
    <Provider store={store}>
      <MemoryRouter initialEntries={["/news/adair-county"]}>
        <Route path="/news/:countySlug">
          <CountyPage />
        </Route>
      </MemoryRouter>
    </Provider>
  );

  // wait for page to load and then click share
  fireEvent.click(await screen.findByLabelText(/Share county/i));

  expect(shareMock).toHaveBeenCalledWith({
    title: 'Adair County, KY News',
    text: 'Latest from Adair County on Kentucky News',
    url: 'https://localkynews.com/news/kentucky/adair-county',
  });
});
