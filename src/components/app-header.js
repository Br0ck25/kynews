import React, { useState } from "react";
import { makeStyles } from "@material-ui/core/styles";
import AppBar from "@material-ui/core/AppBar";
import Toolbar from "@material-ui/core/Toolbar";
import Typography from "@material-ui/core/Typography";
import IconButton from '@material-ui/core/IconButton';
import MenuIcon from '@material-ui/icons/Menu';
import SideBarMenu from './sidebar-menu-component';
import Constants from "../constants/constants";

const useStyles = makeStyles((theme) => ({
  root: {
    flexGrow: 1,
    // when AppBar is fixed we need a spacer so the rest of the
    // layout doesn't slide underneath it
    marginBottom: theme.spacing(2),
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
  appBar: {
    backgroundColor: theme.palette.background.paper,
    borderBottom: `1px solid ${theme.palette.divider}`,
    boxShadow: "0 4px 14px rgba(0,0,0,.04)",
    zIndex: theme.zIndex.appBar,
  },
  // helper for the fixed toolbar offset
  offset: theme.mixins.toolbar,
}));

export default function AppHeader() {
  const classes = useStyles();
  const headerTitle = Constants.appName;

  const [open, setOpen] = useState(false);

  return (
    <div className={classes.root}>
      {/* fixed position guarantees the header and hamburger stay on
          screen.  We insert an "offset" div afterwards so the page
          content doesn't slip underneath. */}
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
          <Typography variant="h6" className={classes.title}>
            {headerTitle}
          </Typography>
        </Toolbar>
      </AppBar>

      {/* spacer matches the AppBar height (theme.mixins.toolbar) */}
      <div className={classes.offset} />

      <SideBarMenu open={open} handleOpen={() => setOpen(!open)}/>
    </div>
  );
}
