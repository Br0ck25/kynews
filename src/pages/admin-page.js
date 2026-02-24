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
  FormControlLabel,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Switch,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tabs,
  TextField,
  Typography,
} from "@material-ui/core";
import ExpandMoreIcon from "@material-ui/icons/ExpandMore";
import SiteService from "../services/siteService";
import { KENTUCKY_COUNTIES } from "../constants/counties";

const service = new SiteService(process.env.REACT_APP_API_BASE_URL);
const CATEGORIES = ["today", "national", "sports", "weather", "schools", "obituaries"];

// Articles stored with this published_at prefix are drafts — not yet live publicly
function isDraftArticle(row) {
  return Boolean(row?.publishedAt?.startsWith("9999"));
}

export default function AdminPage() {
  const [password, setPassword] = useState("");
  const [authorized, setAuthorized] = useState(Boolean(service.getAdminPanelKey()));
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  // Tab navigation: 0=Dashboard 1=Create Article 2=Articles 3=Sources 4=Blocked
  const [activeTab, setActiveTab] = useState(0);

  const [sources, setSources] = useState([]);
  const [sourceSummary, setSourceSummary] = useState(null);
  const [metrics, setMetrics] = useState(null);
  const [rejections, setRejections] = useState([]);
  const [duplicateItems, setDuplicateItems] = useState([]);
  const [publishingUrl, setPublishingUrl] = useState("");

  const [backfillResult, setBackfillResult] = useState(null);

  const [articleCategoryFilter, setArticleCategoryFilter] = useState("all");
  const [articleSearch, setArticleSearch] = useState("");
  const [showDraftsOnly, setShowDraftsOnly] = useState(false);
  const [articleRows, setArticleRows] = useState([]);
  const [articleCursor, setArticleCursor] = useState(null);
  const [hasMoreArticles, setHasMoreArticles] = useState(false);
  const [loadingMoreArticles, setLoadingMoreArticles] = useState(false);
  const [savingId, setSavingId] = useState(null);
  const [deletingId, setDeletingId] = useState(null);
  const [publishingNowId, setPublishingNowId] = useState(null);
  const [blockedRows, setBlockedRows] = useState([]);
  const [unblockingId, setUnblockingId] = useState(null);

  const [edits, setEdits] = useState({});

  // --- Manual Article Form state ---
  const [fbPostUrl, setFbPostUrl] = useState("");
  const [manualTitle, setManualTitle] = useState("");
  const [manualBody, setManualBody] = useState("");
  const [manualImageUrl, setManualImageUrl] = useState("");
  const [manualCounty, setManualCounty] = useState("");
  const [manualIsDraft, setManualIsDraft] = useState(false);
  const [manualPublishedAt, setManualPublishedAt] = useState("");
  const [manualLoading, setManualLoading] = useState(false);
  const [manualFbLoading, setManualFbLoading] = useState(false);
  const [manualSuccess, setManualSuccess] = useState(null);
  const [manualError, setManualError] = useState("");

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

  /** Publish a draft article immediately by setting its published_at to now. */
  const publishNow = async (row) => {
    setPublishingNowId(row.id);
    setError("");
    try {
      const nowIso = new Date().toISOString();
      await service.updateAdminArticleDateTime({ id: row.id, publishedAt: nowIso });
      setArticleRows((prev) =>
        prev.map((item) => item.id === row.id ? { ...item, publishedAt: nowIso } : item)
      );
    } catch (err) {
      console.error(err);
      setError(err?.errorMessage || "Unable to publish article.");
    } finally {
      setPublishingNowId(null);
    }
  };

  // ---------------------------------------------------------------------------
  // Manual Article handlers
  // ---------------------------------------------------------------------------

  /** Auto-fill title/body/image from a Facebook post URL. */
  const loadFromFacebook = async () => {
    if (!fbPostUrl.trim()) return;
    setManualFbLoading(true);
    setManualError("");
    setManualSuccess(null);
    try {
      const result = await service.previewFacebookPost(fbPostUrl.trim());
      if (result?.ok) {
        if (result.title) setManualTitle(result.title);
        if (result.body) setManualBody(result.body);
        if (result.imageUrl) setManualImageUrl(result.imageUrl);
        if (result.publishedAt && !manualPublishedAt)
          setManualPublishedAt(toDateTimeLocalValue(result.publishedAt));
      } else {
        setManualError(result?.message || "Could not auto-fill from Facebook. Fill fields manually.");
      }
    } catch (err) {
      setManualError(err?.errorMessage || "Failed to load Facebook post.");
    } finally {
      setManualFbLoading(false);
    }
  };

  /** Submit the manual article form to the worker for storage. */
  const submitManualArticle = async () => {
    if (!manualTitle.trim()) { setManualError("Title is required."); return; }
    setManualLoading(true);
    setManualError("");
    setManualSuccess(null);
    try {
      const publishedAtIso = manualPublishedAt
        ? fromDateTimeLocalValue(manualPublishedAt)
        : new Date().toISOString();
      const result = await service.createManualArticle({
        title: manualTitle.trim(),
        body: manualBody.trim() || null,
        imageUrl: manualImageUrl.trim() || null,
        sourceUrl: fbPostUrl.trim() || null,
        county: manualCounty || null,
        isDraft: manualIsDraft,
        publishedAt: publishedAtIso,
      });
      if (result?.status === "inserted") {
        const label = manualIsDraft ? "Draft saved" : "Article published";
        setManualSuccess(`${label}! ID: ${result.id} | Category: ${result.category} | County: ${result.county || "none"}`);
        setFbPostUrl(""); setManualTitle(""); setManualBody("");
        setManualImageUrl(""); setManualCounty(""); setManualIsDraft(false); setManualPublishedAt("");
        applyFilter();
      } else if (result?.status === "duplicate") {
        setManualError(`Duplicate – an article with this URL already exists (ID: ${result.id}).`);
      } else {
        setManualError("Unexpected response from server.");
      }
    } catch (err) {
      setManualError(err?.errorMessage || "Failed to create article.");
    } finally {
      setManualLoading(false);
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

  const backfillCounties = async () => {
    setError("");
    try {
      const result = await service.adminBackfillCounties({ threshold: 5 });
      setBackfillResult(result);
    } catch (err) {
      setError(err?.errorMessage || "Backfill failed.");
    }
  };

  // ---------------------------------------------------------------------------
  // Derived values
  // ---------------------------------------------------------------------------
  const draftCount = articleRows.filter(isDraftArticle).length;
  const visibleArticles = showDraftsOnly ? articleRows.filter(isDraftArticle) : articleRows;

  // ---------------------------------------------------------------------------
  // Login screen
  // ---------------------------------------------------------------------------
  if (!authorized) {
    return (
      <Box>
        <Typography variant="h5" gutterBottom>Admin Console</Typography>
        <Typography variant="body2" color="textSecondary" gutterBottom>
          Enter admin password to continue.
        </Typography>
        <Paper style={{ padding: 16, maxWidth: 420 }}>
          <TextField
            fullWidth variant="outlined" size="small"
            label="Admin Password" type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && unlockAdmin()}
          />
          <Box style={{ marginTop: 12, display: "flex", gap: 8 }}>
            <Button variant="contained" color="primary" onClick={unlockAdmin}>Unlock</Button>
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
      {/* Header bar */}
      <Box style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", marginBottom: 8 }}>
        <Typography variant="h5">Admin Console</Typography>
        <Button size="small" variant="outlined" onClick={lockAdmin}>Lock</Button>
      </Box>

      {error && (
        <Typography color="error" variant="body2" style={{ marginBottom: 10 }}>{error}</Typography>
      )}

      {/* ── Tab bar ────────────────────────────────────────────────── */}
      <Paper square style={{ marginBottom: 16 }}>
        <Tabs
          value={activeTab}
          onChange={(_, v) => setActiveTab(v)}
          indicatorColor="primary"
          textColor="primary"
          variant="scrollable"
          scrollButtons="auto"
        >
          <Tab label="Dashboard" />
          <Tab label="Create Article" />
          <Tab label={draftCount > 0 ? `Articles (${draftCount} draft${draftCount !== 1 ? "s" : ""})` : "Articles"} />
          <Tab label="Sources" />
          <Tab label="Blocked" />
        </Tabs>
      </Paper>

      {/* ================================================================ */}
      {/* TAB 0 — Dashboard                                                */}
      {/* ================================================================ */}
      {activeTab === 0 && (
        <Box>
          <Box style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
            <Button variant="contained" color="primary" onClick={triggerIngest}>
              Ingest new articles
            </Button>
            <Button variant="contained" color="secondary" onClick={purgeAndReingest}>
              Purge + Re-ingest
            </Button>
            <Button variant="contained" color="primary" onClick={backfillCounties}>
              Backfill Counties
            </Button>
            <Button variant="outlined" onClick={loadData} disabled={loading}>
              {loading ? "Loading…" : "Refresh"}
            </Button>
          </Box>

          {metrics && (
            <Paper style={{ padding: 12, marginBottom: 16 }}>
              <Typography variant="subtitle2" gutterBottom>Latest Ingest Run</Typography>
              <Box style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <Chip size="small" label={`Trigger: ${metrics.trigger ?? "—"}`} />
                <Chip size="small" label={`Rate/min: ${metrics.ingestRatePerMinute ?? 0}`} color="primary" />
                <Chip size="small" label={`Inserted: ${metrics.inserted ?? 0}`} />
                <Chip size="small" label={`Duplicates: ${metrics.duplicate ?? 0}`} />
                <Chip size="small" label={`Rejected: ${metrics.rejected ?? 0}`} />
                <Chip size="small" label={`Low-word: ${metrics.lowWordDiscards ?? 0}`} />
                <Chip size="small" label={`Duration: ${((metrics.durationMs ?? 0) / 1000).toFixed(1)}s`} />
              </Box>
            </Paper>
          )}

          {backfillResult && (
            <Paper style={{ padding: 12, marginBottom: 16 }}>
              <Typography variant="subtitle2" gutterBottom>Backfill Result</Typography>
              <pre style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(backfillResult, null, 2)}</pre>
            </Paper>
          )}

          <Paper style={{ padding: 16 }}>
            <Typography variant="h6" gutterBottom>Ingest Decisions (Latest Run)</Typography>
            <Typography variant="body2" color="textSecondary" gutterBottom>
              Rejected items can be force-published. Duplicates indicate URLs already stored.
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
                            {item.id
                              ? <Button size="small" variant="outlined" color="primary" href={getLocalArticleLink(item.id)} target="_blank" rel="noopener noreferrer">Open</Button>
                              : "—"}
                          </TableCell>
                          <TableCell>
                            <Button size="small" variant="contained" color="primary"
                              disabled={publishingUrl === item.url}
                              onClick={() => publishRejectedItem(item)}>
                              {publishingUrl === item.url ? "Publishing…" : "Publish"}
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
                            {item.id
                              ? <Button size="small" variant="outlined" color="primary" href={getLocalArticleLink(item.id)} target="_blank" rel="noopener noreferrer">Open</Button>
                              : "—"}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </AccordionDetails>
            </Accordion>
          </Paper>
        </Box>
      )}

      {/* ================================================================ */}
      {/* TAB 1 — Create Article                                           */}
      {/* ================================================================ */}
      {activeTab === 1 && (
        <Box>
          <Accordion defaultExpanded>
            <AccordionSummary expandIcon={<ExpandMoreIcon />}>
              <Typography variant="h6">Create Manual Article</Typography>
            </AccordionSummary>
            <AccordionDetails style={{ display: "block" }}>
              <Typography variant="body2" color="textSecondary" style={{ marginBottom: 12 }}>
                Paste a Facebook post URL to auto-fill — no access token needed, public pages are scraped automatically.
                Or fill fields manually. All articles are tagged as Kentucky content; category is auto-classified by AI.
                Drafts are saved privately and can be published later from the Articles tab.
              </Typography>

              {/* Facebook URL */}
              <Box style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
                <TextField
                  variant="outlined" size="small"
                  label="Facebook Post URL (optional)"
                  placeholder="https://www.facebook.com/leslieCoBOE/posts/…"
                  value={fbPostUrl}
                  onChange={(e) => setFbPostUrl(e.target.value)}
                  style={{ minWidth: 360, flex: 1 }}
                />
                <Button variant="outlined" color="primary"
                  disabled={manualFbLoading || !fbPostUrl.trim()}
                  onClick={loadFromFacebook}>
                  {manualFbLoading ? "Loading…" : "Load from Facebook"}
                </Button>
              </Box>

              {/* Title */}
              <TextField fullWidth variant="outlined" size="small"
                label="Title *"
                value={manualTitle}
                onChange={(e) => setManualTitle(e.target.value)}
                style={{ marginBottom: 12 }}
              />

              {/* Body (optional) */}
              <TextField fullWidth variant="outlined" size="small"
                label="Body (optional)"
                multiline rows={8}
                value={manualBody}
                onChange={(e) => setManualBody(e.target.value)}
                style={{ marginBottom: 12 }}
              />

              {/* Image URL */}
              <TextField fullWidth variant="outlined" size="small"
                label="Image URL (optional)"
                value={manualImageUrl}
                onChange={(e) => setManualImageUrl(e.target.value)}
                style={{ marginBottom: 12 }}
              />

              {/* Date & Time */}
              <TextField
                variant="outlined" size="small"
                label="Date & Time (optional — defaults to now)"
                type="datetime-local"
                value={manualPublishedAt}
                onChange={(e) => setManualPublishedAt(e.target.value)}
                InputLabelProps={{ shrink: true }}
                style={{ marginBottom: 12, minWidth: 280 }}
              />

              {/* County + Draft toggle */}
              <Box style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 16 }}>
                <FormControl variant="outlined" size="small" style={{ minWidth: 200 }}>
                  <InputLabel>County (optional)</InputLabel>
                  <Select
                    value={manualCounty}
                    onChange={(e) => setManualCounty(e.target.value)}
                    label="County (optional)"
                  >
                    <MenuItem value=""><em>None / let AI decide</em></MenuItem>
                    {KENTUCKY_COUNTIES.map((c) => (
                      <MenuItem key={c} value={c}>{c}</MenuItem>
                    ))}
                  </Select>
                </FormControl>

                <FormControlLabel
                  control={
                    <Switch
                      checked={manualIsDraft}
                      onChange={(e) => setManualIsDraft(e.target.checked)}
                      color="primary"
                    />
                  }
                  label={manualIsDraft ? "Save as draft (private)" : "Publish immediately"}
                />
              </Box>

              {/* Action buttons */}
              <Box style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <Button
                  variant="contained" color="primary"
                  disabled={manualLoading || !manualTitle.trim()}
                  onClick={submitManualArticle}
                >
                  {manualLoading ? "Saving…" : manualIsDraft ? "Save Draft" : "Publish Article"}
                </Button>
                <Button
                  variant="outlined"
                  disabled={manualLoading}
                  onClick={() => {
                    setFbPostUrl(""); setManualTitle(""); setManualBody("");
                    setManualImageUrl(""); setManualCounty(""); setManualIsDraft(false);
                    setManualPublishedAt(""); setManualError(""); setManualSuccess(null);
                  }}
                >
                  Clear
                </Button>
              </Box>

              {manualError && (
                <Typography color="error" variant="body2" style={{ marginTop: 10 }}>{manualError}</Typography>
              )}
              {manualSuccess && (
                <Typography style={{ color: "green", marginTop: 10 }} variant="body2">{manualSuccess}</Typography>
              )}
            </AccordionDetails>
          </Accordion>
        </Box>
      )}

      {/* ================================================================ */}
      {/* TAB 2 — Articles (with draft management)                         */}
      {/* ================================================================ */}
      {activeTab === 2 && (
        <Box>
          <Typography variant="h6" gutterBottom>Articles</Typography>

          <Box style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 12, alignItems: "center" }}>
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
            <TextField variant="outlined" size="small" label="Search"
              value={articleSearch} onChange={(e) => setArticleSearch(e.target.value)} />
            <Button variant="contained" color="primary" onClick={applyFilter}>Filter</Button>
            <Button variant="outlined" onClick={loadData} disabled={loading}>Reload All</Button>
            <FormControlLabel
              control={<Switch checked={showDraftsOnly} onChange={(e) => setShowDraftsOnly(e.target.checked)} color="primary" size="small" />}
              label={`Drafts only (${draftCount})`}
            />
            <Chip label={`Loaded: ${articleRows.length}`} size="small" />
          </Box>

          {loading ? (
            <CircularProgress size={24} />
          ) : (
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>ID</TableCell>
                  <TableCell>Status</TableCell>
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
                {visibleArticles.map((row) => {
                  const draft = isDraftArticle(row);
                  const edit = edits[row.id] || {};
                  const currentCategory = edit.category ?? row.category;
                  const currentKy = edit.isKentucky ?? row.isKentucky;
                  const currentCounty = edit.county ?? row.county ?? "";
                  const currentPublishedAt = edit.publishedAt ?? row.publishedAt ?? "";

                  return (
                    <TableRow key={row.id} style={draft ? { backgroundColor: "#fffde7" } : {}}>
                      <TableCell>{row.id}</TableCell>
                      <TableCell>
                        {draft
                          ? <Chip size="small" label="DRAFT" style={{ backgroundColor: "#ff9800", color: "#fff" }} />
                          : <Chip size="small" label="Live" color="primary" />}
                      </TableCell>
                      <TableCell style={{ maxWidth: 360, overflowWrap: "anywhere" }}>{row.title}</TableCell>
                      <TableCell>
                        {draft ? (
                          <Typography variant="caption" color="textSecondary">Not published</Typography>
                        ) : (
                          <TextField
                            variant="outlined" size="small" type="datetime-local"
                            value={toDateTimeLocalValue(currentPublishedAt)}
                            onChange={(e) => setEdit(row.id, { publishedAt: fromDateTimeLocalValue(e.target.value) })}
                            InputLabelProps={{ shrink: true }}
                          />
                        )}
                      </TableCell>
                      <TableCell>
                        <FormControl variant="outlined" size="small" style={{ minWidth: 130 }}>
                          <Select value={currentCategory} onChange={(e) => setEdit(row.id, { category: e.target.value })}>
                            {CATEGORIES.map((c) => <MenuItem key={c} value={c}>{c}</MenuItem>)}
                          </Select>
                        </FormControl>
                      </TableCell>
                      <TableCell>
                        <Select value={currentKy ? "yes" : "no"} variant="outlined" size="small"
                          onChange={(e) => setEdit(row.id, { isKentucky: e.target.value === "yes" })}>
                          <MenuItem value="yes">yes</MenuItem>
                          <MenuItem value="no">no</MenuItem>
                        </Select>
                      </TableCell>
                      <TableCell>
                        <TextField variant="outlined" size="small"
                          value={currentCounty}
                          onChange={(e) => setEdit(row.id, { county: e.target.value })}
                          placeholder="optional" style={{ width: 120 }}
                        />
                      </TableCell>
                      <TableCell>
                        <Box style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                          {!draft && (
                            <Button size="small" variant="outlined" color="primary"
                              href={getLocalArticleLink(row.id)} target="_blank" rel="noopener noreferrer">
                              Live
                            </Button>
                          )}
                          <Button size="small" variant="outlined"
                            href={row.canonicalUrl || row.sourceUrl || "#"}
                            target="_blank" rel="noopener noreferrer"
                            disabled={!row.canonicalUrl && !row.sourceUrl}>
                            Source
                          </Button>
                        </Box>
                      </TableCell>
                      <TableCell>
                        <Box style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                          {draft && (
                            <Button size="small" variant="contained" color="primary"
                              disabled={publishingNowId === row.id}
                              onClick={() => publishNow(row)}>
                              {publishingNowId === row.id ? "Publishing…" : "Publish Now"}
                            </Button>
                          )}
                          <Button size="small" variant="contained" color="primary"
                            disabled={savingId === row.id}
                            onClick={() => saveRetag(row)}>
                            {savingId === row.id ? "Saving…" : "Save tags"}
                          </Button>
                          {!draft && (
                            <Button size="small" variant="outlined" color="primary"
                              disabled={savingId === row.id}
                              onClick={() => saveDateTime(row)}>
                              Save date
                            </Button>
                          )}
                          <Button size="small" variant="outlined" color="secondary"
                            disabled={deletingId === row.id}
                            onClick={() => deleteArticle(row, false)}>
                            Delete
                          </Button>
                          <Button size="small" variant="contained" color="secondary"
                            disabled={deletingId === row.id}
                            onClick={() => deleteArticle(row, true)}>
                            {deletingId === row.id ? "Working…" : "Delete + Block"}
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
            <Button variant="contained" color="primary"
              disabled={!hasMoreArticles || loadingMoreArticles}
              onClick={loadMoreArticles}>
              {loadingMoreArticles ? "Loading…" : hasMoreArticles ? "Load More" : "No More Articles"}
            </Button>
          </Box>
        </Box>
      )}

      {/* ================================================================ */}
      {/* TAB 3 — Sources                                                  */}
      {/* ================================================================ */}
      {activeTab === 3 && (
        <Box>
          <Typography variant="h6" gutterBottom>Source Health</Typography>
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
                      <Chip size="small" label={row.status}
                        color={row.status === "active" ? "primary" : "default"} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Box>
      )}

      {/* ================================================================ */}
      {/* TAB 4 — Blocked                                                  */}
      {/* ================================================================ */}
      {activeTab === 4 && (
        <Box>
          <Typography variant="h6" gutterBottom>Blocked Articles</Typography>
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
                      <Button size="small" variant="outlined" color="primary"
                        disabled={unblockingId === item.id}
                        onClick={() => unblockArticle(item)}>
                        {unblockingId === item.id ? "Unblocking…" : "Unblock"}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </Box>
      )}
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
