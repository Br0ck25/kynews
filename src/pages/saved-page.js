import React, { useEffect, useState } from "react";
import { makeStyles } from "@material-ui/core/styles";
import { TextField, Grid, Divider, Typography, Box, Chip, Button } from "@material-ui/core";
import { Link as RouterLink } from "react-router-dom";
import Posts from "../components/home/posts-component";
import { GetValue, GetSavedCounties, ToggleSavedCounty } from "../services/storageService";
import { countyToSlug } from "../utils/functions";
import BookmarkIcon from "@material-ui/icons/Bookmark";

const useStyles = makeStyles({
  root: {},
  gridContainer: {
    display: "flex",
    alignItems: "center",
  },
});

export default function SavedPage() {
  const classes = useStyles();

  const [searchVal, setSearchVal] = useState("");
  const [posts, setPosts] = useState();
  const [savedCounties, setSavedCounties] = useState(() => GetSavedCounties());

  useEffect(() => {
    if (searchVal.length > 2) {
      const posts = GetValue("savedPost");
      if (posts) {
        const postsFound = posts.filter(
          (item) =>
            item.title.toLowerCase().indexOf(searchVal.toLowerCase()) > -1
        );
        setPosts(postsFound);
      }
    } else {
      setPosts(GetValue("savedPost"));
    }
  }, [searchVal]);

  const handleChange = (ev) => {
    setSearchVal(ev.target.value);
  };

  const handleDelete = (post) => {
    setPosts(GetValue("savedPost"));
  };

  const handleRemoveCounty = (countyName) => {
    ToggleSavedCounty(countyName);
    setSavedCounties(GetSavedCounties());
  };

  return (
    <div className={classes.root}>
      {/* ── Saved Counties ───────────────────────────────────────── */}
      {savedCounties.length > 0 && (
        <>
          <Box style={{ padding: "12px 8px 4px", display: "flex", alignItems: "center", gap: 8 }}>
            <BookmarkIcon color="primary" style={{ fontSize: 20 }} />
            <Typography variant="subtitle1" style={{ fontWeight: 700 }}>
              Saved Counties
            </Typography>
          </Box>
          <Box style={{ display: "flex", flexWrap: "wrap", gap: 8, padding: "4px 8px 12px" }}>
            {savedCounties.map((countyName) => {
              const slug = countyToSlug(countyName);
              return (
                <Box key={countyName} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <RouterLink to={`/news/${slug}`} style={{ textDecoration: "none" }}>
                    <Chip
                      label={`${countyName} County`}
                      color="primary"
                      clickable
                      style={{ fontWeight: 600 }}
                    />
                  </RouterLink>
                  <Button
                    size="small"
                    style={{ minWidth: 0, padding: "2px 6px", color: "#999", fontSize: 11 }}
                    onClick={() => handleRemoveCounty(countyName)}
                    title="Remove from saved"
                  >
                    ×
                  </Button>
                </Box>
              );
            })}
          </Box>
          <Typography variant="caption" color="textSecondary" style={{ padding: "0 8px 8px", display: "block" }}>
            Tap a county to view its news feed. To set a county as your home feed, go to Settings → County Filters.
          </Typography>
          <Divider />
          <br />
        </>
      )}

      {/* ── Saved Articles ───────────────────────────────────────── */}
      <Grid container className={classes.gridContainer}>
        <Grid item xs={false} md={3}></Grid>
        <Grid item xs={12} md={6}>
          <TextField
            id="standard-full-width"
            label="Search saved articles"
            style={{ margin: 8 }}
            value={searchVal}
            helperText="Enter at least 3 characters"
            fullWidth
            margin="normal"
            InputLabelProps={{
              shrink: true,
            }}
            onChange={handleChange}
            autoComplete="off"
          />
        </Grid>
      </Grid>
      <Divider />
      <br />
      <Grid container>
        {posts && posts.length ? (
          <Posts posts={posts} showDelete handleDelete={handleDelete} />
        ) : (
          <h3 style={{width: "100%", textAlign: "center"}}>
            No saved articles found.
          </h3>
        )}
      </Grid>
    </div>
  );
}
