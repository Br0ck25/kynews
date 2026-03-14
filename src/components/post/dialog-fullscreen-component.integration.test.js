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

  it('when county is open then clicking an article should show and close in dialog', () => {
    // open county
    store.dispatch(setFullscreenCounty('jefferson-county'));
    const handleClose = () => store.dispatch(setPost(null));
    const { rerender, getByLabelText } = render(
      <Wrapped><FullScreenPostDialog countySlug="jefferson-county" onClose={handleClose} /></Wrapped>
    );

    // county heading present
    expect(screen.getAllByText(/Jefferson County/i).length).toBeGreaterThan(0);

    // simulate article open
    const dummy = { title: 'Dummy Article' };
    store.dispatch(setPost(dummy));
    rerender(<Wrapped><FullScreenPostDialog post={dummy} countySlug="jefferson-county" onClose={handleClose} /></Wrapped>);
    expect(screen.getByText(/Dummy Article/i)).toBeInTheDocument();

    // close article via fab and verify county heading returns
    fireEvent.click(getByLabelText('close'));
    rerender(<Wrapped><FullScreenPostDialog countySlug="jefferson-county" onClose={handleClose} /></Wrapped>);
    expect(screen.queryByText(/Dummy Article/i)).toBeNull();
    expect(screen.getAllByText(/Jefferson County/i).length).toBeGreaterThan(0);
  });

  it('info button clicks open the appropriate subpage in the dialog', async () => {
    store.dispatch(setFullscreenCounty('leslie-county'));
    const handleClose = () => store.dispatch(setFullscreenCounty(null));
    const { rerender } = render(<Wrapped><FullScreenPostDialog countySlug="leslie-county" onClose={handleClose} /></Wrapped>);

    // click government offices and verify its content appears
    fireEvent.click(screen.getByText(/Government Offices/i));
    expect(await screen.findByText(/Primary Elected Officials/i)).toBeInTheDocument();

    // close the inner info dialog (last close button corresponds to it)
    const closeBtns = screen.getAllByLabelText('close');
    fireEvent.click(closeBtns[closeBtns.length - 1]);

    // now the underlying county view is visible again, click utilities
    fireEvent.click(screen.getByText(/Utilities/i));
    expect(await screen.findByText(/Electric Utilities/i)).toBeInTheDocument();
  });
});
