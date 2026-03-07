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