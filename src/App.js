import React, { lazy, Suspense } from "react";
import "./App.css";
import { BrowserRouter as Router, Switch, Route } from "react-router-dom";

// ObituariesPage and LostFoundPage kept for future use
// import ObituariesPage from "./pages/obituaries-page";
// import LostFoundPage from "./pages/lost-found-page";
import LabelBottomNavigation from "./components/bottom-navigation";
import AppHeader from "./components/app-header";
import SectionsHeader from "./components/home/sections-component";
import { Container, Box, CircularProgress } from "@material-ui/core";
import CssBaseline from "@material-ui/core/CssBaseline";
import { isMobile } from "./utils/functions"; // kept for potential future use
import { Provider, useDispatch } from "react-redux";
import store from "./redux/store/store";
import Theme from "./components/theme";
import SiteService from "./services/siteService";
import { setSelectedCounties } from "./redux/actions/actions";

const TodayPage = lazy(() => import("./pages/today-page"));
const NationalPage = lazy(() => import("./pages/national-page"));
const SportsPage = lazy(() => import("./pages/sports-page"));
const WeatherPage = lazy(() => import("./pages/weather-page"));
const SchoolsPage = lazy(() => import("./pages/schools-page"));
const SettingsPage = lazy(() => import("./pages/settings-page"));
const LocalPage = lazy(() => import("./pages/local-page"));
const CountyPage = lazy(() => import("./pages/county-page"));
const SearchPage = lazy(() => import("./pages/search-page"));
const SavedPage = lazy(() => import("./pages/saved-page"));
const PostPage = lazy(() => import("./pages/post-page"));
const FavoritesPage = lazy(() => import("./pages/favorites-page"));
const AdminPage = lazy(() => import("./pages/admin-page"));

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
  // Obituaries and Lost & Found hidden — may be re-enabled later
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

            <Container component="main" role="main" aria-label="Main content">
              <Box>
                <Suspense
                  fallback={
                    <Box style={{ display: "flex", justifyContent: "center", padding: 24 }}>
                      <CircularProgress size={28} />
                    </Box>
                  }
                >
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
                    {/* Obituaries and Lost & Found routes disabled — pages kept for future use
                    <Route path="/obituaries"><ObituariesPage /></Route>
                    <Route path="/lost-found"><LostFoundPage /></Route>
                    */}
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
                    <Route path="/admin">
                      <AdminPage />
                    </Route>
                  </Switch>
                </Suspense>
              </Box>
            </Container>
            <br />
            <br />
            <br />
            <br />
            {/* Show bottom nav on all screen sizes */}
            <LabelBottomNavigation />
          </div>
        </Router>
      </Theme>
    </Provider>
  );
}

export default App;
