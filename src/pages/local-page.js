import React from "react";
import { makeStyles } from "@material-ui/core/styles";
import {
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Typography,
} from "@material-ui/core";
import { KENTUCKY_COUNTIES } from "../constants/counties";
import { useHistory } from "react-router-dom";
import { countyToSlug } from "../utils/functions";

const useStyles = makeStyles((theme) => ({
  root: {
    marginTop: theme.spacing(2),
  },
  formControl: {
    minWidth: 200,
  },
}));

export default function LocalPage() {
  const classes = useStyles();
  const history = useHistory();
  const [county, setCounty] = React.useState("");

  const handleChange = (event) => {
    const val = event.target.value;
    setCounty(val);
    // navigate to the slug-based county page
    const slug = countyToSlug(val);
    if (slug) {
      history.push(`/news/${slug}`);
    }
  };

  return (
    <div className={classes.root}>
      <Typography variant="h5" gutterBottom>
        Local KY News
      </Typography>
      <FormControl className={classes.formControl} variant="outlined" size="small">
        <InputLabel id="select-county-label">Select county...</InputLabel>
        <Select
          labelId="select-county-label"
          value={county}
          onChange={handleChange}
          label="Select county..."
        >
          {KENTUCKY_COUNTIES.map((c) => (
            <MenuItem key={c} value={c}>
              {c}
            </MenuItem>
          ))}
        </Select>
      </FormControl>
      <Typography variant="body2" style={{ marginTop: 8 }}>
        Choose a county to open its dedicated local page.
      </Typography>
    </div>
  );
}