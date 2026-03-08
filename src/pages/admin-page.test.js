import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
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

  it('calls ingestUrl and displays success message', async () => {
    const ingestSpy = jest.spyOn(SiteService.prototype, 'previewIngestUrl')
      .mockResolvedValue({ status: 'inserted', id: 42, category: 'today', isKentucky: true, county: 'Floyd' });

    render(<AdminPage />);
    fireEvent.click(screen.getByText(/Create Article/i));
    const urlInput = await screen.findByPlaceholderText('https://example.com/article-url');
    fireEvent.change(urlInput, { target: { value: 'https://example.com/test' } });
    fireEvent.click(screen.getByText(/Ingest Article/i));

    const msg = await screen.findByText(/Ingested – ID: 42, category: today, KY/);
    expect(msg).toBeInTheDocument();

    ingestSpy.mockRestore();
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