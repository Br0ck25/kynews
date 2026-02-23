import React from "react";
import "./App.css";
import { BrowserRouter as Router, Switch, Route } from "react-router-dom";

import TodayPage from "./pages/today-page";
import NationalPage from "./pages/national-page";
import SportsPage from "./pages/sports-page";
import WeatherPage from "./pages/weather-page";
import SchoolsPage from "./pages/schools-page";
import ObituariesPage from "./pages/obituaries-page";
import SettingsPage from "./pages/settings-page";
import LocalPage from "./pages/local-page";
import CountyPage from "./pages/county-page";
import LabelBottomNavigation from "./components/bottom-navigation";
import AppHeader from "./components/app-header";
import SearchPage from "./pages/search-page";
import SavedPage from "./pages/saved-page";
import PostPage from "./pages/post-page";
import FavoritesPage from "./pages/favorites-page";
import LostFoundPage from "./pages/lost-found-page";
import SectionsHeader from "./components/home/sections-component";
import { Container, Box } from "@material-ui/core";
import CssBaseline from "@material-ui/core/CssBaseline";
import { isMobile } from "./utils/functions";
import { Provider, useDispatch } from "react-redux";
import store from "./redux/store/store";
import Theme from "./components/theme";
import SiteService from "./services/siteService";
import { setSelectedCounties } from "./redux/actions/actions";

function AppTagSync() {
  const dispatch = useDispatch();
  const service = new SiteService(process.env.REACT_APP_API_BASE_URL);

  React.useEffect(() => {
    service.getTags().then((tags) => {
      const selected = (tags || [])
        .filter((t) => t.active)
        .map((t) => t.value);
      dispatch(setSelectedCounties(selected));
    });
  }, [dispatch, service]);

  return null;
}

const SECTIONS = [
  { title: "Today", url: "/today" },
  { title: "National", url: "/national" },
  { title: "Sports", url: "/sports" },
  { title: "Weather", url: "/weather" },
  { title: "Schools", url: "/schools" },
  { title: "Obituaries", url: "/obituaries" },
  { title: "Lost & Found", url: "/lost-found" },
];

function App() {
  return (
    <Provider store={store}>
      <Theme>
        <CssBaseline />
        <Router>
          <div className="App">
            <AppHeader />

            <AppTagSync />

            <SectionsHeader sections={SECTIONS} />

            <Container>
              <Box>
                <Switch>
                  <Route exact path="/">
                    <TodayPage />
                  </Route>
                  <Route path="/today">
                    <TodayPage />
                  </Route>
                  <Route path="/national">
                    <NationalPage />
                  </Route>
                  <Route path="/sports">
                    <SportsPage />
                  </Route>
                  <Route path="/weather">
                    <WeatherPage />
                  </Route>
                  <Route path="/schools">
                    <SchoolsPage />
                  </Route>
                  <Route path="/obituaries">
                    <ObituariesPage />
                  </Route>
                  <Route path="/search">
                    <SearchPage />
                  </Route>
                  <Route path="/local">
                    <LocalPage />
                  </Route>
                  <Route exact path="/news">
                    <LocalPage />
                  </Route>
                  <Route path="/news/:countySlug">
                    <CountyPage />
                  </Route>
                  <Route path="/lost-found">
                    <LostFoundPage />
                  </Route>
                  <Route path="/favorites">
                    <FavoritesPage />
                  </Route>
                  <Route path="/saved">
                    <SavedPage />
                  </Route>
                  <Route path="/settings">
                    <SettingsPage />
                  </Route>
                  <Route path="/post">
                    <PostPage />
                  </Route>
                </Switch>
              </Box>
            </Container>
            <br />
            <br />
            <br />
            <br />
            {isMobile() && <LabelBottomNavigation />}
          </div>
        </Router>
      </Theme>
    </Provider>
  );
}

export default App;
