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
  },
}));

export default function AppHeader() {
  const classes = useStyles();
  const headerTitle = Constants.appName;

  const [open, setOpen] = useState(false);

  return (
    <div className={classes.root}>
      <AppBar position="sticky" color="default" className={classes.appBar}>
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

      <SideBarMenu open={open} handleOpen={() => setOpen(!open)}/>
    </div>
  );
}
