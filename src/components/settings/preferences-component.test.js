import React from 'react';
import { render, fireEvent } from '@testing-library/react';
import Preferences from './preferences-component';
import { Provider } from 'react-redux';
import store from '../../redux/store/store';

describe('SettingsForm / Preferences component', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('requests notification permission when a feed toggle is enabled', () => {
    const requestSpy = jest.fn().mockResolvedValue('granted');
    global.Notification = { requestPermission: requestSpy, permission: 'default' };

    const { container } = render(
      <Provider store={store}>
        <Preferences />
      </Provider>
    );

    const input = container.querySelector('input[name="notif_today"]');
    expect(input).not.toBeNull();
    fireEvent.click(input);
    expect(requestSpy).toHaveBeenCalled();
  });
});
