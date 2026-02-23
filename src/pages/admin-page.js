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
  const [password, setPassword] = useState("");
  const [authorized, setAuthorized] = useState(Boolean(service.getAdminPanelKey()));
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [sources, setSources] = useState([]);
  const [sourceSummary, setSourceSummary] = useState(null);
  const [metrics, setMetrics] = useState(null);
  const [rejections, setRejections] = useState([]);
  const [duplicateItems, setDuplicateItems] = useState([]);
  const [publishingUrl, setPublishingUrl] = useState("");

  const [articleCategoryFilter, setArticleCategoryFilter] = useState("all");
  const [articleSearch, setArticleSearch] = useState("");
  const [articleRows, setArticleRows] = useState([]);
  const [savingId, setSavingId] = useState(null);

  const [edits, setEdits] = useState({});

  const loadData = async () => {
    if (!authorized) return;
    setLoading(true);
    setError("");
    try {
      const [sourceResp, articleResp] = await Promise.all([
        service.getAdminSources(),
        service.getAdminArticles({ category: articleCategoryFilter, search: articleSearch, limit: 40 }),
      ]);
      const [metricsResp, rejectResp] = await Promise.all([
        service.getAdminMetrics(),
        service.getAdminRejections(),
      ]);
      setSources(sourceResp.items || []);
      setSourceSummary(sourceResp);
      setMetrics(metricsResp?.latest || null);
      setRejections(rejectResp?.items || []);
      setDuplicateItems(rejectResp?.duplicateItems || []);
      setArticleRows(articleResp.items || []);
      setEdits({});
    } catch (err) {
      console.error(err);
      setError(err?.errorMessage || "Unable to load admin data. Check password and worker deployment.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (authorized) loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authorized]);

  const applyFilter = async () => {
    if (!authorized) return;
    setLoading(true);
    setError("");
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
      setError(err?.errorMessage || "Unable to filter articles.");
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
      setError(err?.errorMessage || "Retag failed.");
    } finally {
      setSavingId(null);
    }
  };

  const unlockAdmin = async () => {
    setError("");
    service.setAdminPanelKey(password);
    try {
      await service.getAdminSources();
      setAuthorized(true);
      setPassword("");
    } catch (err) {
      setAuthorized(false);
      service.setAdminPanelKey("");
      setError(err?.errorMessage || "Invalid admin password.");
    }
  };

  const lockAdmin = () => {
    service.setAdminPanelKey("");
    setAuthorized(false);
    setSources([]);
    setArticleRows([]);
    setSourceSummary(null);
    setMetrics(null);
    setRejections([]);
    setDuplicateItems([]);
  };

  const publishRejectedItem = async (item) => {
    if (!item?.url) return;
    setPublishingUrl(item.url);
    setError("");
    try {
      await service.publishAdminRejection({
        url: item.url,
        sourceUrl: item.sourceUrl,
        providedTitle: item.title,
        feedPublishedAt: item.publishedAt,
      });
      await loadData();
    } catch (err) {
      setError(err?.errorMessage || "Unable to publish rejected item.");
    } finally {
      setPublishingUrl("");
    }
  };

  const triggerIngest = async () => {
    setError("");
    try {
      await service.adminIngest({ includeSchools: true, limitPerSource: 0 });
      await loadData();
    } catch (err) {
      setError(err?.errorMessage || "Unable to start ingest.");
    }
  };

  const purgeAndReingest = async () => {
    // eslint-disable-next-line no-alert
    const confirmed = window.confirm("This will DELETE all article rows and start re-ingest. Continue?");
    if (!confirmed) return;
    setError("");
    try {
      await service.adminPurgeAndReingest({ includeSchools: true, limitPerSource: 0 });
      await loadData();
    } catch (err) {
      setError(err?.errorMessage || "Purge/re-ingest failed.");
    }
  };

  if (!authorized) {
    return (
      <Box>
        <Typography variant="h5" gutterBottom>
          Admin Console
        </Typography>
        <Typography variant="body2" color="textSecondary" gutterBottom>
          Enter admin password to continue.
        </Typography>
        <Paper style={{ padding: 16, maxWidth: 420 }}>
          <TextField
            fullWidth
            variant="outlined"
            size="small"
            label="Admin Password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <Box style={{ marginTop: 12, display: "flex", gap: 8 }}>
            <Button variant="contained" color="primary" onClick={unlockAdmin}>
              Unlock
            </Button>
          </Box>
          {error && (
            <Typography color="error" variant="body2" style={{ marginTop: 10 }}>
              {error}
            </Typography>
          )}
        </Paper>
      </Box>
    );
  }

  return (
    <Box>
      <Typography variant="h5" gutterBottom>
        Admin Console
      </Typography>
      <Typography variant="body2" color="textSecondary" gutterBottom>
        Hidden route for moderation and source health checks.
      </Typography>
      <Box style={{ marginBottom: 12 }}>
        <Button size="small" variant="outlined" onClick={lockAdmin}>Lock admin panel</Button>
        <Button size="small" variant="contained" color="primary" onClick={triggerIngest} style={{ marginLeft: 8 }}>
          Ingest new articles
        </Button>
        <Button size="small" variant="contained" color="secondary" onClick={purgeAndReingest} style={{ marginLeft: 8 }}>
          Purge + Re-ingest
        </Button>
      </Box>

      {metrics && (
        <Paper style={{ padding: 12, marginBottom: 16 }}>
          <Typography variant="subtitle2" gutterBottom>Admin Metrics (Latest Ingest)</Typography>
          <Box style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Chip size="small" label={`Rate/min: ${metrics.ingestRatePerMinute ?? 0}`} color="primary" />
            <Chip size="small" label={`Inserted: ${metrics.inserted ?? 0}`} />
            <Chip size="small" label={`Duplicates: ${metrics.duplicate ?? 0}`} />
            <Chip size="small" label={`Rejected: ${metrics.rejected ?? 0}`} />
            <Chip size="small" label={`Low-word discards: ${metrics.lowWordDiscards ?? 0}`} />
          </Box>
        </Paper>
      )}

      <Paper style={{ padding: 16, marginBottom: 16 }}>
        <Typography variant="h6" gutterBottom>
          Ingest Decisions (Latest Run)
        </Typography>
        <Typography variant="body2" color="textSecondary" gutterBottom>
          Rejected items can be force-published. Duplicates indicate URLs already stored by hash.
        </Typography>

        <Typography variant="subtitle2" style={{ marginTop: 8 }}>Rejected ({rejections.length})</Typography>
        {rejections.length === 0 ? (
          <Typography variant="body2" color="textSecondary">No rejected samples captured in the latest run.</Typography>
        ) : (
          <Table size="small" style={{ marginBottom: 12 }}>
            <TableHead>
              <TableRow>
                <TableCell>URL</TableCell>
                <TableCell>Reason</TableCell>
                <TableCell>Source</TableCell>
                <TableCell>Publish</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rejections.slice(0, 100).map((item, index) => (
                <TableRow key={`${item.url}-${index}`}>
                  <TableCell style={{ maxWidth: 300, overflowWrap: "anywhere" }}>{item.url}</TableCell>
                  <TableCell>{item.reason || "unknown"}</TableCell>
                  <TableCell style={{ maxWidth: 220, overflowWrap: "anywhere" }}>{item.sourceUrl || "—"}</TableCell>
                  <TableCell>
                    <Button
                      size="small"
                      variant="contained"
                      color="primary"
                      disabled={publishingUrl === item.url}
                      onClick={() => publishRejectedItem(item)}
                    >
                      {publishingUrl === item.url ? "Publishing..." : "Publish"}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        <Typography variant="subtitle2">Duplicates ({duplicateItems.length})</Typography>
        {duplicateItems.length === 0 ? (
          <Typography variant="body2" color="textSecondary">No duplicate samples captured in the latest run.</Typography>
        ) : (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>URL</TableCell>
                <TableCell>Reason</TableCell>
                <TableCell>Source</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {duplicateItems.slice(0, 100).map((item, index) => (
                <TableRow key={`${item.url}-dup-${index}`}>
                  <TableCell style={{ maxWidth: 300, overflowWrap: "anywhere" }}>{item.url}</TableCell>
                  <TableCell>{item.reason || "duplicate"}</TableCell>
                  <TableCell style={{ maxWidth: 220, overflowWrap: "anywhere" }}>{item.sourceUrl || "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Paper>
      {error && (
        <Typography color="error" variant="body2" style={{ marginBottom: 10 }}>
          {error}
        </Typography>
      )}

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
