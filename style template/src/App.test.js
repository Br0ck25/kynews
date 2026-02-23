import React from 'react';
import { render, screen } from '@testing-library/react';
import App from './App';

test('renders app title in header', () => {
  render(<App />);
  const titleElements = screen.getAllByText(/Kentucky News/i);
  expect(titleElements.length).toBeGreaterThan(0);
});
