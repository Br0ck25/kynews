import React from 'react';
import { render, screen } from '@testing-library/react';
import CountyQuickFacts from './county-quick-facts';

describe('CountyQuickFacts component', () => {
  it('renders hierarchy when facts exist', () => {
    render(<CountyQuickFacts countyName="Bell" />);
    expect(screen.getByText(/Quick Facts/i)).toBeInTheDocument();
    expect(screen.getByText(/Government & Offices/i)).toBeInTheDocument();
    expect(screen.getByText(/Sheriff’s Office/i)).toBeInTheDocument();
    // header text and one of the link labels both contain "Schools";
    // verify we at least find two occurrences so we're not matching an unrelated element
    const schoolMatches = screen.getAllByText(/Schools/i);
    expect(schoolMatches.length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/Bell County Schools/i)).toBeInTheDocument();
  });

  it('returns null when county has no data', () => {
    const { container } = render(<CountyQuickFacts countyName="Unknown" />);
    expect(container.firstChild).toBeNull();
  });
});
