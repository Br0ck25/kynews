import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import AdminPage from './admin-page';

describe('AdminPage manual body formatting', () => {
  it('wraps selected text with <strong> when Bold button is clicked', () => {
    render(<AdminPage />);
    const body = screen.getByLabelText(/Body \(optional\)/i);
    // type some text
    fireEvent.change(body, { target: { value: 'Hello world' } });
    // select the word 'world'
    body.setSelectionRange(6, 11);
    fireEvent.click(screen.getByLabelText(/Bold/i));
    expect(body.value).toBe('Hello <strong>world</strong>');
  });

  it('wraps selection with larger-font span when Larger font button is clicked', () => {
    render(<AdminPage />);
    const body = screen.getByLabelText(/Body \(optional\)/i);
    fireEvent.change(body, { target: { value: 'Size me' } });
    body.setSelectionRange(0, 4); // "Size"
    fireEvent.click(screen.getByLabelText(/Larger font/i));
    expect(body.value).toBe('<span style="font-size:1.25em">Size</span> me');
  });
  it('preserves bold/size styling when pasting rich text', () => {
    render(<AdminPage />);
    const body = screen.getByLabelText(/Body \(optional\)/i);
    // simulate HTML paste
    const pasteEvent = new ClipboardEvent('paste', {
      clipboardData: new DataTransfer(),
    });
    pasteEvent.clipboardData.setData('text/html', '<strong>Hi</strong>');
    body.focus();
    fireEvent(body, pasteEvent);
    expect(body.value).toBe('<strong>Hi</strong>');
  });

  it('sends ignoreSimilarity flag when checkbox is checked', async () => {
    const createSpy = jest.spyOn(SiteService.prototype, 'createManualArticle')
      .mockResolvedValue({ status: 'inserted', id: 1, category: 'today', isKentucky: true, county: null });

    render(<AdminPage />);
    const title = screen.getByLabelText(/Title \*/i);
    const checkbox = screen.getByLabelText(/Bypass automatic title similarity check/i);
    fireEvent.change(title, { target: { value: 'Unique title' } });
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByText(/Publish Article/i));
    await screen.findByText(/Article published/i);
    expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({ ignoreSimilarity: true }));
    createSpy.mockRestore();
  });

  it('fetches preview when ingesting a URL and populates the manual form', async () => {
    const previewSpy = jest.spyOn(SiteService.prototype, 'previewIngestUrl')
      .mockResolvedValue({
        status: 'inserted',
        title: 'Fancy Title',
        summary: 'Summary text',
        imageUrl: 'http://img.png',
        category: 'weather',
        county: 'Boone',
        isKentucky: true,
        publishedAt: '2025-01-01T12:00:00Z',
      });

    render(<AdminPage />);
    const urlInput = screen.getByPlaceholderText('https://example.com/article-url');
    fireEvent.change(urlInput, { target: { value: 'https://example.com/foo' } });
    fireEvent.click(screen.getByText(/Ingest Article/i));

    expect(previewSpy).toHaveBeenCalledWith('https://example.com/foo');

    const titleInput = await screen.findByLabelText(/Title \*/i);
    expect(titleInput.value).toBe('Fancy Title');
    expect(screen.getByLabelText(/Body \(optional\)/i).value).toBe('Summary text');
    expect(screen.getByLabelText(/Image URL/i).value).toBe('http://img.png');
    expect(screen.getByLabelText(/Category \(optional\)/i).value).toBe('weather');
    expect(screen.getByLabelText(/County \(optional\)/i).value).toBe('Boone');
    expect(screen.getByText(/Preview loaded/i)).toBeInTheDocument();

    previewSpy.mockRestore();
  });

  it('displays server rejection reason when createManualArticle returns rejected', async () => {
    const createSpy = jest.spyOn(SiteService.prototype, 'createManualArticle')
      .mockResolvedValue({ status: 'rejected', message: 'too similar' });

    render(<AdminPage />);
    const title = screen.getByLabelText(/Title \*/i);
    fireEvent.change(title, { target: { value: 'Foo' } });
    fireEvent.click(screen.getByText(/Publish Article/i));
    const error = await screen.findByText(/too similar/i);
    expect(error).toBeInTheDocument();
    createSpy.mockRestore();
  });

  it('shows scheduled label when publishing with future date', async () => {
    const createSpy = jest.spyOn(SiteService.prototype, 'createManualArticle')
      .mockResolvedValue({ status: 'inserted', id: 123, category: 'today', isKentucky: true, county: null });

    render(<AdminPage />);
    const title = screen.getByLabelText(/Title \*/i);
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