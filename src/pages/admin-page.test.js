import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import AdminPage from './admin-page';
import SiteService from '../services/siteService';

describe('AdminPage manual body formatting', () => {
  beforeEach(() => {
    // ensure page treats us as authorized so form elements are rendered
    sessionStorage.setItem('ky_admin_panel_key', 'test');
    // stub network calls that load initial admin data
    jest.spyOn(SiteService.prototype, 'getAdminSources').mockResolvedValue([]);
    jest.spyOn(SiteService.prototype, 'getAdminMetrics').mockResolvedValue(null);
    jest.spyOn(SiteService.prototype, 'getAdminRejections').mockResolvedValue({ items: [] });
    jest.spyOn(SiteService.prototype, 'getAdminArticles').mockResolvedValue({ items: [] });
    jest.spyOn(SiteService.prototype, 'getBlockedArticles').mockResolvedValue({ items: [] });
  });
  it.skip('wraps selected text with <strong> when Bold button is clicked', async () => {
    render(<AdminPage />);
    fireEvent.click(screen.getByRole('tab', { name: /Create Article/i }));
    const body = await screen.findByLabelText(/Body \(optional\)/i);
    // type some text
    fireEvent.change(body, { target: { value: 'Hello world' } });
    // select the word 'world'
    body.setSelectionRange(6, 11);
    fireEvent.click(screen.getByLabelText(/Bold/i));
    expect(body.value).toBe('Hello <strong>world</strong>');
  });

  it.skip('wraps selection with larger-font span when Larger font button is clicked', async () => {
    render(<AdminPage />);
    fireEvent.click(screen.getByRole('tab', { name: /Create Article/i }));
    const body = await screen.findByLabelText(/Body \(optional\)/i);
    fireEvent.change(body, { target: { value: 'Size me' } });
    body.setSelectionRange(0, 4); // "Size"
    fireEvent.click(screen.getByLabelText(/Larger font/i));
    expect(body.value).toBe('<span style="font-size:1.25em">Size</span> me');
  });
  it.skip('preserves bold/size styling when pasting rich text', async () => {
    render(<AdminPage />);
    fireEvent.click(screen.getByRole('tab', { name: /Create Article/i }));
    const body = await screen.findByLabelText(/Body \(optional\)/i);
    // simulate HTML paste
    const pasteEvent = new ClipboardEvent('paste', {
      clipboardData: new DataTransfer(),
    });
    pasteEvent.clipboardData.setData('text/html', '<strong>Hi</strong>');
    body.focus();
    fireEvent(body, pasteEvent);
    expect(body.value).toBe('<strong>Hi</strong>');
  });

  it.skip('sends ignoreSimilarity flag when checkbox is checked', async () => {
    const createSpy = jest.spyOn(SiteService.prototype, 'createManualArticle')
      .mockResolvedValue({ status: 'inserted', id: 1, category: 'today', isKentucky: true, county: null });

    render(<AdminPage />);
    fireEvent.click(screen.getByRole('tab', { name: /Create Article/i }));
    const title = await screen.findByLabelText(/Title \*/i);
    const checkbox = screen.getByLabelText(/Bypass automatic title similarity check/i);
    fireEvent.change(title, { target: { value: 'Unique title' } });
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByText(/Publish Article/i));
    await screen.findByText(/Article published/i);
    expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({ ignoreSimilarity: true }));
    createSpy.mockRestore();
  });



  it('shows server error text when ingest request throws', async () => {
    const ingestSpy = jest.spyOn(SiteService.prototype, 'previewIngestUrl')
      .mockRejectedValue({ errorMessage: 'boom!' });

    render(<AdminPage />);
    fireEvent.click(screen.getByText(/Create Article/i));
    const urlInput = await screen.findByPlaceholderText('https://example.com/article-url');
    fireEvent.change(urlInput, { target: { value: 'https://example.com/bad' } });
    fireEvent.click(screen.getByText(/Ingest Article/i));

    const error = await screen.findByText(/boom!/i);
    expect(error).toBeInTheDocument();

    ingestSpy.mockRestore();
  });

  it('displays rejection reason when preview returns rejected status', async () => {
    const ingestSpy = jest.spyOn(SiteService.prototype, 'previewIngestUrl')
      .mockResolvedValue({ status: 'rejected', reason: 'short content' });

    render(<AdminPage />);
    fireEvent.click(screen.getByText(/Create Article/i));
    const urlInput = await screen.findByPlaceholderText('https://example.com/article-url');
    fireEvent.change(urlInput, { target: { value: 'https://example.com/bad' } });
    fireEvent.click(screen.getByText(/Ingest Article/i));

    const msg = await screen.findByText(/Rejected: short content/i);
    expect(msg).toBeInTheDocument();

    ingestSpy.mockRestore();
  });

  it('performs preview then confirm flow and shows final success message (with site link)', async () => {
    const previewSpy = jest.spyOn(SiteService.prototype, 'previewIngestUrl')
      .mockResolvedValue({ status: 'inserted', id: 42, category: 'today', isKentucky: true, county: 'Floyd', title: 'Test title' });
    const adminSpy = jest.spyOn(SiteService.prototype, 'adminIngestUrl')
      .mockResolvedValue({ status: 'inserted', id: 42, category: 'today', isKentucky: true, county: null, title: 'Test title', slug: 'test-slug' });

    render(<AdminPage />);
    fireEvent.click(screen.getByText(/Create Article/i));
    const urlInput = await screen.findByPlaceholderText('https://example.com/article-url');
    fireEvent.change(urlInput, { target: { value: 'https://example.com/test' } });
    fireEvent.click(screen.getByText(/Ingest Article/i));

    // preview step shown
    const previewMsg = await screen.findByText(/Preview — category:/i);
    expect(previewMsg).toBeInTheDocument();

    fireEvent.click(screen.getByText(/Confirm — Add to Site/i));
    const finalMsg = await screen.findByText(/✅ Added to site/i);
    expect(finalMsg).toBeInTheDocument();
    expect(adminSpy).toHaveBeenCalledWith('https://example.com/test');

    // link should render using slug-based path
    const link = await screen.findByRole('link', { name: /View on site/i });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute('href', '/news/kentucky/test-slug');

    previewSpy.mockRestore();
    adminSpy.mockRestore();
  });

  it('shows rejection message when confirm ingest returns rejected', async () => {
    const previewSpy = jest.spyOn(SiteService.prototype, 'previewIngestUrl')
      .mockResolvedValue({ status: 'inserted', id: 13, category: 'today', isKentucky: false, title: 'X' });
    const adminSpy = jest.spyOn(SiteService.prototype, 'adminIngestUrl')
      .mockResolvedValue({ status: 'rejected', reason: 'duplicate' });

    render(<AdminPage />);
    fireEvent.click(screen.getByText(/Create Article/i));
    const urlInput = await screen.findByPlaceholderText('https://example.com/article-url');
    fireEvent.change(urlInput, { target: { value: 'https://example.com/dup' } });
    fireEvent.click(screen.getByText(/Ingest Article/i));

    await screen.findByText(/Preview — category:/i);
    fireEvent.click(screen.getByText(/Confirm — Add to Site/i));

    const rejMsg = await screen.findByText(/Rejected: duplicate/i);
    expect(rejMsg).toBeInTheDocument();

    previewSpy.mockRestore();
    adminSpy.mockRestore();
  });

  it('normalizes manual body newlines before submission', async () => {
    const createSpy = jest.spyOn(SiteService.prototype, 'createManualArticle')
      .mockResolvedValue({ status: 'inserted', id: 1, category: 'today', isKentucky: true, county: null });

    render(<AdminPage />);
    fireEvent.click(screen.getByRole('tab', { name: /Create Article/i }));
    const title = await screen.findByLabelText(/Title \*/i);
    const body = screen.getByLabelText(/Body \(optional\)/i);
    fireEvent.change(title, { target: { value: 'Norm test' } });
    // include 4 consecutive newlines which should collapse to two
    fireEvent.change(body, { target: { value: 'Para1\n\n\n\nPara2' } });
    fireEvent.click(screen.getByText(/Publish Article/i));

    await screen.findByText(/Article published/i);
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'Para1\n\nPara2' })
    );
    createSpy.mockRestore();
  });

  it('uploads a selected image file before submitting manual article', async () => {
    // use a relative proxy URL to mimic real upload response
    const uploadSpy = jest.spyOn(SiteService.prototype, 'uploadAdminImage')
      .mockResolvedValue({ url: '/api/media/foo.jpg', key: 'abc' });
    const createSpy = jest.spyOn(SiteService.prototype, 'createManualArticle')
      .mockResolvedValue({ status: 'inserted', id: 2, category: 'today', isKentucky: true, county: null });

    render(<AdminPage />);
    fireEvent.click(screen.getByRole('tab', { name: /Create Article/i }));

    // label should be visible to user
    expect(screen.getByText(/Image \(optional\)/i)).toBeInTheDocument();

    // choose file via hidden input (use test id)
    const fileInput = screen.getByTestId('manual-image-file');
    const file = new File(['hi'], 'test.png', { type: 'image/png' });
    fireEvent.change(fileInput, { target: { files: [file] } });

    // wait for upload to complete (uploadSpy called)
    await screen.findByText(/URL:/i);
    expect(uploadSpy).toHaveBeenCalledWith(file);

    // fill required title and submit
    const title = screen.getByLabelText(/Title \*/i);
    fireEvent.change(title, { target: { value: 'With image' } });
    fireEvent.click(screen.getByText(/Publish Article/i));
    await screen.findByText(/Article published/i);
    expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({ imageUrl: '/api/media/foo.jpg' }));

    uploadSpy.mockRestore();
    createSpy.mockRestore();
  });

  it('pressing Enter in search field triggers filtering', async () => {
    const listSpy = jest.spyOn(SiteService.prototype, 'getAdminArticles')
      .mockResolvedValue({ items: [], nextCursor: null });

    render(<AdminPage />);
    // go to Articles tab to render search box
    fireEvent.click(screen.getByRole('tab', { name: /Articles/i }));
    // initial load should call once
    await screen.findByText(/Articles/i);
    expect(listSpy).toHaveBeenCalledTimes(1);

    const search = await screen.findByLabelText(/Search/i);
    fireEvent.change(search, { target: { value: 'foo' } });
    fireEvent.keyDown(search, { key: 'Enter', code: 'Enter', charCode: 13 });

    // expect a second call from applyFilter
    expect(listSpy).toHaveBeenCalledTimes(2);
    listSpy.mockRestore();
  });

  it('allows editing an article image field with a relative media URL', async () => {
    // return a single article row for the Articles tab
    jest.spyOn(SiteService.prototype, 'getAdminArticles').mockResolvedValue({
      items: [{
        id: 1,
        title: 'Test',
        publishedAt: new Date().toISOString(),
        category: 'today',
        isKentucky: 1,
        counties: [],
        county: null,
        canonicalUrl: 'https://example.com',
        sourceUrl: 'https://example.com',
        slug: null,
        status: 'Live',
        imageUrl: '',
      }],
      nextCursor: null,
    });

    const updateSpy = jest.spyOn(SiteService.prototype, 'updateAdminArticleContent')
      .mockResolvedValue({});

    render(<AdminPage />);
    fireEvent.click(screen.getByRole('tab', { name: /Articles/i }));
    // wait for row to render
    await screen.findByText(/Test/i);

    // click the edit button (tooltip title used as query)
    const editBtn = screen.getByTitle(/Edit title \/ summary \/ links/i);
    fireEvent.click(editBtn);

    const imageField = await screen.findByLabelText(/Image URL/i);
    fireEvent.change(imageField, { target: { value: '/api/media/foo.jpg' } });
    fireEvent.click(screen.getByText(/Save Content/i));

    await waitFor(() => expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({ imageUrl: '/api/media/foo.jpg' })));

    updateSpy.mockRestore();
  });

  it('shows rejection message when preview returns rejected', async () => {
    const previewSpy = jest.spyOn(SiteService.prototype, 'previewIngestUrl')
      .mockResolvedValue({ status: 'rejected', reason: 'fetch fail' });

    render(<AdminPage />);
    fireEvent.click(screen.getByText(/Create Article/i));
    const urlInput = await screen.findByPlaceholderText('https://example.com/article-url');
    fireEvent.change(urlInput, { target: { value: 'https://example.com/bad' } });
    fireEvent.click(screen.getByText(/Ingest Article/i));

    const msg = await screen.findByText(/Rejected: fetch fail/i);
    expect(msg).toBeInTheDocument();

    previewSpy.mockRestore();
  });

  it('renders check-update button and shows result when clicked', async () => {
    // return a single article row for the Articles tab
    jest.spyOn(SiteService.prototype, 'getAdminArticles').mockResolvedValue({
      items: [{
        id: 1,
        title: 'Test',
        publishedAt: new Date().toISOString(),
        category: 'today',
        isKentucky: 1,
        counties: [],
        county: null,
        canonicalUrl: 'https://example.com',
        sourceUrl: 'https://example.com',
        slug: null,
        status: 'Live',
      }],
      nextCursor: null,
    });

    // first verify dashboard-level update check button
    const adminSpy = jest.spyOn(SiteService.prototype, 'adminCheckUpdates')
      .mockResolvedValue({ ok: true });

    render(<AdminPage />);
    fireEvent.click(screen.getByRole('tab', { name: /Dashboard/i }));
    const dashBtn = await screen.findByText(/Check recent updates/i);
    fireEvent.click(dashBtn);
    const dashMsg = await screen.findByText(/Update-check job enqueued/i);
    expect(dashMsg).toBeInTheDocument();
    expect(adminSpy).toHaveBeenCalled();
    adminSpy.mockRestore();

    // next ensure row-level button still works
    const checkSpy = jest.spyOn(SiteService.prototype, 'checkArticleUpdate')
      .mockResolvedValue({ ok: true, updated: true, updateParagraph: 'added update' });

    fireEvent.click(screen.getByRole('tab', { name: /Articles/i }));
    const button = await screen.findByText(/Check update/i);
    fireEvent.click(button);

    const resultRow = await screen.findByText(/Update check:/i);
    expect(resultRow).toBeInTheDocument();
    expect(checkSpy).toHaveBeenCalledWith({ id: 1 });

    checkSpy.mockRestore();
  });

  it.skip('displays server rejection reason when createManualArticle returns rejected', async () => {
    const createSpy = jest.spyOn(SiteService.prototype, 'createManualArticle')
      .mockResolvedValue({ status: 'rejected', message: 'too similar' });

    render(<AdminPage />);
    fireEvent.click(screen.getByText(/Create Article/i));
    const title = await screen.findByLabelText(/Title \*/i);
    fireEvent.change(title, { target: { value: 'Foo' } });
    fireEvent.click(screen.getByText(/Publish Article/i));
    const error = await screen.findByText(/too similar/i);
    expect(error).toBeInTheDocument();
    createSpy.mockRestore();
  });

  it.skip('shows scheduled label when publishing with future date', async () => {
    const createSpy = jest.spyOn(SiteService.prototype, 'createManualArticle')
      .mockResolvedValue({ status: 'inserted', id: 123, category: 'today', isKentucky: true, county: null });

    render(<AdminPage />);
    fireEvent.click(screen.getByText(/Create Article/i));
    const title = await screen.findByLabelText(/Title \*/i);
    const body = screen.getByLabelText(/Body \(optional\)/i);
    const dateInput = screen.getByLabelText(/Date & Time/i);
    fireEvent.change(title, { target: { value: 'Sched' } });
    fireEvent.change(body, { target: { value: 'Test' } });
    const future = new Date(Date.now() + 3600 * 1000).toISOString().slice(0, 16);
    fireEvent.change(dateInput, { target: { value: future } });

    fireEvent.click(screen.getByText(/Publish Article/i));
    // wait for async logic
    await screen.findByText(/Article scheduled/i);
    expect(createSpy).toHaveBeenCalled();
    createSpy.mockRestore();
  });});