import React from 'react';
import { render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import store from '../../redux/store/store';
import FullScreenPostDialog from './dialog-fullscreen-component';
import { setPost, setFullscreenCounty } from '../../redux/actions/actions';

// helper to wrap in provider
const Wrapped = ({ children }) => <Provider store={store}>{children}</Provider>;

describe('FullScreenPostDialog', () => {
  beforeEach(() => {
    store.dispatch(setPost(null));
    store.dispatch(setFullscreenCounty(null));
  });

  it('renders nothing when no post or countySlug', () => {
    render(<Wrapped><FullScreenPostDialog /></Wrapped>);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows post when store has post', () => {
    const dummy = { title: 'Test' };
    store.dispatch(setPost(dummy));
    render(<Wrapped><FullScreenPostDialog post={dummy} /></Wrapped>);
    expect(screen.getByText(/Test/)).toBeInTheDocument();
  });

  it('shows county page when countySlug set', () => {
    store.dispatch(setFullscreenCounty('jefferson-county'));
    render(<Wrapped><FullScreenPostDialog countySlug="jefferson-county" /></Wrapped>);
    const matches = screen.getAllByText(/Jefferson County/i);
    expect(matches.length).toBeGreaterThan(0);
  });
});
