import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import store from '../redux/store/store';
import SavedPage from './saved-page';
import Constants from '../constants/constants';

// ensure localStorage is clean before each test
import { setFullscreenCounty } from '../redux/actions/actions';

beforeEach(() => {
  localStorage.clear();
  // reset redux fullscreen county state
  store.dispatch(setFullscreenCounty(null));
});

test('clicking a saved county opens it in fullscreen (redux dispatch)', () => {
  // put one saved county in storage
  localStorage.setItem(
    `${Constants.localStoragePrefix}savedCounties`,
    JSON.stringify(['Fayette'])
  );

  render(
    <Provider store={store}>
      <SavedPage />
    </Provider>
  );

  // chip should appear
  const chip = screen.getByText(/Fayette County/i);
  fireEvent.click(chip);

  expect(store.getState().fullscreenCounty).toBe('fayette-county');
});
