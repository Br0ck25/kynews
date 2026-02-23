import React from 'react';
import { render, screen } from '@testing-library/react';
import App from './App';

test('renders kentucky news title', () => {
  render(<App />);
  const titleElements = screen.getAllByText(/kentucky news|kentucky today/i);
  expect(titleElements.length).toBeGreaterThan(0);
});
