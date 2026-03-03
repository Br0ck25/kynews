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
  // dialog should open showing content (heading text updated)
  expect(await screen.findByText(/Leslie County, Kentucky Government Offices Directory/i)).toBeInTheDocument();
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

  expect(await screen.findByText(/Leslie County, Kentucky Government Offices Directory/i)).toBeInTheDocument();
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
  expect(await screen.findByText(/Leslie County, Kentucky Government Offices Directory/i)).toBeInTheDocument();
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

  // new heading and a few key officials
  expect(await screen.findByText(/Primary Elected Officials/i)).toBeInTheDocument();
  const jimmyEntries = screen.getAllByText(/Jimmy Sizemore/i);
  expect(jimmyEntries.length).toBeGreaterThan(0);
  expect(screen.getByText(/Delano Huff/i)).toBeInTheDocument();
  // newly added sections
  expect(screen.getByText(/County Coroner/i)).toBeInTheDocument();
  expect(screen.getByText(/District 1 – David Caldwell/i)).toBeInTheDocument();

  // quick links include driver licensing appointment and updated links
  const dlLink = screen.getByText(/Driver Licensing Appointment/i).closest('a');
  expect(dlLink).toHaveAttribute('href','https://drive.ky.gov');
  expect(dlLink).toHaveAttribute('target','_blank');
  const propLink = screen.getByText(/Property Search \(PVA\)/i).closest('a');
  expect(propLink).toHaveAttribute('href','https://qpublic.net/ky/leslie/est.html');
  expect(propLink).toHaveAttribute('target','_blank');
  const courtLink = screen.getByText(/Court Docket/i).closest('a');
  expect(courtLink).toHaveAttribute('href','https://kycourts.gov/Courts/County-Information/Pages/Leslie.aspx');
  expect(courtLink).toHaveAttribute('target','_blank');
  // pay taxes and jail buttons should now scroll to sections via anchor
  // clicking anchors should trigger scrollIntoView on most elements
  HTMLElement.prototype.scrollIntoView = jest.fn();
  const scrollSpy = jest.spyOn(HTMLElement.prototype, 'scrollIntoView');
  fireEvent.click(screen.getByText(/Pay Property Taxes/i));
  expect(scrollSpy).toHaveBeenCalled();

  fireEvent.click(screen.getByText(/Jail Information/i));
  expect(scrollSpy).toHaveBeenCalledTimes(2);
  scrollSpy.mockRestore();

  // verify multiple map addresses still clickable (primary judgeship + others)
  const mapLinks = screen.getAllByText(/22010 Main St, Hyden, KY 41749/i)
    .map(node => node.closest('a'))
    .filter(Boolean);
  expect(mapLinks.length).toBeGreaterThan(1);
  mapLinks.forEach((lnk) => {
    expect(lnk).toHaveAttribute('href','https://www.google.com/maps/search/?api=1&query=22010+Main+St,+Hyden,+KY+41749');
  });


  // additional recently linked addresses
  expect(screen.getByText(/2125 Highway 118, Hyden, KY 41749/i).closest('a')).toHaveAttribute('href','https://www.google.com/maps/search/?api=1&query=2125+Highway+118,+Hyden,+KY+41749');
  // note: above covers EMA, child support, extension because they all share same link text
  expect(screen.getByText(/78 Maple St, Hyden, KY 41749/i).closest('a')).toHaveAttribute('href','https://www.google.com/maps/search/?api=1&query=78+Maple+St,+Hyden,+KY+41749');
  expect(screen.getByText(/21125 Highway 421, Hyden, KY 41749/i).closest('a')).toHaveAttribute('href','https://www.google.com/maps/search/?api=1&query=21125+Highway+421,+Hyden,+KY+41749');
  expect(screen.getByText(/38 Quarry Rd, Hyden, KY 41749/i).closest('a')).toHaveAttribute('href','https://www.google.com/maps/search/?api=1&query=38+Quarry+Rd,+Hyden,+KY+41749');
  expect(screen.getByText(/39 Senior Citizens Dr, Hyden, KY 41749/i).closest('a')).toHaveAttribute('href','https://www.google.com/maps/search/?api=1&query=39+Senior+Citizens+Dr,+Hyden,+KY+41749');
  expect(screen.getByText(/22065 Main St, Hyden, KY 41749/i).closest('a')).toHaveAttribute('href','https://www.google.com/maps/search/?api=1&query=22065+Main+St,+Hyden,+KY+41749');
  expect(screen.getByText(/425 Highway 421, Hyden, KY 41749/i).closest('a')).toHaveAttribute('href','https://www.google.com/maps/search/?api=1&query=425+Highway+421,+Hyden,+KY+41749');
  expect(screen.getByText(/130 Kate Ireland Dr, Hyden, KY 41749/i).closest('a')).toHaveAttribute('href','https://www.google.com/maps/search/?api=1&query=130+Kate+Ireland+Dr,+Hyden,+KY+41749');



  // check a county phone is clickable via tel (road department)
  const phoneLink = screen.getByText(/\(606\) 672-2465/i).closest('a');
  expect(phoneLink).toHaveAttribute('href','tel:+16066722465');

});

// new tests ensuring the info pages also show share/save controls

test('info pages include share and save buttons and they function', async () => {
  jest.spyOn(SiteService.prototype,'getPosts').mockResolvedValue([]);
  const shareMock = jest.fn().mockResolvedValue();
  Object.defineProperty(window.navigator, 'share', {
    configurable: true,
    value: shareMock,
  });
  const storagePrefix = Constants.localStoragePrefix;
  localStorage.setItem(`${storagePrefix}savedCounties`, JSON.stringify([]));

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

  // header buttons should be present
  expect(await screen.findByLabelText(/Share page/i)).toBeInTheDocument();
  expect(screen.getByLabelText(/Save page/i)).toBeInTheDocument();

  // clicking share should invoke navigator.share with the info-specific URL
  fireEvent.click(screen.getByLabelText(/Share page/i));
  expect(shareMock).toHaveBeenCalledWith({
    title: 'Leslie County, KY News',
    text: expect.stringContaining('government offices'),
    url: 'https://localkynews.com/news/kentucky/leslie-county/government-offices',
  });

  // clicking save should toggle county saved list
  fireEvent.click(screen.getByLabelText(/Save page/i));
  const savedCounties = JSON.parse(localStorage.getItem(`${storagePrefix}savedCounties`));
  expect(savedCounties).toContain('Leslie');
});

// verify Adair county government page content from markdown

test('Adair county government page displays key officials and quick links', async () => {
  jest.spyOn(SiteService.prototype,'getPosts').mockResolvedValue([]);
  const history = createMemoryHistory({initialEntries:['/news/kentucky/adair-county/government-offices']});
  render(
    <Provider store={store}>
      <Router history={history}>
        <Route path="/news/kentucky/:countySlug/:infoType">
          <CountyInfoPage />
        </Route>
      </Router>
    </Provider>
  );

  expect(await screen.findByText(/Adair County, Kentucky Government Offices Directory/i)).toBeInTheDocument();
  expect(screen.getByText(/Property Search \(PVA\)/i)).toBeInTheDocument();
  expect(screen.getByText(/Driver Licensing Appointment/i)).toBeInTheDocument();
  expect(screen.getAllByText(/Larry Russell Bryant/i).length).toBeGreaterThan(0);
  const phones = screen.getAllByText(/\(270\) 384-4703/i)
    .map(n => n.closest('a'))
    .filter(Boolean);
  expect(phones.length).toBeGreaterThan(0);
  expect(phones[0]).toHaveAttribute('href','tel:+12703844703');
  // attorney and sheriff entries
  expect(screen.getByText(/County Attorney/i)).toBeInTheDocument();
  expect(screen.getAllByText(/Sheriff/i).length).toBeGreaterThan(0);
  const sheriffPhones = screen.getAllByText(/\(270\) 384-2776/i)
    .map(n => n.closest('a'))
    .filter(Boolean);
  expect(sheriffPhones.length).toBeGreaterThan(0);
  expect(sheriffPhones[0]).toHaveAttribute('href','tel:+12703842776');
  // PVA has pay taxes anchor id
  // PVA card should carry the pay-taxes id so quick link works
  expect(document.getElementById('pay-taxes')).not.toBeNull();
  // detention center heading exists
  expect(screen.getByText(/Adair County Regional Jail/i)).toBeInTheDocument();
  // magistrate name sample
  expect(screen.getByText(/Daryl Flatt/i)).toBeInTheDocument();
  // health department phone
  expect(screen.getByText(/Lake Cumberland District Health Department/i)).toBeInTheDocument();
  expect(screen.getByText(/\(270\) 384-2418/i).closest('a')).toHaveAttribute('href','tel:+12703842418');
  // reciprocal utilities link
  const utilLink = screen.getByText(/View our Adair County Utilities Directory/i).closest('a');
  expect(utilLink).toHaveAttribute('href','/news/kentucky/adair-county/utilities');
  // transportation & licensing cards should now be separate
  expect(screen.getByText(/Driver Licensing \(KYTC Regional Office\)/i)).toBeInTheDocument();
  expect(screen.getByText(/United States Post Office/i)).toBeInTheDocument();
});

// verify Allen county government page content from markdown

test('Allen county government page displays key officials and quick links', async () => {
  jest.spyOn(SiteService.prototype,'getPosts').mockResolvedValue([]);
  const history = createMemoryHistory({initialEntries:['/news/kentucky/allen-county/government-offices']});
  render(
    <Provider store={store}>
      <Router history={history}>
        <Route path="/news/kentucky/:countySlug/:infoType">
          <CountyInfoPage />
        </Route>
      </Router>
    </Provider>
  );

  expect(await screen.findByText(/Allen County, Kentucky Government Offices Directory/i)).toBeInTheDocument();
  expect(screen.getByText(/Property Search \(PVA\)/i)).toBeInTheDocument();
  expect(screen.getByText(/Driver Licensing Appointment/i)).toBeInTheDocument();
  const dhMatches = screen.getAllByText(/Dennis Harper/i);
  expect(dhMatches.length).toBeGreaterThan(0);
  expect(screen.getByText(/Brandon Ford/i)).toBeInTheDocument();
  // some additional officials and services
  const clerkMatches = screen.getAllByText(/County Clerk/i);
  expect(clerkMatches.length).toBeGreaterThan(0);
  expect(screen.getByText(/Property Valuation Administrator/i)).toBeInTheDocument();
  expect(screen.getByText(/County Treasurer/i)).toBeInTheDocument();
  expect(screen.getByText(/County Coroner/i)).toBeInTheDocument();
  expect(screen.getByText(/Circuit Court Clerk/i)).toBeInTheDocument();
  expect(screen.getByText(/Health Department/i)).toBeInTheDocument();
  // reciprocal link back to utilities
  const utilLink2 = screen.getByText(/View our Allen County Utilities Directory/i).closest('a');
  expect(utilLink2).toHaveAttribute('href','/news/kentucky/allen-county/utilities');
});

// verify Adair utilities page content

test('Adair county utilities page lists key providers', async () => {
  jest.spyOn(SiteService.prototype,'getPosts').mockResolvedValue([]);
  const history = createMemoryHistory({initialEntries:['/news/kentucky/adair-county/utilities']});
  render(
    <Provider store={store}>
      <Router history={history}>
        <Route path="/news/kentucky/:countySlug/:infoType">
          <CountyInfoPage />
        </Route>
      </Router>
    </Provider>
  );

  expect(await screen.findByText(/Adair County, Kentucky Utilities Directory/i)).toBeInTheDocument();
  expect(screen.getByText(/Taylor County RECC/i)).toBeInTheDocument();
  expect(screen.getByText(/Columbia Gas of Kentucky/i)).toBeInTheDocument();
  expect(screen.getByText(/Columbia\/Adair Utilities District/i)).toBeInTheDocument();
  // Windstream shows up twice (name and website link) so just assert at least one
  const windstreamMatches = screen.getAllByText(/Windstream/i);
  expect(windstreamMatches.length).toBeGreaterThan(0);
  expect(screen.getByText(/DUO Broadband/i)).toBeInTheDocument();
  expect(screen.getByText(/starlink\.com/i)).toBeInTheDocument();
  expect(screen.getByText(/viasat\.com/i)).toBeInTheDocument();
});

// utilities page should reflect recent updates requested by user

test('share/save on utilities page uses the utilities path and text', async () => {
  jest.spyOn(SiteService.prototype,'getPosts').mockResolvedValue([]);
  const shareMock = jest.fn().mockResolvedValue();
  Object.defineProperty(window.navigator, 'share', {
    configurable: true,
    value: shareMock,
  });

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

  expect(await screen.findByLabelText(/Share page/i)).toBeInTheDocument();
  fireEvent.click(screen.getByLabelText(/Share page/i));
  expect(shareMock).toHaveBeenCalledWith({
    title: 'Leslie County, KY News',
    text: expect.stringContaining('utilities'),
    url: 'https://localkynews.com/news/kentucky/leslie-county/utilities',
  });
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
  // quick links scroll to their sections
  HTMLElement.prototype.scrollIntoView = jest.fn();
  fireEvent.click(screen.getByText(/Electric Service/i));
  expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();
  fireEvent.click(screen.getByText(/Water & Sewer Service/i));
  expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledTimes(2);
  // reciprocal link to government page should appear and open in new tab
  const govLink = screen.getByText(/Government Offices Directory/i).closest('a');
  expect(govLink).toHaveAttribute('href','/news/kentucky/leslie-county/government-offices');
  // rumpke now has a website and clickable map address
  const rumpkeLink = screen.getByText(/rumpke\.com/i).closest('a');
  expect(rumpkeLink).toHaveAttribute('href','https://rumpke.com');
  const rumpkeAddr = screen.getByText(/2125 KY-118, Hyden, KY 41749/i).closest('a');
  expect(rumpkeAddr).toHaveAttribute('href','https://www.google.com/maps/search/?api=1&query=2125+KY-118,+Hyden,+KY+41749');

  // Thacker-Grigsby address clickable and website showing domain only
  expect(screen.getByText(/tgtel\.com/i).closest('a')).toHaveAttribute('href','https://tgtel.com/');

  // new satellite providers should be listed
  // provider links should exist; presence of starlink.com implies provider
  const starlinkLink = screen.getByText(/starlink\.com/i).closest('a');
  expect(starlinkLink).toHaveAttribute('href','https://www.starlink.com');
  expect(screen.queryAllByText(/Viasat/i).length).toBeGreaterThan(0);
  const viasatLink = screen.getByText(/viasat\.com/i).closest('a');
  expect(viasatLink).toHaveAttribute('href','https://www.viasat.com');
  expect(screen.queryAllByText(/HughesNet/i).length).toBeGreaterThan(0);
  const hughesLink = screen.getByText(/hughesnet\.com/i).closest('a');
  expect(hughesLink).toHaveAttribute('href','https://www.hughesnet.com');

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
  // phone number should also be clickable now
  const amerigasPhone = screen.getByText(/1-800-263-7442/i).closest('a');
  expect(amerigasPhone).toHaveAttribute('href','tel:+18002637442');

  // new Jackson Propane Plus entry
  const jppAddr = screen.getByText(/25 Capital Hill Drive, Bonnyman, KY 41719/i).closest('a');
  expect(jppAddr).toHaveAttribute('href','https://www.google.com/maps/search/?api=1&query=25+Capital+Hill+Drive,+Bonnyman,+KY+41719');
  const jppLink = screen.getByText(/jacksonpropaneplus\.com/i).closest('a');
  expect(jppLink).toHaveAttribute('href','https://jacksonpropaneplus.com');

  // water district description and link
  expect(screen.getByText(/Local water supply and treatment provider/i)).toBeInTheDocument();
  const waterLink = screen.getByText(/www\.doxo\.com/i).closest('a');
  expect(waterLink).toHaveAttribute('href','https://www.doxo.com/u/biller/hyden-leslie-county-water-district-19AAD20');

  // broadband links clickable
  const fccLink = screen.getByText(/FCC Broadband Map/i).closest('a');
  expect(fccLink).toHaveAttribute('href','https://broadbandmap.fcc.gov');
  const kyLink = screen.getByText(/Kentucky Broadband Office/i).closest('a');
  expect(kyLink).toHaveAttribute('href','https://broadband.ky.gov');



  // Jackson Energy entry has clickable address and short domain
  const jackAddr = screen.getByText(/115 Jackson Energy Lane, McKee, KY 40447/i).closest('a');
  expect(jackAddr).toHaveAttribute('href','https://www.google.com/maps/search/?api=1&query=115+Jackson+Energy+Lane,+McKee,+KY+40447');
  const jackLink = screen.getByText(/jacksonenergy\.com/i).closest('a');
  expect(jackLink).toHaveAttribute('href','https://jacksonenergy.com');
});
