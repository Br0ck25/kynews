import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import AdminPage from './admin-page';
import SiteService from '../services/siteService';
import { Provider } from 'react-redux';
import store from '../redux/store/store';

jest.mock('../services/siteService');

// minimal smoke tests that verify the new NAT column and control exist

describe('AdminPage tagging UI', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders NAT column header', async () => {
    // mock getAdminArticles to return an empty list so page renders quickly
    jest.spyOn(SiteService.prototype, 'getAdminArticles').mockResolvedValue({ items: [], nextCursor: null });

    render(
      <Provider store={store}>
        <AdminPage />
      </Provider>
    );

    // wait for header row to appear
    await waitFor(() => expect(screen.getByText('Nat')).toBeInTheDocument());
  });
});
