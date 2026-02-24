import React, { useState } from "react";
import PropTypes from "prop-types";
import { makeStyles, useTheme } from "@material-ui/core/styles";
import useMediaQuery from "@material-ui/core/useMediaQuery";
import Toolbar from "@material-ui/core/Toolbar";
import Tab from "@material-ui/core/Tab";
import Tabs from "@material-ui/core/Tabs";
import { useHistory, useLocation } from "react-router-dom";

const useStyles = makeStyles((theme) => ({
  toolbar: {
    borderBottom: `1px solid ${theme.palette.divider}`,
  },
  toolbarTitle: {
    flex: 1,
  },
  toolbarSecondary: {
    justifyContent: "center",
    overflowX: "auto",
  },
  toolbarLink: {
    padding: theme.spacing(1),
    flexShrink: 0,
    // borderRadius: '50%',
    // width: 100,
    // height: 100,
    // padding: 10,
    // marginRight: 5,
    // border: '1px solid red'
  },
}));

function a11yProps(index) {
  // aria-controls omitted: there are no corresponding tabpanel elements in
  // this navigation bar — pointing to non-existent IDs is an ARIA violation.
  return {
    id: `scrollable-auto-tab-${index}`,
  };
}

export default function SectionsHeader(props) {
  const classes = useStyles();
  const theme = useTheme();
  const isDesktop = useMediaQuery(theme.breakpoints.up("md"));
  const history = useHistory();
  const location = useLocation();
  const { sections } = props;
  const [value, setValue] = useState(() => {
    const idx = sections.findIndex((s) => s.url === location.pathname);
    if (idx >= 0) {
      return { id: idx, value: sections[idx].title };
    }
    // not on a known section; don't select any
    return { id: false, value: "" };
  });

  const handleTabChange = (event, val) => {
    const section = sections[val];
    if (section && section.url) {
      history.push(section.url);
    }
    setValue({ id: val, value: section?.title || "" });
  };

  return (
    <React.Fragment>
      {/* <Toolbar className={classes.toolbar}>
        <Button size="small">Subscribe</Button>
        <Typography
          component="h2"
          variant="h5"
          color="inherit"
          align="center"
          noWrap
          className={classes.toolbarTitle}
        >
          {title}
        </Typography>
        <IconButton>
          <SearchIcon />
        </IconButton>
        <Button variant="outlined" size="small">
          Sign up
        </Button>
      </Toolbar> */}
      <Toolbar
        component="nav"
        variant="dense"
        className={classes.toolbarSecondary}
      >
        <Tabs
          value={value.id !== false ? value.id : false}
          onChange={handleTabChange}
          indicatorColor="primary"
          textColor="primary"
          variant={isDesktop ? "standard" : "scrollable"}
          centered={isDesktop}
          scrollButtons="auto"
          aria-label="Site navigation sections"
        >
          {sections.map((section, index) => (
            <Tab key={index} label={section.title} {...a11yProps(index)} />
          ))}
        </Tabs>
      </Toolbar>
    </React.Fragment>
  );
}

SectionsHeader.propTypes = {
  sections: PropTypes.array,
  title: PropTypes.string,
};
