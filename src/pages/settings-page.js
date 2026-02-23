import React, { useState } from "react";
import { makeStyles } from "@material-ui/core/styles";
import Paper from "@material-ui/core/Paper";
import Typography from "@material-ui/core/Typography";
import List from "@material-ui/core/List";
import ListItem from "@material-ui/core/ListItem";
import ListItemText from "@material-ui/core/ListItemText";
import Button from "@material-ui/core/Button";
import Grid from "@material-ui/core/Grid";
import { useHistory } from "react-router-dom";
import { GetValue, SaveValue } from "../services/storageService";
import { useDispatch } from "react-redux";
import { setSelectedCounties } from "../redux/actions/actions";

import SettingsForm from "../components/settings/preferences-component";
import ChipsComponent from "../components/favorites/chips-component";

const useStyles = makeStyles((theme) => ({
  section: {
    marginBottom: theme.spacing(3),
    padding: theme.spacing(2),
  },
  sectionTitle: {
    marginBottom: theme.spacing(1),
  },
  buttons: {
    display: "flex",
    marginBottom: theme.spacing(1),
    "& > *": {
      marginRight: theme.spacing(1),
    },
  },
}));

export default function SettingsPage() {
  const classes = useStyles();
  const history = useHistory();
  const dispatch = useDispatch();
  const [tags, setTags] = useState([]);
  const [chipsKey, setChipsKey] = useState(0);

  const navigate = (path) => history.push(path);

  const clearSelection = () => {
    const existing = GetValue("tags") || [];
    const cleared = existing.map((t) => ({ ...t, active: false }));
    SaveValue("tags", cleared);
    setTags(cleared);
    dispatch(setSelectedCounties([]));
    setChipsKey((k) => k + 1);
  };

  const handleTagsChange = (updated) => {
    setTags(updated);
  };

  return (
    <>
      <Paper className={classes.section}>
        <Typography variant="h6" className={classes.sectionTitle}>
          Appearance
        </Typography>
        <SettingsForm />
      </Paper>

      <Paper className={classes.section}>
        <Typography variant="h6" className={classes.sectionTitle}>
          Shortcuts
        </Typography>
        <List>
          <ListItem button onClick={() => navigate("/local")}> 
            <ListItemText
              primary="Local News"
              secondary="Set your local county"
            />
          </ListItem>
          <ListItem button onClick={() => navigate("/today")}> 
            <ListItemText
              primary="Home Feed"
              secondary="View Today with current filters"
            />
          </ListItem>
          <ListItem button onClick={() => navigate("/saved")}> 
            <ListItemText
              primary="Saved Articles"
            />
          </ListItem>
        </List>
      </Paper>

      <Paper className={classes.section}>
        <Typography variant="h6" className={classes.sectionTitle}>
          County Feed Filters
        </Typography>
        <Typography variant="body2" gutterBottom>
          Select one or more counties. Home feed will show only matching county
          stories.
        </Typography>
        <div className={classes.buttons}>
          <Button variant="outlined" onClick={clearSelection}>
            Clear Selection
          </Button>
          <Button
            variant="contained"
            color="primary"
            onClick={() => navigate("/today")}
          >
            View Home Feed
          </Button>
        </div>
        <ChipsComponent key={chipsKey} showControls={false} onChange={handleTagsChange} />
      </Paper>
    </>
  );
}
