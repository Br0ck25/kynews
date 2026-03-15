import React, { useState, useCallback } from "react";
import {
  Box,
  Button,
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
  TextField,
  Tooltip,
  Typography,
  Checkbox,
} from "@material-ui/core";
import DeleteIcon from "@material-ui/icons/Delete";
import CheckCircleIcon from "@material-ui/icons/CheckCircle";
import ErrorIcon from "@material-ui/icons/Error";
import RefreshIcon from "@material-ui/icons/Refresh";
import PageviewIcon from "@material-ui/icons/Pageview";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const ADMIN_CATEGORIES = ["today", "sports", "weather", "schools"];

const KENTUCKY_COUNTIES = [
  "Adair","Allen","Anderson","Ballard","Barren","Bath","Bell","Boone","Bourbon",
  "Boyd","Boyle","Bracken","Breathitt","Breckinridge","Bullitt","Butler","Caldwell",
  "Calloway","Campbell","Carlisle","Carroll","Carter","Casey","Christian","Clark",
  "Clay","Clinton","Crittenden","Cumberland","Daviess","Edmonson","Elliott","Estill",
  "Fayette","Fleming","Floyd","Franklin","Fulton","Gallatin","Garrard","Grant",
  "Graves","Grayson","Green","Greenup","Hancock","Hardin","Harlan","Harrison",
  "Hart","Henderson","Henry","Hickman","Hopkins","Jackson","Jefferson","Jessamine",
  "Johnson","Kenton","Knott","Knox","Larue","Laurel","Lawrence","Lee","Leslie",
  "Letcher","Lewis","Lincoln","Livingston","Logan","Lyon","McCracken","McCreary",
  "McLean","Madison","Magoffin","Marion","Marshall","Martin","Mason","Meade",
  "Menifee","Mercer","Metcalfe","Monroe","Montgomery","Morgan","Muhlenberg",
  "Nelson","Nicholas","Ohio","Oldham","Owen","Owsley","Pendleton","Perry","Pike",
  "Powell","Pulaski","Robertson","Rockcastle","Rowan","Russell","Scott","Shelby",
  "Simpson","Spencer","Taylor","Todd","Trigg","Trimble","Union","Warren","Washington",
  "Wayne","Webster","Whitley","Wolfe","Woodford",
];

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------
function isFbUrl(str) {
  return /^https?:\/\/(www\.|m\.|mbasic\.)?facebook\.com\//i.test(str.trim());
}

/**
 * Returns true if this looks like a Facebook PAGE URL (not a specific post).
 * Post URLs contain /posts/, /permalink/, story_fbid=, /share/p/, etc.
 */
function isFbPageUrl(str) {
  if (!isFbUrl(str)) return false;
  try {
    const parsed = new URL(str.trim());
    const path = parsed.pathname;
    const isPost =
      /\/posts\/\d+/.test(path) ||
      /\/permalink\//.test(path) ||
      /\/share\/p\//.test(path) ||
      /\/photos\/\d+/.test(path) ||
      /\/videos\/\d+/.test(path) ||
      parsed.searchParams.has("story_fbid") ||
      parsed.searchParams.has("fbid");
    if (isPost) return false;
    const segments = path.split("/").filter(Boolean);
    return segments.length <= 1 || path === "/profile.php";
  } catch {
    return false;
  }
}

function parseUrls(raw) {
  return raw
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------
function StatusBadge({ status }) {
  const map = {
    idle:      { label: "Pending",   color: "#6b7280", bg: "#f3f4f6" },
    scraping:  { label: "Scraping…", color: "#1d4ed8", bg: "#eff6ff" },
    scraped:   { label: "Preview",   color: "#92400e", bg: "#fffbeb" },
    saving:    { label: "Saving…",   color: "#1d4ed8", bg: "#eff6ff" },
    published: { label: "Published", color: "#065f46", bg: "#d1fae5" },
    error:     { label: "Error",     color: "#991b1b", bg: "#fee2e2" },
    discarded: { label: "Discarded", color: "#6b7280", bg: "#f3f4f6" },
  };
  const s = map[status] || map.idle;
  return (
    <span style={{
      display: "inline-block",
      padding: "2px 10px",
      borderRadius: 12,
      fontSize: "0.72rem",
      fontWeight: 700,
      letterSpacing: "0.04em",
      color: s.color,
      background: s.bg,
      border: `1px solid ${s.color}33`,
    }}>
      {s.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Page post picker — shown when a page URL is entered
// ---------------------------------------------------------------------------
function PagePostPicker({ result, onScrapeSelected, onDismiss }) {
  const [selected, setSelected] = useState(() =>
    new Set(result.posts.map((_, i) => i))
  );

  const toggle = (i) => setSelected((prev) => {
    const next = new Set(prev);
    next.has(i) ? next.delete(i) : next.add(i);
    return next;
  });

  const toggleAll = () => {
    setSelected(
      selected.size === result.posts.length
        ? new Set()
        : new Set(result.posts.map((_, i) => i))
    );
  };

  return (
    <Paper
      style={{ marginBottom: 16, border: "1.5px solid #3b82f6", borderRadius: 8, overflow: "hidden" }}
      elevation={0}
    >
      {/* Header */}
      <Box style={{
        background: "#eff6ff",
        padding: "10px 16px",
        borderBottom: "1px solid #bfdbfe",
        display: "flex",
        alignItems: "center",
        gap: 10,
      }}>
        <PageviewIcon style={{ color: "#2563eb", fontSize: 20 }} />
        <Box style={{ flex: 1 }}>
          <Typography variant="body2" style={{ fontWeight: 700, color: "#1e40af" }}>
            {result.posts.length > 0
              ? `Page discovered — ${result.posts.length} post${result.posts.length !== 1 ? "s" : ""} found`
              : "Page discovered — no posts retrieved"}
          </Typography>
          <Typography variant="caption" style={{ color: "#3b82f6" }}>
            {result.pageUrl}
          </Typography>
        </Box>
        <Button size="small" variant="text" style={{ color: "#6b7280" }} onClick={onDismiss}>
          Dismiss
        </Button>
      </Box>

      {result.warning && (
        <Box style={{ padding: "8px 16px", background: "#fffbeb", borderBottom: "1px solid #fde68a" }}>
          <Typography variant="caption" style={{ color: "#92400e" }}>
            ⚠ {result.warning}
          </Typography>
        </Box>
      )}

      {result.posts.length > 0 && (
        <>
          {/* Select all row */}
          <Box style={{
            padding: "8px 16px",
            borderBottom: "1px solid #e5e7eb",
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}>
            <FormControlLabel
              control={
                <Checkbox
                  checked={selected.size === result.posts.length}
                  indeterminate={selected.size > 0 && selected.size < result.posts.length}
                  onChange={toggleAll}
                  color="primary"
                  size="small"
                />
              }
              label={<Typography variant="body2" style={{ fontWeight: 600 }}>Select all</Typography>}
            />
            <Typography variant="caption" style={{ color: "#6b7280", marginLeft: "auto" }}>
              {selected.size} of {result.posts.length} selected
            </Typography>
          </Box>

          {/* Post list */}
          <Box style={{ maxHeight: 340, overflowY: "auto" }}>
            {result.posts.map((post, i) => (
              <Box
                key={i}
                onClick={() => toggle(i)}
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 10,
                  padding: "10px 16px",
                  borderBottom: "1px solid #f3f4f6",
                  cursor: "pointer",
                  background: selected.has(i) ? "#f0f9ff" : "transparent",
                  transition: "background 0.1s",
                }}
              >
                <Checkbox
                  checked={selected.has(i)}
                  onChange={() => toggle(i)}
                  color="primary"
                  size="small"
                  onClick={(e) => e.stopPropagation()}
                  style={{ marginTop: -2, padding: 4 }}
                />
                <Box style={{ flex: 1, minWidth: 0 }}>
                  {post.message ? (
                    <Typography variant="body2" style={{
                      fontSize: "0.82rem",
                      lineHeight: 1.4,
                      overflow: "hidden",
                      display: "-webkit-box",
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: "vertical",
                    }}>
                      {post.message}
                    </Typography>
                  ) : (
                    <Typography variant="body2" style={{ color: "#9ca3af", fontSize: "0.82rem", fontStyle: "italic" }}>
                      Post content not previewed — will be scraped individually
                    </Typography>
                  )}
                  <Typography variant="caption" style={{ color: "#6b7280" }}>
                    {post.publishedAt || ""}
                    {post.publishedAt ? " · " : ""}
                    <a
                      href={post.postUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ color: "#3b82f6" }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      {post.postUrl.length > 60 ? post.postUrl.slice(0, 60) + "…" : post.postUrl}
                    </a>
                  </Typography>
                </Box>
              </Box>
            ))}
          </Box>

          {/* Action bar */}
          <Box style={{
            padding: "12px 16px",
            borderTop: "1px solid #e5e7eb",
            display: "flex",
            gap: 8,
            alignItems: "center",
            background: "#f9fafb",
          }}>
            <Button
              variant="contained"
              color="primary"
              size="small"
              disabled={selected.size === 0}
              onClick={() =>
                onScrapeSelected(
                  result.posts.filter((_, i) => selected.has(i)).map((p) => p.postUrl)
                )
              }
            >
              Scrape {selected.size} selected post{selected.size !== 1 ? "s" : ""}
            </Button>
            <Typography variant="caption" style={{ color: "#9ca3af", marginLeft: 8 }}>
              Each post will be fetched and shown as an editable card below.
            </Typography>
          </Box>
        </>
      )}
    </Paper>
  );
}

// ---------------------------------------------------------------------------
// Single article card
// ---------------------------------------------------------------------------
function ArticleCard({ item, onUpdate, onPublish, onDiscard, onRescrape }) {
  const [expanded, setExpanded] = useState(true);
  const { status, url, title, body, imageUrl, category, county, isKentucky, error } = item;

  const disabled = status === "saving" || status === "published" || status === "discarded";
  const canPublish = status === "scraped" && title.trim();
  const canDiscard = status !== "published";

  const set = (field) => (e) => onUpdate(item.id, { [field]: e.target.value });
  const toggle = (field) => (e) => onUpdate(item.id, { [field]: e.target.checked });

  return (
    <Paper
      style={{
        marginBottom: 12,
        border: status === "published"
          ? "1.5px solid #86efac"
          : status === "error"
          ? "1.5px solid #fca5a5"
          : "1px solid #e5e7eb",
        opacity: status === "discarded" ? 0.45 : 1,
        transition: "opacity 0.2s",
        overflow: "hidden",
      }}
      elevation={1}
    >
      {/* Header */}
      <Box
        style={{
          display: "flex", alignItems: "center", gap: 8,
          padding: "10px 14px", background: "#f9fafb",
          borderBottom: "1px solid #e5e7eb", cursor: "pointer",
        }}
        onClick={() => setExpanded((v) => !v)}
      >
        <StatusBadge status={status} />
        <Typography
          variant="body2"
          style={{
            flex: 1, fontWeight: 600, fontSize: "0.85rem",
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}
          title={title || url}
        >
          {title || <span style={{ color: "#9ca3af", fontWeight: 400 }}>{url}</span>}
        </Typography>

        {status === "scraping" && <CircularProgress size={16} />}
        {status === "published" && <CheckCircleIcon style={{ color: "#22c55e", fontSize: 18 }} />}
        {status === "error" && <ErrorIcon style={{ color: "#ef4444", fontSize: 18 }} />}

        <Box onClick={(e) => e.stopPropagation()} style={{ display: "flex", gap: 4 }}>
          {(status === "error" || status === "idle") && (
            <Tooltip title="Re-scrape">
              <IconButton size="small" onClick={() => onRescrape(item.id)}>
                <RefreshIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          )}
          {canDiscard && (
            <Tooltip title="Discard">
              <IconButton size="small" onClick={() => onDiscard(item.id)}>
                <DeleteIcon fontSize="small" style={{ color: "#ef4444" }} />
              </IconButton>
            </Tooltip>
          )}
        </Box>

        <Typography variant="caption" style={{ color: "#9ca3af" }}>
          {expanded ? "▲" : "▼"}
        </Typography>
      </Box>

      {/* Source URL */}
      <Box style={{ padding: "4px 14px 0", background: "#f9fafb" }}>
        <Typography variant="caption" style={{ color: "#6b7280" }}>
          <a href={url} target="_blank" rel="noopener noreferrer" style={{ color: "#3b82f6" }}>
            {url.length > 80 ? url.slice(0, 80) + "…" : url}
          </a>
        </Typography>
      </Box>

      {/* Edit area */}
      <Collapse in={expanded && status !== "discarded"}>
        <Box style={{ padding: "14px 16px 16px" }}>
          {status === "error" && error && (
            <Box style={{
              marginBottom: 12, padding: "8px 12px",
              background: "#fee2e2", borderRadius: 6, border: "1px solid #fca5a5",
            }}>
              <Typography variant="body2" style={{ color: "#991b1b", fontSize: "0.82rem" }}>
                ⚠ {error}
              </Typography>
            </Box>
          )}

          <Box style={{ display: "flex", gap: 12, marginBottom: 12, alignItems: "flex-start" }}>
            {imageUrl && (
              <img
                src={imageUrl}
                alt=""
                style={{
                  width: 100, height: 70, objectFit: "cover",
                  borderRadius: 4, border: "1px solid #e5e7eb", flexShrink: 0,
                }}
              />
            )}
            <TextField
              fullWidth label="Image URL" size="small" variant="outlined"
              value={imageUrl} onChange={set("imageUrl")} disabled={disabled}
              inputProps={{ style: { fontSize: "0.82rem" } }}
            />
          </Box>

          <TextField
            fullWidth label="Title *" size="small" variant="outlined"
            value={title} onChange={set("title")} disabled={disabled}
            style={{ marginBottom: 10 }}
          />

          <TextField
            fullWidth multiline rows={5} label="Body" size="small" variant="outlined"
            value={body} onChange={set("body")} disabled={disabled}
            style={{ marginBottom: 10 }}
            inputProps={{ style: { fontSize: "0.82rem", lineHeight: 1.5 } }}
          />

          <Box style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
            <FormControl variant="outlined" size="small" style={{ minWidth: 140 }}>
              <InputLabel>Category</InputLabel>
              <Select value={category} onChange={set("category")} label="Category" disabled={disabled}>
                {ADMIN_CATEGORIES.map((c) => (
                  <MenuItem key={c} value={c}>{c}</MenuItem>
                ))}
              </Select>
            </FormControl>

            <FormControlLabel
              control={
                <Switch
                  checked={isKentucky}
                  onChange={toggle("isKentucky")}
                  color="primary"
                  size="small"
                  disabled={disabled}
                />
              }
              label="Kentucky"
            />

            {isKentucky && (
              <FormControl variant="outlined" size="small" style={{ minWidth: 180 }}>
                <InputLabel>County (optional)</InputLabel>
                <Select value={county} onChange={set("county")} label="County (optional)" disabled={disabled}>
                  <MenuItem value=""><em>None</em></MenuItem>
                  {KENTUCKY_COUNTIES.map((c) => (
                    <MenuItem key={c} value={c}>{c}</MenuItem>
                  ))}
                </Select>
              </FormControl>
            )}
          </Box>

          <Box style={{ display: "flex", gap: 8 }}>
            <Button
              variant="contained" color="primary" size="small"
              disabled={!canPublish || disabled}
              onClick={() => onPublish(item.id)}
              style={{ minWidth: 110 }}
            >
              {status === "saving"
                ? <CircularProgress size={16} style={{ color: "#fff" }} />
                : "Publish"}
            </Button>
            <Button
              variant="outlined" size="small"
              disabled={!canPublish || disabled}
              onClick={() => onPublish(item.id, true)}
              style={{ minWidth: 110 }}
            >
              Save as Draft
            </Button>
            {canDiscard && (
              <Button
                variant="text" size="small"
                style={{ color: "#ef4444", marginLeft: "auto" }}
                onClick={() => onDiscard(item.id)}
                disabled={disabled}
              >
                Discard
              </Button>
            )}
          </Box>

          {status === "published" && (
            <Typography variant="body2" style={{ color: "#065f46", marginTop: 8, fontWeight: 600 }}>
              ✓ Article published successfully
            </Typography>
          )}
        </Box>
      </Collapse>
    </Paper>
  );
}

// ---------------------------------------------------------------------------
// Main tab
// ---------------------------------------------------------------------------
let _idCounter = 0;
function nextId() { return ++_idCounter; }
function makeItem(url) {
  return {
    id: nextId(),
    url,
    status: "idle",
    title: "",
    body: "",
    imageUrl: "",
    category: "today",
    county: "",
    isKentucky: true,
    error: "",
  };
}

export default function FacebookScraperTab({ service }) {
  const [urlInput, setUrlInput] = useState("");
  const [items, setItems] = useState([]);
  const [globalError, setGlobalError] = useState("");
  const [pageLoading, setPageLoading] = useState(false);
  const [pageResults, setPageResults] = useState([]);

  const updateItem = useCallback((id, patch) => {
    setItems((prev) => prev.map((item) => item.id === id ? { ...item, ...patch } : item));
  }, []);

  const scrapeOne = useCallback(async (id, url) => {
    updateItem(id, { status: "scraping", error: "" });
    try {
      const res = await service.previewFacebookPost(url);
      if (res.ok && res.title) {
        updateItem(id, {
          status: "scraped",
          title: res.title || "",
          body: res.body || "",
          imageUrl: res.imageUrl || "",
        });
      } else {
        updateItem(id, {
          status: "error",
          error: res.message || "Could not extract post content. The post may be private or require login.",
        });
      }
    } catch (err) {
      updateItem(id, {
        status: "error",
        error: err?.errorMessage || err?.message || "Network error.",
      });
    }
  }, [service, updateItem]);

  const addAndScrapePostUrls = useCallback(async (postUrls) => {
    const existing = new Set(items.map((i) => i.url));
    const fresh = postUrls.filter((u) => !existing.has(u));
    if (!fresh.length) return;
    const newItems = fresh.map(makeItem);
    setItems((prev) => [...newItems, ...prev]);
    // Scrape in batches of 3 to avoid hammering the worker
    const chunks = [];
    for (let i = 0; i < newItems.length; i += 3) chunks.push(newItems.slice(i, i + 3));
    for (const chunk of chunks) {
      await Promise.all(chunk.map((it) => scrapeOne(it.id, it.url)));
    }
  }, [items, scrapeOne]);

  const handleSubmit = useCallback(async () => {
    const urls = parseUrls(urlInput);
    if (!urls.length) return;
    setGlobalError("");

    // Single page URL — run page discovery
    if (urls.length === 1 && isFbPageUrl(urls[0])) {
      setPageLoading(true);
      try {
        const result = await service.facebookPagePosts(urls[0]);
        setPageResults((prev) => [
          { ...result, pageUrl: result.pageUrl || urls[0] },
          ...prev,
        ]);
        if (result.ok && result.posts?.length > 0) {
          setUrlInput("");
        }
      } catch (err) {
        setGlobalError(
          err?.errorMessage || err?.message || "Failed to discover page posts."
        );
      } finally {
        setPageLoading(false);
      }
      return;
    }

    // One or more post URLs — scrape directly
    const fbUrls = urls.filter(isFbUrl);
    const nonFb = urls.filter((u) => !isFbUrl(u));
    if (nonFb.length) {
      setGlobalError(
        `${nonFb.length} non-Facebook URL${nonFb.length !== 1 ? "s" : ""} skipped.`
      );
    }
    if (fbUrls.length) {
      setUrlInput("");
      await addAndScrapePostUrls(fbUrls);
    }
  }, [urlInput, service, addAndScrapePostUrls]);

  const publishOne = useCallback(async (id, isDraft = false) => {
    const item = items.find((it) => it.id === id);
    if (!item) return;
    updateItem(id, { status: "saving" });
    try {
      const res = await service.createManualArticle({
        title: item.title,
        body: item.body,
        imageUrl: item.imageUrl,
        sourceUrl: item.url,
        county: item.county || null,
        isDraft,
        category: item.category,
        isKentucky: item.isKentucky,
      });
      if (res.status === "inserted" || res.status === "duplicate") {
        updateItem(id, { status: "published" });
      } else {
        updateItem(id, { status: "error", error: res.message || "Publish failed." });
      }
    } catch (err) {
      updateItem(id, {
        status: "error",
        error: err?.errorMessage || err?.message || "Network error.",
      });
    }
  }, [items, service, updateItem]);

  const publishedCount = items.filter((i) => i.status === "published").length;
  const pendingCount = items.filter((i) =>
    ["idle", "scraping", "scraped", "error"].includes(i.status)
  ).length;

  return (
    <Box style={{ padding: "0 0 24px" }}>
      {/* URL input */}
      <Box style={{ marginBottom: 16 }}>
        <Typography variant="subtitle2" style={{ marginBottom: 4, fontWeight: 700 }}>
          Facebook URL(s)
        </Typography>
        <Typography variant="body2" style={{ color: "#6b7280", marginBottom: 8, fontSize: "0.82rem" }}>
          Paste a <strong>page URL</strong> (e.g. facebook.com/LeslieCoBOE) to discover recent posts, or paste
          one or more <strong>post URLs</strong> (one per line) to scrape directly.
        </Typography>
        <TextField
          fullWidth
          multiline
          rows={3}
          variant="outlined"
          size="small"
          placeholder={
            "https://www.facebook.com/SomePageName\n— or —\nhttps://www.facebook.com/SomePage/posts/1234567"
          }
          value={urlInput}
          onChange={(e) => setUrlInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) handleSubmit();
          }}
        />
        <Box style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}>
          <Button
            variant="contained"
            color="primary"
            size="small"
            onClick={handleSubmit}
            disabled={!urlInput.trim() || pageLoading}
            startIcon={
              pageLoading
                ? <CircularProgress size={14} style={{ color: "#fff" }} />
                : null
            }
          >
            {pageLoading ? "Discovering…" : "Scrape / Discover Posts"}
          </Button>
          {items.length > 0 && (
            <Typography variant="caption" style={{ color: "#6b7280", marginLeft: 8 }}>
              {publishedCount > 0 && `${publishedCount} published`}
              {publishedCount > 0 && pendingCount > 0 && " · "}
              {pendingCount > 0 && `${pendingCount} pending`}
            </Typography>
          )}
        </Box>
        {globalError && (
          <Typography variant="body2" style={{ color: "#ef4444", marginTop: 6, fontSize: "0.82rem" }}>
            ⚠ {globalError}
          </Typography>
        )}
      </Box>

      {/* Page post pickers */}
      {pageResults.map((result, i) => (
        <PagePostPicker
          key={i}
          result={result}
          onScrapeSelected={(postUrls) => {
            setPageResults((prev) => prev.filter((_, idx) => idx !== i));
            addAndScrapePostUrls(postUrls);
          }}
          onDismiss={() => setPageResults((prev) => prev.filter((_, idx) => idx !== i))}
        />
      ))}

      {/* Article cards */}
      {items.map((item) => (
        <ArticleCard
          key={item.id}
          item={item}
          onUpdate={updateItem}
          onPublish={publishOne}
          onDiscard={(id) => updateItem(id, { status: "discarded" })}
          onRescrape={(id) => {
            const it = items.find((x) => x.id === id);
            if (it) scrapeOne(id, it.url);
          }}
        />
      ))}

      {items.length === 0 && pageResults.length === 0 && (
        <Box style={{ textAlign: "center", padding: "40px 0", color: "#9ca3af" }}>
          <Typography variant="body2">
            No posts yet. Paste a Facebook URL above to get started.
          </Typography>
        </Box>
      )}
    </Box>
  );
}
