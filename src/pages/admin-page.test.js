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
});