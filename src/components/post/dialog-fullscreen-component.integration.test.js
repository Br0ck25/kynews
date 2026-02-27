import React from 'react';
import { render, fireEvent, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import store from '../../redux/store/store';
import FullScreenPostDialog from './dialog-fullscreen-component';
import { setPost, setFullscreenCounty } from '../../redux/actions/actions';

const Wrapped = ({ children }) => <Provider store={store}>{children}</Provider>;

describe('FullScreenPostDialog integration', () => {
  beforeEach(() => {
    store.dispatch(setPost(null));
    store.dispatch(setFullscreenCounty(null));
  });

  it('when county is open then clicking an article should show only the article', () => {
    // open county
    store.dispatch(setFullscreenCounty('jefferson-county'));
    const { rerender } = render(<Wrapped><FullScreenPostDialog countySlug="jefferson-county" /></Wrapped>);
    // county heading present
    expect(screen.getAllByText(/Jefferson County/i).length).toBeGreaterThan(0);

    // now simulate article open
    const dummy = { title: 'Dummy Article' };
    store.dispatch(setPost(dummy));
    rerender(<Wrapped><FullScreenPostDialog post={dummy} countySlug="jefferson-county" /></Wrapped>);

    // article title appears and county content should not be visible anymore
    expect(screen.getByText(/Dummy Article/i)).toBeInTheDocument();
    // the county heading count should now be just one maybe still? we assert not multiple
    const matches = screen.queryAllByText(/Jefferson County/i);
    // Only the content paragraph could still include county name; ensure heading gone
    expect(matches.some(el => el.tagName === 'H5')).toBe(false);
  });
});
