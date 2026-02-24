import React from 'react';
import { render, screen } from '@testing-library/react';
import App from './App';

test('renders app title', async () => {
  render(<App />);
  const titleElements = await screen.findAllByText(/local ky news|kentucky news|kentucky today/i);
  expect(titleElements.length).toBeGreaterThan(0);
});
