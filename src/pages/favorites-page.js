import React from "react";
import { makeStyles } from "@material-ui/core/styles";
import ChipsComponent from "../components/favorites/chips-component";
import Typography from "@material-ui/core/Typography";

const useStyles = makeStyles({
  root: {},
});

export default function FavoritesPage() {
  const classes = useStyles();

  return (
    <div className={classes.root}>
      <Typography variant="h5" gutterBottom>
        County Feed Filters
      </Typography>
      <Typography variant="body2" gutterBottom>
        Select one or more counties. Home feed will show only matching county
        stories.
      </Typography>
      <ChipsComponent />
    </div>
  );
}
