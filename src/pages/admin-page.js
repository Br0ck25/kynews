import React, { useEffect, useState } from "react";
import {
  Box,
  Button,
  Chip,
  CircularProgress,
  FormControl,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from "@material-ui/core";
import SiteService from "../services/siteService";

const service = new SiteService(process.env.REACT_APP_API_BASE_URL);
const CATEGORIES = ["today", "national", "sports", "weather", "schools", "obituaries"];

export default function AdminPage() {
  const [loading, setLoading] = useState(true);
  const [sources, setSources] = useState([]);
  const [sourceSummary, setSourceSummary] = useState(null);

  const [articleCategoryFilter, setArticleCategoryFilter] = useState("all");
  const [articleSearch, setArticleSearch] = useState("");
  const [articleRows, setArticleRows] = useState([]);
  const [savingId, setSavingId] = useState(null);

  const [edits, setEdits] = useState({});

  const loadData = async () => {
    setLoading(true);
    try {
      const [sourceResp, articleResp] = await Promise.all([
        service.getAdminSources(),
        service.getAdminArticles({ category: articleCategoryFilter, search: articleSearch, limit: 40 }),
      ]);
      setSources(sourceResp.items || []);
      setSourceSummary(sourceResp);
      setArticleRows(articleResp.items || []);
      setEdits({});
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applyFilter = async () => {
    setLoading(true);
    try {
      const articleResp = await service.getAdminArticles({
        category: articleCategoryFilter,
        search: articleSearch,
        limit: 40,
      });
      setArticleRows(articleResp.items || []);
      setEdits({});
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const setEdit = (id, patch) => {
    setEdits((prev) => ({
      ...prev,
      [id]: {
        ...(prev[id] || {}),
        ...patch,
      },
    }));
  };

  const saveRetag = async (row) => {
    const patch = edits[row.id] || {};
    setSavingId(row.id);
    try {
      await service.retagArticle({
        id: row.id,
        category: patch.category ?? row.category,
        isKentucky: patch.isKentucky ?? row.isKentucky,
        county: patch.county ?? row.county,
      });
      await applyFilter();
    } catch (err) {
      console.error(err);
    } finally {
      setSavingId(null);
    }
  };

  return (
    <Box>
      <Typography variant="h5" gutterBottom>
        Admin Console
      </Typography>
      <Typography variant="body2" color="textSecondary" gutterBottom>
        Hidden route for moderation and source health checks.
      </Typography>

      <Paper style={{ padding: 16, marginBottom: 16 }}>
        <Typography variant="h6" gutterBottom>
          Source Health
        </Typography>
        {sourceSummary && (
          <Box style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
            <Chip label={`Configured: ${sourceSummary.totalConfiguredSources || 0}`} />
            <Chip label={`Active: ${sourceSummary.activeSources || 0}`} color="primary" />
            <Chip label={`No articles yet: ${sourceSummary.inactiveSources || 0}`} />
          </Box>
        )}
        {loading ? (
          <CircularProgress size={24} />
        ) : (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Source</TableCell>
                <TableCell align="right">Articles</TableCell>
                <TableCell>Latest Published</TableCell>
                <TableCell>Status</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {sources.slice(0, 200).map((row) => (
                <TableRow key={row.sourceUrl}>
                  <TableCell style={{ maxWidth: 420, overflowWrap: "anywhere" }}>{row.sourceUrl}</TableCell>
                  <TableCell align="right">{row.articleCount}</TableCell>
                  <TableCell>{row.latestPublishedAt || "—"}</TableCell>
                  <TableCell>
                    <Chip size="small" label={row.status} color={row.status === "active" ? "primary" : "default"} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Paper>

      <Paper style={{ padding: 16 }}>
        <Typography variant="h6" gutterBottom>
          Retag Articles
        </Typography>

        <Box style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
          <FormControl variant="outlined" size="small" style={{ minWidth: 180 }}>
            <InputLabel>Category</InputLabel>
            <Select
              value={articleCategoryFilter}
              onChange={(e) => setArticleCategoryFilter(e.target.value)}
              label="Category"
            >
              <MenuItem value="all">all</MenuItem>
              {CATEGORIES.map((c) => (
                <MenuItem key={c} value={c}>{c}</MenuItem>
              ))}
            </Select>
          </FormControl>
          <TextField
            variant="outlined"
            size="small"
            label="Search"
            value={articleSearch}
            onChange={(e) => setArticleSearch(e.target.value)}
          />
          <Button variant="contained" color="primary" onClick={applyFilter}>Refresh</Button>
          <Button variant="outlined" onClick={loadData}>Reload All</Button>
        </Box>

        {loading ? (
          <CircularProgress size={24} />
        ) : (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>ID</TableCell>
                <TableCell>Title</TableCell>
                <TableCell>Category</TableCell>
                <TableCell>KY</TableCell>
                <TableCell>County</TableCell>
                <TableCell>Save</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {articleRows.map((row) => {
                const edit = edits[row.id] || {};
                const currentCategory = edit.category ?? row.category;
                const currentKy = edit.isKentucky ?? row.isKentucky;
                const currentCounty = edit.county ?? row.county ?? "";

                return (
                  <TableRow key={row.id}>
                    <TableCell>{row.id}</TableCell>
                    <TableCell style={{ maxWidth: 420, overflowWrap: "anywhere" }}>{row.title}</TableCell>
                    <TableCell>
                      <FormControl variant="outlined" size="small" style={{ minWidth: 140 }}>
                        <Select
                          value={currentCategory}
                          onChange={(e) => setEdit(row.id, { category: e.target.value })}
                        >
                          {CATEGORIES.map((c) => (
                            <MenuItem key={c} value={c}>{c}</MenuItem>
                          ))}
                        </Select>
                      </FormControl>
                    </TableCell>
                    <TableCell>
                      <Select
                        value={currentKy ? "yes" : "no"}
                        variant="outlined"
                        size="small"
                        onChange={(e) => setEdit(row.id, { isKentucky: e.target.value === "yes" })}
                      >
                        <MenuItem value="yes">yes</MenuItem>
                        <MenuItem value="no">no</MenuItem>
                      </Select>
                    </TableCell>
                    <TableCell>
                      <TextField
                        variant="outlined"
                        size="small"
                        value={currentCounty}
                        onChange={(e) => setEdit(row.id, { county: e.target.value })}
                        placeholder="optional"
                      />
                    </TableCell>
                    <TableCell>
                      <Button
                        size="small"
                        variant="contained"
                        color="primary"
                        disabled={savingId === row.id}
                        onClick={() => saveRetag(row)}
                      >
                        {savingId === row.id ? "Saving..." : "Save"}
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Paper>
    </Box>
  );
}
