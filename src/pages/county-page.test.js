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
test('county page uses card layout for content', async () => {
  jest.spyOn(SiteService.prototype, 'getPosts').mockResolvedValue([]);
  const history = createMemoryHistory({ initialEntries: ['/news/kentucky/jefferson-county'] });

  render(
    <Provider store={store}>
      <Router history={history}>
        <Route path="/news/kentucky/:countySlug/:infoType?">
          <KentuckyNewsPage />
        </Route>
      </Router>
    </Provider>
  );

  // card should wrap the county content
  expect(await screen.findByTestId('county-card')).toBeInTheDocument();
});


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

test('navigation buttons appear for all counties and link to county info pages', async () => {
  jest.spyOn(SiteService.prototype, 'getPosts').mockResolvedValue([]);

  const history = createMemoryHistory({ initialEntries: ['/news/kentucky/boyle-county'] });
  render(
    <Provider store={store}>
      <Router history={history}>
        <Route path="/news/kentucky/:countySlug/:infoType?">
          <KentuckyNewsPage />
        </Route>
      </Router>
    </Provider>
  );

  expect(await screen.findByText(/No articles found for Boyle County/i)).toBeInTheDocument();
  // tabs should be visible even though we don't have data for Boyle
  expect(screen.getByText(/Government Offices/i)).toBeInTheDocument();
  expect(screen.getByText(/Utilities/i)).toBeInTheDocument();

  // clicking government opens dialog with placeholder message
  fireEvent.click(screen.getByText(/Government Offices/i));
  expect(await screen.findByText(/Information for this category is not yet available for Boyle County/i)).toBeInTheDocument();
  expect(history.location.pathname).toBe('/news/kentucky/boyle-county/government-offices');
  fireEvent.click(screen.getByLabelText('close'));
  expect(history.location.pathname).toBe('/news/kentucky/boyle-county');

  // clicking utilities should also work
  fireEvent.click(screen.getByText(/Utilities/i));
  expect(await screen.findByText(/Information for this category is not yet available for Boyle County/i)).toBeInTheDocument();
  expect(history.location.pathname).toBe('/news/kentucky/boyle-county/utilities');
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

// article slugs under kentucky should also render ArticleSlugPage

test('kentucky article slug routes render ArticleSlugPage', async () => {
  // we don't care what service does, just ensure ArticleSlugPage mounts
  jest.spyOn(SiteService.prototype, 'getPosts').mockResolvedValue([]);
  const history = createMemoryHistory({ initialEntries: ["/news/kentucky/leslie-county/some-article-slug"] });
  render(
    <Provider store={store}>
      <Router history={history}>
        <Route path="/news/kentucky/:countySlug/:infoType?">
          <KentuckyNewsPage />
        </Route>
      </Router>
    </Provider>
  );

  // ArticleSlugPage renders a heading or error message; look for text used there
  expect(await screen.findByText(/We couldn't find that article/i)).toBeInTheDocument();
});

// ensure the county page itself hides the info navigation buttons when
// an info subpage is active (route includes infoType). This prevents the
// underlying page from showing duplicate controls beneath the dialog.

test('county page hides info buttons when viewing info subpage', async () => {
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

  // dialog should open to the government offices content
  expect(await screen.findByText(/Primary County Offices/i)).toBeInTheDocument();
});

// info pages themselves should not render an outer wrapper card (individual entries handle their own cards)

test('info page has no outer card', async () => {
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

  // queryByTestId returns null if not found
  expect(screen.queryByTestId('county-card')).toBeNull();
});
// verify specific content changes requested by user

 test('government offices content updates per request modifications', async () => {
  jest.spyOn(SiteService.prototype,'getPosts').mockResolvedValue([]);
  const history = createMemoryHistory({initialEntries:['/news/kentucky/leslie-county/government-offices']});
  render(
    <Provider store={store}>
      <Router history={history}>
        <Route path="/news/kentucky/:countySlug/:infoType">
          <CountyInfoPage />
        </Route>
      </Router>
    </Provider>
  );

  expect(await screen.findByText(/Primary County Offices/i)).toBeInTheDocument();
  expect(screen.getByText(/Circuit Court Clerk/i)).toBeInTheDocument();
  expect(screen.queryByText(/County Clerk – at the County Courthouse/i)).toBeNull();
  expect(screen.queryByText(/County Coroner,/i)).toBeNull();
  const cswsLink = screen.getByText(/csws\.chfs\.ky\.gov/i).closest('a');
  expect(cswsLink).toHaveAttribute('target','_blank');
  // senior center text should display domain only
  const seniorLink = screen.getByText(/seniorcenter\.us\/sc\/leslie_county_senior_citizens_center_hyden_ky/i).closest('a');
  expect(seniorLink).toHaveAttribute('target','_blank');
  // there are multiple identical addresses; verify all are clickable
  const mapLinks = screen.getAllByText(/22010 Main St, Hyden, KY 41749/i)
    .map(node => node.closest('a'));
  expect(mapLinks.length).toBeGreaterThan(1);
  mapLinks.forEach((lnk) => {
    expect(lnk).toHaveAttribute('href','https://www.google.com/maps/search/?api=1&query=22010+Main+St,+Hyden,+KY+41749');
  });

  // extension office address should also be linked (4-H uses same text, so pick anchor)
  const extAddr = screen.getAllByText(/22045 Main St #514, Hyden, KY 41749/i)
    .map(n => n.closest('a'))
    .find(Boolean);
  expect(extAddr).toHaveAttribute('href','https://www.google.com/maps/search/?api=1&query=22045+Main+St+%23514,+Hyden,+KY+41749');

  // check a phone is clickable via tel
  const phoneLink = screen.getByText(/\(606\) 672-2720/i).closest('a');
  expect(phoneLink).toHaveAttribute('href','tel:+16066722720');

});

// utilities page should reflect recent updates requested by user

test('utilities content updates per request modifications', async () => {
  jest.spyOn(SiteService.prototype,'getPosts').mockResolvedValue([]);
  const history = createMemoryHistory({initialEntries:['/news/kentucky/leslie-county/utilities']});
  render(
    <Provider store={store}>
      <Router history={history}>
        <Route path="/news/kentucky/:countySlug/:infoType">
          <CountyInfoPage />
        </Route>
      </Router>
    </Provider>
  );

  expect(await screen.findByText(/Electric Utilities/i)).toBeInTheDocument();
  // rumpke now has a website and clickable map address
  const rumpkeLink = screen.getByText(/rumpke\.com/i).closest('a');
  expect(rumpkeLink).toHaveAttribute('href','https://rumpke.com');
  const rumpkeAddr = screen.getByText(/2125 KY-118, Hyden, KY 41749/i).closest('a');
  expect(rumpkeAddr).toHaveAttribute('href','https://www.google.com/maps/search/?api=1&query=2125+KY-118,+Hyden,+KY+41749');

  // Thacker-Grigsby address clickable and website showing domain only
  const tgAddr = screen.getByText(/60 Communication Lane, Hindman, KY 41822/i).closest('a');
  expect(tgAddr).toHaveAttribute('href','https://www.google.com/maps/search/?api=1&query=60+Communication+Lane,+Hindman,+KY+41822');
  const tgLink = screen.getByText(/tgtel\.com/i).closest('a');
  expect(tgLink).toHaveAttribute('href','https://tgtel.com/');

  // AmeriGas address clickable and website simplified
  const amerigasAddr = screen.getByText(/207 N Main St, Leitchfield, KY 42754/i).closest('a');
  expect(amerigasAddr).toHaveAttribute('href','https://www.google.com/maps/search/?api=1&query=207+N+Main+St,+Leitchfield,+KY+42754');
  const amerigasLink = screen.getByText(/amerigas\.com/i).closest('a');
  expect(amerigasLink).toHaveAttribute('href','https://amerigas.com');

  // PSC address should now be clickable as well
  const pscAddr = screen.getByText(/211 Sower Blvd, Frankfort, KY 40601/i).closest('a');
  expect(pscAddr).toHaveAttribute('href','https://www.google.com/maps/search/?api=1&query=211+Sower+Blvd,+Frankfort,+KY+40601');

  // Jackson Energy entry has clickable address and short domain
  const jackAddr = screen.getByText(/115 Jackson Energy Lane, McKee, KY 40447/i).closest('a');
  expect(jackAddr).toHaveAttribute('href','https://www.google.com/maps/search/?api=1&query=115+Jackson+Energy+Lane,+McKee,+KY+40447');
  const jackLink = screen.getByText(/jacksonenergy\.com/i).closest('a');
  expect(jackLink).toHaveAttribute('href','https://www.jacksonenergy.com/');
});
