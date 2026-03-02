import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Router } from 'react-router-dom';
import { createMemoryHistory } from 'history';
import CountyPage from './county-page';
import CountyInfoPage from './county-info-page';
import KentuckyNewsPage from './kentucky-news-page';
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

// new tests for county-specific information navigation buttons

test('Leslie county page shows info navigation buttons and opens dialog on click', async () => {
  jest.spyOn(SiteService.prototype, 'getPosts').mockResolvedValue([]);
  const history = createMemoryHistory({ initialEntries: ['/news/kentucky/leslie-county'] });

  render(
    <Provider store={store}>
      <Router history={history}>
        <Route path="/news/kentucky/:countySlug/:infoType?">
          <KentuckyNewsPage />
        </Route>
      </Router>
    </Provider>
  );

  expect(await screen.findByText(/Government Offices/i)).toBeInTheDocument();
  expect(screen.getByText(/Utilities/i)).toBeInTheDocument();

  fireEvent.click(screen.getByText(/Government Offices/i));
  // dialog should open showing content
  expect(await screen.findByText(/Primary County Offices/i)).toBeInTheDocument();
  // URL should have changed as well
  expect(history.location.pathname).toBe("/news/kentucky/leslie-county/government-offices");

  // close dialog by simulating click on close fab
  fireEvent.click(screen.getByLabelText('close'));
  expect(history.location.pathname).toBe("/news/kentucky/leslie-county");

  // now click utilities and verify
  fireEvent.click(screen.getByText(/Utilities/i));
  expect(await screen.findByText(/Electric Utilities/i)).toBeInTheDocument();
  expect(history.location.pathname).toBe("/news/kentucky/leslie-county/utilities");
  fireEvent.click(screen.getByLabelText('close'));
  expect(history.location.pathname).toBe("/news/kentucky/leslie-county");
});

test('other counties do not render the navigation buttons', async () => {
  jest.spyOn(SiteService.prototype, 'getPosts').mockResolvedValue([]);

  render(
    <Provider store={store}>
      <MemoryRouter initialEntries={["/news/boyle-county"]}>
        <Route path="/news/:countySlug">
          <CountyPage />
        </Route>
      </MemoryRouter>
    </Provider>
  );

  await screen.findByText(/No articles found for Boyle County/i);
  expect(screen.queryByText(/County Government Offices/i)).toBeNull();
});

// direct navigation should render CountyPage which opens dialog

test('direct visit to government-offices route opens dialog', async () => {
  jest.spyOn(SiteService.prototype, 'getPosts').mockResolvedValue([]);
  const history = createMemoryHistory({ initialEntries: ["/news/kentucky/leslie-county/government-offices"] });
  render(
    <Provider store={store}>
      <Router history={history}>
        <Route path="/news/kentucky/:countySlug/:infoType?">
          <KentuckyNewsPage />
        </Route>
      </Router>
    </Provider>
  );

  expect(await screen.findByText(/Primary County Offices/i)).toBeInTheDocument();
});

test('direct visit to utilities route opens dialog', async () => {
  jest.spyOn(SiteService.prototype, 'getPosts').mockResolvedValue([]);
  const history = createMemoryHistory({ initialEntries: ["/news/kentucky/leslie-county/utilities"] });
  render(
    <Provider store={store}>
      <Router history={history}>
        <Route path="/news/kentucky/:countySlug/:infoType?">
          <KentuckyNewsPage />
        </Route>
      </Router>
    </Provider>
  );

  expect(await screen.findByText(/Electric Utilities/i)).toBeInTheDocument();
});

// the info page should include the same navigation tabs

test('info pages include nav tabs that can switch between types', async () => {
  jest.spyOn(SiteService.prototype, 'getPosts').mockResolvedValue([]);
  const history = createMemoryHistory({ initialEntries: ["/news/kentucky/leslie-county/government-offices"] });
  render(
    <Provider store={store}>
      <Router history={history}>
        <Route path="/news/kentucky/:countySlug/:infoType">
          <CountyInfoPage />
        </Route>
      </Router>
    </Provider>
  );

  expect(await screen.findByText(/Government Offices/i)).toBeInTheDocument();
  expect(screen.getByText(/Utilities/i)).toBeInTheDocument();

  // clicking utilities tab should navigate
  fireEvent.click(screen.getByText(/Utilities/i));
  expect(history.location.pathname).toBe("/news/kentucky/leslie-county/utilities");
});
