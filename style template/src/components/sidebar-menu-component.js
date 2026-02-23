import React, { useEffect } from "react";
import { makeStyles } from "@material-ui/core/styles";
import Drawer from "@material-ui/core/Drawer";
import CssBaseline from "@material-ui/core/CssBaseline";
import List from "@material-ui/core/List";
import Divider from "@material-ui/core/Divider";
import IconButton from "@material-ui/core/IconButton";
import ChevronLeftIcon from "@material-ui/icons/ChevronLeft";
import ListItem from "@material-ui/core/ListItem";
import ListItemIcon from "@material-ui/core/ListItemIcon";
import ListItemText from "@material-ui/core/ListItemText";
import SearchIcon from "@material-ui/icons/Search";
import HomeIcon from "@material-ui/icons/Home";
import FavoriteIcon from "@material-ui/icons/Favorite";
import SettingsIcon from "@material-ui/icons/Settings";
import LocationOnIcon from "@material-ui/icons/LocationOn";
import { useHistory } from "react-router-dom";
import Constants from "../constants/constants";
import { useDispatch } from "react-redux";
import { setTitle } from "../redux/actions/actions";

const drawerWidth = 240;

const useStyles = makeStyles((theme) => ({
  root: {
    display: "flex",
  },
  appBar: {
    transition: theme.transitions.create(["margin", "width"], {
      easing: theme.transitions.easing.sharp,
      duration: theme.transitions.duration.leavingScreen,
    }),
  },
  appBarShift: {
    width: calc(100% - px),
    marginLeft: drawerWidth,
    transition: theme.transitions.create(["margin", "width"], {
      easing: theme.transitions.easing.easeOut,
      duration: theme.transitions.duration.enteringScreen,
    }),
  },
  menuButton: {
    marginRight: theme.spacing(2),
  },
  hide: {
    display: "none",
  },
  drawer: {
    width: drawerWidth,
    flexShrink: 0,
  },
  drawerPaper: {
    width: drawerWidth,
  },
  drawerHeader: {
    display: "flex",
    alignItems: "center",
    padding: theme.spacing(0, 1),
    ...theme.mixins.toolbar,
    justifyContent: "space-between",
    minHeight: "44px !important",
  },
}));

export default function SideBarMenu({ open, handleOpen }) {
  const classes = useStyles();
  const history = useHistory();
  const [value, setValue] = React.useState(history.location.pathname);
  const dispatch = useDispatch();

  const handleTitle = (title) => dispatch(setTitle(title));

  const setTitleByRoute = (value) => {
    switch (value) {
      case "/":
      case "/today":
        handleTitle("Kentucky Today");
        break;
      case "/local":
        handleTitle("Local News");
        break;
      case "/search":
        handleTitle("Search");
        break;
      case "/saved":
        handleTitle("Saved");
        break;
      case "/settings":
        handleTitle("Settings");
        break;
      default:
        handleTitle(Constants.appName);
        break;
    }
  };

  const handleChange = (newValue) => {
    history.push(newValue);
    setValue(newValue);
  };

  const isSelected = (route) => {
    return history.location.pathname === route;
  };

  useEffect(() => {
    setTitleByRoute(value);
  }, [value]);

  return (
    <div className={classes.root}>
      <CssBaseline />
      <Drawer
        className={classes.drawer}
        variant="persistent"
        anchor="left"
        open={open}
        classes={{
          paper: classes.drawerPaper,
        }}
      >
        <div className={classes.drawerHeader}>
          <span style={{ margin: "0 auto" }}>{Constants.appName}</span>
          <IconButton onClick={handleOpen}>
            <ChevronLeftIcon />
          </IconButton>
        </div>
        <Divider />
        <List>
          <ListItem
            button
            key={1}
            selected={isSelected("/today") || isSelected("/")}
            onClick={() => handleChange("/today")}
          >
            <ListItemIcon>
              <HomeIcon />
            </ListItemIcon>
            <ListItemText primary="Home" />
          </ListItem>
          <ListItem
            button
            key={2}
            selected={isSelected("/search")}
            onClick={() => handleChange("/search")}
          >
            <ListItemIcon>
              <SearchIcon />
            </ListItemIcon>
            <ListItemText primary="Search" />
          </ListItem>
          <ListItem
            button
            key={3}
            selected={isSelected("/local")}
            onClick={() => handleChange("/local")}
          >
            <ListItemIcon>
              <LocationOnIcon />
            </ListItemIcon>
            <ListItemText primary="Local News" />
          </ListItem>
          <ListItem
            button
            key={4}
            selected={isSelected("/saved")}
            onClick={() => handleChange("/saved")}
          >
            <ListItemIcon>
              <FavoriteIcon />
            </ListItemIcon>
            <ListItemText primary="Saved" />
          </ListItem>
          <ListItem
            button
            key={5}
            selected={isSelected("/settings")}
            onClick={() => handleChange("/settings")}
          >
            <ListItemIcon>
              <SettingsIcon />
            </ListItemIcon>
            <ListItemText primary="Settings" />
          </ListItem>
        </List>
      </Drawer>
    </div>
  );
}
