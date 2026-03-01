import React, { useEffect, useState } from "react";
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Box,
  Button,
  Chip,
  CircularProgress,
  Collapse,
  FormControl,
  FormControlLabel,
  IconButton,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Switch,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tabs,
  TextField,
  Tooltip,
  Typography,
} from "@material-ui/core";
import ExpandMoreIcon from "@material-ui/icons/ExpandMore";
import EditIcon from "@material-ui/icons/Edit";
import SiteService from "../services/siteService";
import { KENTUCKY_COUNTIES } from "../constants/counties";
import { articleToUrl } from "../utils/functions";

// `SiteService` already handles environment configuration internally.
const service = new SiteService();
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

  // Tab navigation: 0=Dashboard 1=Create Article 2=Articles 3=Blocked
  const [activeTab, setActiveTab] = useState(0);

  const [sources, setSources] = useState([]);
  const [sourceSummary, setSourceSummary] = useState(null);
  const [metrics, setMetrics] = useState(null);
  const [rejections, setRejections] = useState([]);
  const [duplicateItems, setDuplicateItems] = useState([]);
  const [publishingUrl, setPublishingUrl] = useState("");

  const [backfillResult, setBackfillResult] = useState(null);
  const [reclassifyResult, setReclassifyResult] = useState(null);

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
  // State for inline title/summary editing: { [id]: { title, summary } }
  const [contentEdits, setContentEdits] = useState({});
  // State for inline link editing: { [id]: { canonicalUrl, sourceUrl } }
  const [linkEdits, setLinkEdits] = useState({});
  // ID of the article whose inline edit form is currently expanded
  const [expandedEditId, setExpandedEditId] = useState(null);
  const [savingContentId, setSavingContentId] = useState(null);
  const [savingLinksId, setSavingLinksId] = useState(null);

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

  // --- Facebook diagnostics state ---
  const [fbDiagId, setFbDiagId] = useState("");
  const [fbDiagCaption, setFbDiagCaption] = useState(null);
  const [fbDiagPostResult, setFbDiagPostResult] = useState(null);
  const [fbDiagError, setFbDiagError] = useState("");
  const [fbDiagLoading, setFbDiagLoading] = useState(false);

  const handleDiagCaption = async () => {
    setFbDiagError("");
    setFbDiagCaption(null);
    if (!fbDiagId.trim()) return;
    const id = Number(fbDiagId);
    if (!Number.isFinite(id) || id <= 0) {
      setFbDiagError("Invalid article ID");
      return;
    }
    setFbDiagLoading(true);
    try {
      const res = await service.facebookCaption(id);
      if (res.ok) {
        setFbDiagCaption(res.caption || "");
      } else {
        setFbDiagError(res.error || "unknown error");
      }
    } catch (err) {
      setFbDiagError(err?.errorMessage || String(err));
    } finally {
      setFbDiagLoading(false);
    }
  };

  const handleDiagPost = async () => {
    setFbDiagError("");
    setFbDiagPostResult(null);
    if (!fbDiagId.trim()) return;
    const id = Number(fbDiagId);
    if (!Number.isFinite(id) || id <= 0) {
      setFbDiagError("Invalid article ID");
      return;
    }
    setFbDiagLoading(true);
    try {
      const res = await service.facebookPost(id);
      if (res.ok) {
        setFbDiagPostResult(res.result || res);
      } else {
        setFbDiagError(res.error || "unknown error");
      }
    } catch (err) {
      setFbDiagError(err?.errorMessage || String(err));
    } finally {
      setFbDiagLoading(false);
    }
  };

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
      setLinkEdits({});
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
      setLinkEdits({});
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

  const saveContent = async (row) => {
    const patch = contentEdits[row.id] || {};
    const newTitle = patch.title ?? row.title;
    const newSummary = patch.summary !== undefined ? patch.summary : (row.summary || "");
    setSavingContentId(row.id);
    setError("");
    try {
      await service.updateAdminArticleContent({
        id: row.id,
        title: newTitle,
        summary: newSummary,
      });
      setArticleRows((prev) =>
        prev.map((item) =>
          item.id === row.id
            ? { ...item, title: newTitle, summary: newSummary }
            : item
        )
      );
      setContentEdits((prev) => ({ ...prev, [row.id]: {} }));
      setExpandedEditId(null);
    } catch (err) {
      console.error(err);
      setError(err?.errorMessage || "Failed to save content.");
    } finally {
      setSavingContentId(null);
    }
  };

  const saveLinks = async (row) => {
    const patch = linkEdits[row.id] || {};
    const canonicalUrl = (patch.canonicalUrl !== undefined ? patch.canonicalUrl : row.canonicalUrl || "").trim();
    const sourceUrl = (patch.sourceUrl !== undefined ? patch.sourceUrl : row.sourceUrl || "").trim();

    if (!canonicalUrl || !sourceUrl) {
      setError("Live URL and Source URL are both required.");
      return;
    }

    if (!isValidHttpUrl(canonicalUrl) || !isValidHttpUrl(sourceUrl)) {
      setError("Live URL and Source URL must both be valid http(s) URLs.");
      return;
    }

    setSavingLinksId(row.id);
    setError("");
    try {
      const payload = await service.updateAdminArticleLinks({
        id: row.id,
        canonicalUrl,
        sourceUrl,
      });
      const nextCanonicalUrl = payload?.canonicalUrl || canonicalUrl;
      const nextSourceUrl = payload?.sourceUrl || sourceUrl;
      setArticleRows((prev) =>
        prev.map((item) =>
          item.id === row.id
            ? { ...item, canonicalUrl: nextCanonicalUrl, sourceUrl: nextSourceUrl }
            : item
        )
      );
      setLinkEdits((prev) => ({ ...prev, [row.id]: {} }));
    } catch (err) {
      console.error(err);
      setError(err?.errorMessage || "Unable to update article links.");
    } finally {
      setSavingLinksId(null);
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
    setLinkEdits({});
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

  /**
   * Returns the best local URL for a given article row.
   * Uses the clean SEO URL when slug is present, otherwise falls back to ?articleId=
   */
  const getLocalArticleLink = (row) => {
    const path = articleToUrl({
      id: row.id,
      slug: row.slug ?? null,
      county: row.county ?? null,
      categories: row.category ? [row.category] : [],
    });
    return `https://localkynews.com${path}`;
  };

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
    setBackfillResult({ status: "running", message: "Backfill started — polling for results every 5 seconds...", processed: 0, missingCount: "?" });
    try {
      await service.adminBackfillCounties({ threshold: 5 });
      let pollCount = 0;
      const poll = setInterval(async () => {
        pollCount++;
        try {
          const statusData = await service.getBackfillStatus();
          const s = statusData?.status;
          if (s?.status === "complete" || s?.status === "error") {
            clearInterval(poll);
            setBackfillResult(s);
          } else if (s?.status === "running") {
            setBackfillResult({ ...s, message: `Running… ${s.processed ?? 0} / ${s.missingCount ?? "?"} counties processed` });
          }
          if (pollCount > 72) {
            clearInterval(poll);
            setBackfillResult((prev) => ({ ...(prev || {}), status: "timeout", message: "Backfill is still running. Refresh this page to check again." }));
          }
        } catch { /* keep polling */ }
      }, 5000);
    } catch (err) {
      setError(err?.errorMessage || "Backfill failed to start.");
      setBackfillResult(null);
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
            <Button variant="contained" color="default" onClick={runReclassify}>
              Reclassify Articles
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
              <Typography variant="subtitle2" gutterBottom>
                County Backfill — {backfillResult.status === "running" ? "In Progress" : backfillResult.status === "complete" ? "✅ Complete" : backfillResult.status === "timeout" ? "⏳ Still Running" : "Status"}
              </Typography>
              {backfillResult.message && (
                <Typography variant="body2" color="textSecondary" style={{ marginBottom: 8 }}>{backfillResult.message}</Typography>
              )}
              {backfillResult.status === "running" && (
                <Typography variant="body2">Counties processed: {backfillResult.processed ?? 0} / {backfillResult.missingCount ?? "?"}</Typography>
              )}
              {backfillResult.status === "complete" && (
                <Typography variant="body2" style={{ marginBottom: 6 }}>
                  Processed {backfillResult.processed ?? 0} of {backfillResult.missingCount ?? "?"} counties below threshold.
                  Finished: {backfillResult.finishedAt ? new Date(backfillResult.finishedAt).toLocaleTimeString() : "—"}
                </Typography>
              )}
              {backfillResult.results?.length > 0 && (
                <pre style={{ whiteSpace: "pre-wrap", fontSize: 11, maxHeight: 300, overflow: "auto" }}>{JSON.stringify(backfillResult.results, null, 2)}</pre>
              )}
            </Paper>
          )}
{reclassifyResult && (
            <Paper style={{ padding: 12, marginBottom: 16 }}>
              <Typography variant="subtitle2" gutterBottom>
                Reclassify — {reclassifyResult.status === "running" ? "Running…" : reclassifyResult.status === "done" ? "✅ Done" : reclassifyResult.status === "error" ? "⚠️ Error" : "Status"}
              </Typography>
              {reclassifyResult.message && (
                <Typography variant="body2" color="textSecondary" style={{ marginBottom: 8 }}>{reclassifyResult.message}</Typography>
              )}
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
                              ? <Button size="small" variant="outlined" color="primary" href={getLocalArticleLink({ id: item.id })} target="_blank" rel="noopener noreferrer">Open</Button>
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
                              ? <Button size="small" variant="outlined" color="primary" href={getLocalArticleLink({ id: item.id })} target="_blank" rel="noopener noreferrer">Open</Button>
                              : "—"}
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
                <Typography variant="subtitle2">
                  Sources ({sourceSummary?.totalConfiguredSources || 0})
                </Typography>
              </AccordionSummary>
              <AccordionDetails style={{ display: "block", padding: 0 }}>
                {sourceSummary && (
                  <Box style={{ display: "flex", gap: 8, margin: "12px 12px 8px", flexWrap: "wrap" }}>
                    <Chip label={`Configured: ${sourceSummary.totalConfiguredSources || 0}`} />
                    <Chip label={`Active: ${sourceSummary.activeSources || 0}`} color="primary" />
                    <Chip label={`No articles yet: ${sourceSummary.inactiveSources || 0}`} />
                  </Box>
                )}
                {loading ? (
                  <Box style={{ padding: 12 }}>
                    <CircularProgress size={24} />
                  </Box>
                ) : (
                  <Table size="small" style={{ marginBottom: 12 }}>
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
                            <Chip
                              size="small"
                              label={row.status}
                              color={row.status === "active" ? "primary" : "default"}
                            />
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
                Paste a Facebook post URL to auto-fill the manual article form. <strong>This just
                scrapes an *existing* post and will show whatever link was originally
                posted (e.g. a wnky.com URL).</strong> For generating captions that point to
                our own site, use the diagnostics box below.  Or fill fields manually.
                All articles are tagged as Kentucky content; category is auto-classified by AI.
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

              {/* Facebook diagnostics helper
                  This tool calls the worker endpoint that *generates* a caption for
                  an existing article.  It is NOT the same as the "Preview Facebook
                  post" box higher up, which merely fetches the text from a post URL
                  (and therefore will show whatever link was in that original post).
                  Use the ID of the article and click "Generate caption"; the link
                  produced will always point at localkynews.com. */}
              <Box style={{ marginTop: 24, padding: 16, border: '1px solid #ccc', borderRadius: 4 }}>
                <Typography variant="subtitle1" style={{ marginBottom: 8 }}>Facebook diagnostics</Typography>
                <Typography variant="body2" color="textSecondary" style={{ marginBottom: 8 }}>
                  Enter an article ID and generate a clean caption – the link will be to
                  your site, not the original source.  You can also post it directly if
                  your Facebook credentials are configured.
                </Typography>
                <Box style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <TextField
                    label="Article ID"
                    size="small"
                    variant="outlined"
                    value={fbDiagId}
                    onChange={(e) => setFbDiagId(e.target.value)}
                    style={{ width: 120 }}
                  />
                  <Button
                    variant="outlined"
                    size="small"
                    disabled={fbDiagLoading || !fbDiagId.trim()}
                    onClick={handleDiagCaption}
                  >
                    {fbDiagLoading ? '…' : 'Generate caption'}
                  </Button>
                  <Button
                    variant="outlined"
                    size="small"
                    disabled={fbDiagLoading || !fbDiagId.trim()}
                    onClick={handleDiagPost}
                  >
                    {fbDiagLoading ? '…' : 'Post to Facebook'}
                  </Button>
                </Box>
                {fbDiagError && (
                  <Typography color="error" variant="body2" style={{ marginTop: 8 }}>{fbDiagError}</Typography>
                )}
                {fbDiagCaption != null && (
                  <Typography variant="body2" style={{ marginTop: 8, whiteSpace: 'pre-wrap' }}>
                    <strong>Caption:</strong> {fbDiagCaption || '<empty>'}
                  </Typography>
                )}
                {fbDiagPostResult != null && (
                  <Typography variant="body2" style={{ marginTop: 8, whiteSpace: 'pre-wrap' }}>
                    <strong>Post result:</strong> {JSON.stringify(fbDiagPostResult)}
                  </Typography>
                )}
              </Box>
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
            <TableContainer component={Paper} style={{ overflowX: "auto" }}>
              <Table size="small" stickyHeader>
                <TableHead>
                  <TableRow>
                    <TableCell style={{ width: 50 }}>ID</TableCell>
                    <TableCell style={{ width: 70 }}>Status</TableCell>
                    <TableCell style={{ minWidth: 220 }}>Title</TableCell>
                    <TableCell style={{ width: 180 }}>Published (UTC)</TableCell>
                    <TableCell style={{ width: 140 }}>Category</TableCell>
                    <TableCell style={{ width: 60 }}>KY</TableCell>
                    <TableCell style={{ width: 130 }}>County</TableCell>
                    <TableCell style={{ width: 110 }}>Links</TableCell>
                    <TableCell style={{ width: 50 }}>Edit</TableCell>
                    <TableCell style={{ minWidth: 280 }}>Actions</TableCell>
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
                    const contentEdit = contentEdits[row.id] || {};
                    const linkEdit = linkEdits[row.id] || {};
                    const currentCanonicalUrl =
                      linkEdit.canonicalUrl !== undefined ? linkEdit.canonicalUrl : row.canonicalUrl || "";
                    const currentSourceUrl =
                      linkEdit.sourceUrl !== undefined ? linkEdit.sourceUrl : row.sourceUrl || "";
                    const isExpanded = expandedEditId === row.id;

                    return (
                      <React.Fragment key={row.id}>
                        <TableRow style={draft ? { backgroundColor: "#fffde7" } : {}}>
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
                                  href={getLocalArticleLink(row)} target="_blank" rel="noopener noreferrer">
                                  Local
                                </Button>
                              )}
                              <Button size="small" variant="outlined"
                                href={row.canonicalUrl || "#"}
                                target="_blank" rel="noopener noreferrer"
                                disabled={!row.canonicalUrl}>
                                Live
                              </Button>
                              <Button size="small" variant="outlined"
                                href={row.sourceUrl || "#"}
                                target="_blank" rel="noopener noreferrer"
                                disabled={!row.sourceUrl}>
                                Source
                              </Button>
                            </Box>
                          </TableCell>
                          <TableCell>
                            <Tooltip title="Edit title / summary / links">
                              <IconButton
                                size="small"
                                color={isExpanded ? "primary" : "default"}
                                onClick={() => setExpandedEditId(isExpanded ? null : row.id)}
                              >
                                <EditIcon fontSize="small" />
                              </IconButton>
                            </Tooltip>
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
                        <TableRow>
                          <TableCell colSpan={10} style={{ paddingTop: 0, paddingBottom: 0, border: isExpanded ? undefined : "none" }}>
                            <Collapse in={isExpanded} unmountOnExit>
                              <Box style={{ padding: "12px 8px 16px", background: "#f9f9f9" }}>
                                <Typography variant="subtitle2" gutterBottom>Edit Article — ID {row.id}</Typography>
                                <TextField
                                  fullWidth
                                  label="Title"
                                  variant="outlined"
                                  size="small"
                                  style={{ marginBottom: 10 }}
                                  value={contentEdit.title !== undefined ? contentEdit.title : row.title || ""}
                                  onChange={(e) => setContentEdits(prev => ({ ...prev, [row.id]: { ...prev[row.id], title: e.target.value } }))}
                                />
                                <TextField
                                  fullWidth
                                  multiline
                                  rows={6}
                                  label="Summary"
                                  variant="outlined"
                                  size="small"
                                  style={{ marginBottom: 10 }}
                                  value={contentEdit.summary !== undefined ? contentEdit.summary : row.summary || ""}
                                  onChange={(e) => setContentEdits(prev => ({ ...prev, [row.id]: { ...prev[row.id], summary: e.target.value } }))}
                                />
                                <TextField
                                  fullWidth
                                  label="Live URL"
                                  variant="outlined"
                                  size="small"
                                  style={{ marginBottom: 10 }}
                                  value={currentCanonicalUrl}
                                  onChange={(e) => setLinkEdits((prev) => ({
                                    ...prev,
                                    [row.id]: { ...prev[row.id], canonicalUrl: e.target.value },
                                  }))}
                                />
                                <TextField
                                  fullWidth
                                  label="Source URL"
                                  variant="outlined"
                                  size="small"
                                  style={{ marginBottom: 10 }}
                                  value={currentSourceUrl}
                                  onChange={(e) => setLinkEdits((prev) => ({
                                    ...prev,
                                    [row.id]: { ...prev[row.id], sourceUrl: e.target.value },
                                  }))}
                                />
                                <Box style={{ display: "flex", gap: 8 }}>
                                  <Button
                                    size="small"
                                    variant="contained"
                                    color="primary"
                                    disabled={savingContentId === row.id}
                                    onClick={() => saveContent(row)}
                                  >
                                    {savingContentId === row.id ? "Saving…" : "Save Content"}
                                  </Button>
                                  <Button
                                    size="small"
                                    variant="contained"
                                    color="primary"
                                    disabled={savingLinksId === row.id}
                                    onClick={() => saveLinks(row)}
                                  >
                                    {savingLinksId === row.id ? "Saving…" : "Save Links"}
                                  </Button>
                                  <Button size="small" variant="outlined" onClick={() => setExpandedEditId(null)}>
                                    Cancel
                                  </Button>
                                </Box>
                              </Box>
                            </Collapse>
                          </TableCell>
                        </TableRow>
                      </React.Fragment>
                    );
                  })}
                </TableBody>
              </Table>
            </TableContainer>
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
      {/* TAB 3 — Blocked                                                  */}
      {/* ================================================================ */}
      {activeTab === 3 && (
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

function isValidHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function fromDateTimeLocalValue(value) {
  if (!value) return "";
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return "";
  return parsed.toISOString();
}
