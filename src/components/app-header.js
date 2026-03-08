import React, { useState } from "react";
import { makeStyles } from "@material-ui/core/styles";
import AppBar from "@material-ui/core/AppBar";
import Toolbar from "@material-ui/core/Toolbar";
import Typography from "@material-ui/core/Typography";
import IconButton from '@material-ui/core/IconButton';
import MenuIcon from '@material-ui/icons/Menu';
import SideBarMenu from './sidebar-menu-component';
import Constants from "../constants/constants";
import logo from "../../localkynews.png"; // image to use in header

const useStyles = makeStyles((theme) => ({
  root: {
    flexGrow: 1,
    // spacer is handled by a dummy Toolbar below the AppBar – we no longer
    // rely on marginBottom to push content down, since the bar is fixed.
  },
  toolbar: {
    minHeight: "56px",
  },
  title: {
    flexGrow: 1,
    textAlign: "center",
    fontWeight: 700,
    letterSpacing: 0.2,
  },
  logo: {
    maxHeight: 40,
    width: 'auto',
    margin: '0 auto',
    display: 'block',
  },
  appBar: {
    backgroundColor: theme.palette.background.paper,
    borderBottom: `1px solid ${theme.palette.divider}`,
    boxShadow: "0 4px 14px rgba(0,0,0,.04)",
    // keep default zIndex (theme.zIndex.appBar) so that the drawer,
    // which uses theme.zIndex.drawer (higher), will overlap the bar and
    // reveal its close icon on desktop persistent menus.
  },
}));

export default function AppHeader() {
  const classes = useStyles();
  const headerTitle = Constants.appName;

  const [open, setOpen] = useState(false);

  return (
    <div className={classes.root}>
      {/* make the bar fixed so it stays at the very top of the viewport */}
      <AppBar position="fixed" color="default" className={classes.appBar}>
        <Toolbar className={classes.toolbar}>
          <IconButton
            edge="start"
            className={classes.menuButton}
            color="inherit"
            aria-label="menu"
            onClick={() => setOpen(true)}
          >
            <MenuIcon />
          </IconButton>
          {/* display logo instead of text title */}
          <img src={logo} alt={headerTitle} className={classes.logo} />
        </Toolbar>
      </AppBar>

      {/* invisible toolbar used purely as a spacer so the rest of the page
          doesn’t end up underneath the fixed header */}
      <Toolbar />

      <SideBarMenu open={open} handleOpen={() => setOpen(!open)}/>
    </div>
  );
}
