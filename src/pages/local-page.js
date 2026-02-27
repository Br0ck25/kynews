import React from "react";
import { makeStyles, useTheme } from "@material-ui/core/styles";
import { Typography, Chip, Box, useMediaQuery } from "@material-ui/core";
import { KENTUCKY_COUNTIES } from "../constants/counties";
import { countyToSlug } from "../utils/functions";
import { useDispatch } from "react-redux";
import { setFullscreenCounty } from "../redux/actions/actions";

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
  const dispatch = useDispatch();


  return (
    <div className={classes.root}>
      <Typography variant="h5" gutterBottom>
        Local KY News
      </Typography>
      <Typography variant="body1" gutterBottom>
        Click a county to view its dedicated local page:
      </Typography>
      {/* Render counties in 4 balanced rows */}
      {(() => {
        const total = KENTUCKY_COUNTIES.length;
        const theme = useTheme();
        const isSmall = useMediaQuery(theme.breakpoints.down("sm"));
        const columnsCount = isSmall ? 2 : 4;
        const base = Math.floor(total / columnsCount);
        const rem = total % columnsCount;
        const cols = [];
        let start = 0;
        for (let i = 0; i < columnsCount; i++) {
          const size = base + (i < rem ? 1 : 0);
          cols.push(KENTUCKY_COUNTIES.slice(start, start + size));
          start += size;
        }

        // Render as N vertical columns; on small screens this will be 2 columns
        return (
          <Box style={{ display: "flex", gap: 16, marginTop: 8, flexWrap: "wrap" }}>
            {cols.map((col, ci) => (
                  <Box key={ci} style={{ flex: 1, minWidth: isSmall ? "45%" : 0, display: "flex", flexDirection: "column", gap: 8 }}>
                    {col.map((c) => (
                      <div key={c} style={{ textDecoration: "none" }}>
                        <Chip
                          label={`${c} County`}
                          clickable
                          color="primary"
                          variant="outlined"
                          onClick={() => dispatch(setFullscreenCounty(countyToSlug(c)))}
                        />
                      </div>
                    ))}
                  </Box>
                ))}
          </Box>
        );
      })()}
    </div>
  );
}