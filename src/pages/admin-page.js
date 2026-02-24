import React, { useEffect, useState } from "react";
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
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
import ExpandMoreIcon from "@material-ui/icons/ExpandMore";
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
  const [articleCursor, setArticleCursor] = useState(null);
  const [hasMoreArticles, setHasMoreArticles] = useState(false);
  const [loadingMoreArticles, setLoadingMoreArticles] = useState(false);
  const [savingId, setSavingId] = useState(null);
  const [deletingId, setDeletingId] = useState(null);
  const [blockedRows, setBlockedRows] = useState([]);
  const [unblockingId, setUnblockingId] = useState(null);

  const [edits, setEdits] = useState({});

  const loadData = async () => {
    if (!authorized) return;
    setLoading(true);
    setError("");
    try {
      const [sourceResp, articleResp, blockedResp] = await Promise.all([
        service.getAdminSources(),
        service.getAdminArticles({ category: articleCategoryFilter, search: articleSearch, limit: 200 }),
        service.getBlockedArticles(),
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
      const initialItems = articleResp.items || [];
      setArticleRows(initialItems);
      setArticleCursor(articleResp.nextCursor || null);
      setHasMoreArticles(Boolean(articleResp.nextCursor));
      setBlockedRows(blockedResp?.items || []);
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
        limit: 200,
      });
      const initialItems = articleResp.items || [];
      setArticleRows(initialItems);
      setArticleCursor(articleResp.nextCursor || null);
      setHasMoreArticles(Boolean(articleResp.nextCursor));
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
      setArticleRows((prev) =>
        prev.map((item) =>
          item.id === row.id
            ? {
                ...item,
                category: patch.category ?? row.category,
                isKentucky: patch.isKentucky ?? row.isKentucky,
                county: patch.county ?? row.county,
                publishedAt: patch.publishedAt ?? row.publishedAt,
              }
            : item
        )
      );
      setEdits((prev) => ({
        ...prev,
        [row.id]: {},
      }));
    } catch (err) {
      console.error(err);
      setError(err?.errorMessage || "Retag failed.");
    } finally {
      setSavingId(null);
    }
  };

  const saveDateTime = async (row) => {
    const patch = edits[row.id] || {};
    const publishedAt = patch.publishedAt ?? row.publishedAt;
    if (!publishedAt) {
      setError("Published date/time is required.");
      return;
    }

    setSavingId(row.id);
    setError("");
    try {
      const payload = await service.updateAdminArticleDateTime({ id: row.id, publishedAt });
      const nextPublishedAt = payload?.publishedAt || publishedAt;
      setArticleRows((prev) =>
        prev.map((item) =>
          item.id === row.id
            ? {
                ...item,
                publishedAt: nextPublishedAt,
              }
            : item
        )
      );
      setEdits((prev) => ({
        ...prev,
        [row.id]: {
          ...(prev[row.id] || {}),
          publishedAt: nextPublishedAt,
        },
      }));
    } catch (err) {
      console.error(err);
      setError(err?.errorMessage || "Unable to update date/time.");
    } finally {
      setSavingId(null);
    }
  };

  const deleteArticle = async (row, shouldBlock) => {
    const confirmed = window.confirm(
      shouldBlock
        ? `Delete article #${row.id} and block it from future ingestion?`
        : `Delete article #${row.id}?`
    );
    if (!confirmed) return;

    setDeletingId(row.id);
    setError("");
    try {
      await service.deleteAdminArticle({
        id: row.id,
        block: shouldBlock,
        reason: shouldBlock ? "Blocked by admin console" : "",
      });
      setArticleRows((prev) => prev.filter((item) => item.id !== row.id));
      if (shouldBlock) {
        const blockedResp = await service.getBlockedArticles();
        setBlockedRows(blockedResp?.items || []);
      }
    } catch (err) {
      console.error(err);
      setError(err?.errorMessage || "Unable to delete article.");
    } finally {
      setDeletingId(null);
    }
  };

  const unblockArticle = async (blockedItem) => {
    if (!blockedItem?.id) return;
    setUnblockingId(blockedItem.id);
    setError("");
    try {
      await service.unblockArticle({ id: blockedItem.id });
      setBlockedRows((prev) => prev.filter((item) => item.id !== blockedItem.id));
    } catch (err) {
      console.error(err);
      setError(err?.errorMessage || "Unable to unblock article.");
    } finally {
      setUnblockingId(null);
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
    setArticleCursor(null);
    setHasMoreArticles(false);
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

  const loadMoreArticles = async () => {
    if (!hasMoreArticles || !articleCursor || loadingMoreArticles) return;
    setLoadingMoreArticles(true);
    try {
      const response = await service.getAdminArticles({
        category: articleCategoryFilter,
        search: articleSearch,
        limit: 200,
        cursor: articleCursor,
      });

      const nextItems = response.items || [];
      setArticleRows((prev) => [...prev, ...nextItems]);
      setArticleCursor(response.nextCursor || null);
      setHasMoreArticles(Boolean(response.nextCursor));
    } catch (err) {
      setError(err?.errorMessage || "Unable to load more articles.");
    } finally {
      setLoadingMoreArticles(false);
    }
  };

  const getLocalArticleLink = (id) => `https://localkynews.com/post?articleId=${id}`;

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

        <Accordion defaultExpanded={false}>
          <AccordionSummary expandIcon={<ExpandMoreIcon />}>
            <Typography variant="subtitle2">Rejected ({rejections.length})</Typography>
          </AccordionSummary>
          <AccordionDetails style={{ display: "block", padding: 0 }}>
            {rejections.length === 0 ? (
              <Typography variant="body2" color="textSecondary" style={{ padding: 12 }}>
                No rejected samples captured in the latest run.
              </Typography>
            ) : (
              <Table size="small" style={{ marginBottom: 12 }}>
            <TableHead>
              <TableRow>
                <TableCell>URL</TableCell>
                <TableCell>Reason</TableCell>
                <TableCell>Source</TableCell>
                <TableCell>Local</TableCell>
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
                    {item.id ? (
                      <Button
                        size="small"
                        variant="outlined"
                        color="primary"
                        href={getLocalArticleLink(item.id)}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Open
                      </Button>
                    ) : (
                      "—"
                    )}
                  </TableCell>
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
          </AccordionDetails>
        </Accordion>

        <Accordion defaultExpanded={false}>
          <AccordionSummary expandIcon={<ExpandMoreIcon />}>
            <Typography variant="subtitle2">Duplicates ({duplicateItems.length})</Typography>
          </AccordionSummary>
          <AccordionDetails style={{ display: "block", padding: 0 }}>
            {duplicateItems.length === 0 ? (
              <Typography variant="body2" color="textSecondary" style={{ padding: 12 }}>
                No duplicate samples captured in the latest run.
              </Typography>
            ) : (
              <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>URL</TableCell>
                <TableCell>Reason</TableCell>
                <TableCell>Source</TableCell>
                <TableCell>Local</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {duplicateItems.slice(0, 100).map((item, index) => (
                <TableRow key={`${item.url}-dup-${index}`}>
                  <TableCell style={{ maxWidth: 300, overflowWrap: "anywhere" }}>{item.url}</TableCell>
                  <TableCell>{item.reason || "duplicate"}</TableCell>
                  <TableCell style={{ maxWidth: 220, overflowWrap: "anywhere" }}>{item.sourceUrl || "—"}</TableCell>
                  <TableCell>
                    {item.id ? (
                      <Button
                        size="small"
                        variant="outlined"
                        color="primary"
                        href={getLocalArticleLink(item.id)}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Open
                      </Button>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
            )}
          </AccordionDetails>
        </Accordion>
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
          <Chip label={`Loaded: ${articleRows.length}`} size="small" />
        </Box>

        {loading ? (
          <CircularProgress size={24} />
        ) : (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>ID</TableCell>
                <TableCell>Title</TableCell>
                <TableCell>Published (UTC)</TableCell>
                <TableCell>Category</TableCell>
                <TableCell>KY</TableCell>
                <TableCell>County</TableCell>
                <TableCell>Links</TableCell>
                <TableCell>Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {articleRows.map((row) => {
                const edit = edits[row.id] || {};
                const currentCategory = edit.category ?? row.category;
                const currentKy = edit.isKentucky ?? row.isKentucky;
                const currentCounty = edit.county ?? row.county ?? "";
                const currentPublishedAt = edit.publishedAt ?? row.publishedAt ?? "";

                return (
                  <TableRow key={row.id}>
                    <TableCell>{row.id}</TableCell>
                    <TableCell style={{ maxWidth: 420, overflowWrap: "anywhere" }}>{row.title}</TableCell>
                    <TableCell>
                      <TextField
                        variant="outlined"
                        size="small"
                        type="datetime-local"
                        value={toDateTimeLocalValue(currentPublishedAt)}
                        onChange={(e) => setEdit(row.id, { publishedAt: fromDateTimeLocalValue(e.target.value) })}
                        InputLabelProps={{ shrink: true }}
                      />
                    </TableCell>
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
                      <Box style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        <Button
                          size="small"
                          variant="outlined"
                          color="primary"
                          href={getLocalArticleLink(row.id)}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          Local
                        </Button>
                        <Button
                          size="small"
                          variant="outlined"
                          color="default"
                          href={row.canonicalUrl || row.sourceUrl || "#"}
                          target="_blank"
                          rel="noopener noreferrer"
                          disabled={!row.canonicalUrl && !row.sourceUrl}
                        >
                          Source
                        </Button>
                      </Box>
                    </TableCell>
                    <TableCell>
                      <Box style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        <Button
                          size="small"
                          variant="contained"
                          color="primary"
                          disabled={savingId === row.id}
                          onClick={() => saveRetag(row)}
                        >
                          {savingId === row.id ? "Saving..." : "Save tags"}
                        </Button>
                        <Button
                          size="small"
                          variant="outlined"
                          color="primary"
                          disabled={savingId === row.id}
                          onClick={() => saveDateTime(row)}
                        >
                          Save date/time
                        </Button>
                        <Button
                          size="small"
                          variant="outlined"
                          color="secondary"
                          disabled={deletingId === row.id}
                          onClick={() => deleteArticle(row, false)}
                        >
                          Delete
                        </Button>
                        <Button
                          size="small"
                          variant="contained"
                          color="secondary"
                          disabled={deletingId === row.id}
                          onClick={() => deleteArticle(row, true)}
                        >
                          {deletingId === row.id ? "Working..." : "Delete + Block"}
                        </Button>
                      </Box>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}

        <Box style={{ marginTop: 10, display: "flex", justifyContent: "flex-end" }}>
          <Button
            variant="contained"
            color="primary"
            disabled={!hasMoreArticles || loadingMoreArticles}
            onClick={loadMoreArticles}
          >
            {loadingMoreArticles ? "Loading..." : hasMoreArticles ? "Load More" : "No More Articles"}
          </Button>
        </Box>
      </Paper>

      <Paper style={{ padding: 16, marginTop: 16 }}>
        <Typography variant="h6" gutterBottom>
          Blocked Articles
        </Typography>
        <Typography variant="body2" color="textSecondary" gutterBottom>
          Blocked URLs are rejected during future ingest runs.
        </Typography>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>ID</TableCell>
              <TableCell>URL</TableCell>
              <TableCell>Reason</TableCell>
              <TableCell>Blocked At</TableCell>
              <TableCell>Action</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {blockedRows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5}>No blocked articles.</TableCell>
              </TableRow>
            ) : (
              blockedRows.map((item) => (
                <TableRow key={`blocked-${item.id}`}>
                  <TableCell>{item.id}</TableCell>
                  <TableCell style={{ maxWidth: 420, overflowWrap: "anywhere" }}>
                    {item.canonicalUrl || item.sourceUrl || "—"}
                  </TableCell>
                  <TableCell>{item.reason || "—"}</TableCell>
                  <TableCell>{item.createdAt || "—"}</TableCell>
                  <TableCell>
                    <Button
                      size="small"
                      variant="outlined"
                      color="primary"
                      disabled={unblockingId === item.id}
                      onClick={() => unblockArticle(item)}
                    >
                      {unblockingId === item.id ? "Unblocking..." : "Unblock"}
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Paper>
    </Box>
  );
}

function toDateTimeLocalValue(isoValue) {
  if (!isoValue) return "";
  const date = new Date(isoValue);
  if (!Number.isFinite(date.getTime())) return "";

  const pad = (v) => String(v).padStart(2, "0");
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

function fromDateTimeLocalValue(value) {
  if (!value) return "";
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return "";
  return parsed.toISOString();
}
