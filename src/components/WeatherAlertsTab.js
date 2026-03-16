import React from "react";
import {
  Box,
  Button,
  Chip,
  CircularProgress,
  Paper,
  TextField,
  Typography,
} from "@material-ui/core";

export default function WeatherAlertsTab({ service }) {
  const [posts, setPosts] = React.useState([]);
  const [postedNwsIds, setPostedNwsIds] = React.useState(new Set());
  const [loading, setLoading] = React.useState(false);
  const [fetchStatus, setFetchStatus] = React.useState("");
  const [error, setError] = React.useState("");
  const [editingId, setEditingId] = React.useState(null);
  const [editText, setEditText] = React.useState("");
  const [savingId, setSavingId] = React.useState(null);
  const [deletingId, setDeletingId] = React.useState(null);
  const [copiedId, setCopiedId] = React.useState(null);
  const [manualText, setManualText] = React.useState("");
  const [savingManual, setSavingManual] = React.useState(false);
  const [filter, setFilter] = React.useState("all");

  React.useEffect(() => {
    loadPosts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadPosts() {
    try {
      const data = await service.getWeatherAlertPosts();
      setPosts(data.posts || []);
      setPostedNwsIds(new Set(data.postedNwsIds || []));
    } catch {
      // silently ignore on initial load
    }
  }

  function formatExpires(dateStr) {
    if (!dateStr) return null;
    try {
      return new Date(dateStr).toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
        timeZoneName: "short",
      });
    } catch {
      return dateStr;
    }
  }

  function buildPostText(feat) {
    const p = feat.properties;
    const event = p.event || "Weather Alert";
    const area = (p.areaDesc || "").split(";").slice(0, 5).join(", ");
    const expires = formatExpires(p.expires);
    const headline = (p.headline || "").trim();
    const desc = (p.description || "").split("\n").slice(0, 6).join("\n").trim();
    const instruction = (p.instruction || "").trim();

    const lines = [];
    lines.push(event.toUpperCase());
    lines.push("");
    if (area) lines.push(`Area: ${area}`);
    if (expires) lines.push(`Expires: ${expires}`);
    if (p.severity) lines.push(`Severity: ${p.severity}`);
    if (headline && headline !== event) {
      lines.push("");
      lines.push(headline);
    }
    if (desc) {
      lines.push("");
      lines.push(desc);
    }
    if (instruction) {
      lines.push("");
      lines.push(instruction);
    }
    lines.push("");
    lines.push("— Eastern Kentucky Weather");
    return lines.join("\n");
  }

  async function fetchAlerts() {
    setLoading(true);
    setFetchStatus("Pulling NWS data...");
    setError("");
    try {
      const areas = ["KY", "WV", "VA", "TN"];
      const all = [];
      for (const area of areas) {
        const res = await fetch(`https://api.weather.gov/alerts/active?area=${area}`);
        if (!res.ok) continue;
        const data = await res.json();
        if (data.features) all.push(...data.features);
      }

      let added = 0;
      const newPostedIds = new Set(postedNwsIds);

      for (const feat of all) {
        const nwsId = feat.id || feat.properties?.id || null;
        if (nwsId && newPostedIds.has(nwsId)) continue;

        const post_text = buildPostText(feat);
        const payload = {
          nws_alert_id: nwsId,
          event: feat.properties?.event || "Weather Alert",
          area: feat.properties?.areaDesc || "",
          severity: feat.properties?.severity || "Unknown",
          expires_at: feat.properties?.expires || null,
          post_text,
        };

        try {
          await service.saveWeatherAlertPost(payload);
          if (nwsId) newPostedIds.add(nwsId);
          added++;
        } catch (saveErr) {
          if (saveErr?.status !== 409 && saveErr?.errorMessage !== "Alert already posted") {
            console.warn("save failed", saveErr);
          }
        }
      }

      setPostedNwsIds(newPostedIds);
      await loadPosts();
      setFetchStatus(
        all.length === 0
          ? "No active alerts found."
          : `${all.length} active alert${all.length !== 1 ? "s" : ""} — ${added} new post${added !== 1 ? "s" : ""} saved.`
      );
    } catch {
      setError("Failed to fetch NWS alerts. Check your connection.");
      setFetchStatus("");
    } finally {
      setLoading(false);
    }
  }

  async function saveEdit(id) {
    if (!editText.trim()) return;
    setSavingId(id);
    try {
      await service.updateWeatherAlertPost({ id, post_text: editText });
      setPosts((prev) =>
        prev.map((p) => (p.id === id ? { ...p, post_text: editText } : p))
      );
      setEditingId(null);
      setEditText("");
    } catch (e) {
      setError(e?.errorMessage || "Failed to save edit.");
    } finally {
      setSavingId(null);
    }
  }

  async function handleDelete(id) {
    setDeletingId(id);
    try {
      await service.deleteWeatherAlertPost(id);
      setPosts((prev) => prev.filter((p) => p.id !== id));
    } catch (e) {
      setError(e?.errorMessage || "Failed to delete post.");
    } finally {
      setDeletingId(null);
    }
  }

  async function addManualPost() {
    const text = manualText.trim();
    if (!text) return;
    setSavingManual(true);
    try {
      await service.saveWeatherAlertPost({
        nws_alert_id: null,
        event: "Manual update",
        area: "",
        severity: "Unknown",
        expires_at: null,
        post_text: text,
      });
      setManualText("");
      await loadPosts();
    } catch (e) {
      setError(e?.errorMessage || "Failed to save manual post.");
    } finally {
      setSavingManual(false);
    }
  }

  function copyToClipboard(id, text) {
    const markCopied = () => {
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    };
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(markCopied).catch(() => {
        fallbackCopy(text);
        markCopied();
      });
    } else {
      fallbackCopy(text);
      markCopied();
    }
  }

  function fallbackCopy(text) {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }

  const severityColor = (sev) => {
    switch ((sev || "").toLowerCase()) {
      case "extreme": return "error";
      case "moderate": return "primary";
      default: return "default";
    }
  };

  const borderColor = (sev) => {
    switch ((sev || "").toLowerCase()) {
      case "extreme": return "#f44336";
      case "severe": return "#ff9800";
      case "moderate": return "#1976d2";
      default: return "#ccc";
    }
  };

  const filtered =
    filter === "all"
      ? posts
      : posts.filter((p) => (p.severity || "").toLowerCase() === filter.toLowerCase());

  const counts = {
    total: posts.length,
    extreme: posts.filter((p) => (p.severity || "").toLowerCase() === "extreme").length,
    severe: posts.filter((p) => (p.severity || "").toLowerCase() === "severe").length,
    moderate: posts.filter((p) => (p.severity || "").toLowerCase() === "moderate").length,
  };

  return (
    <Box>
      {/* Header row */}
      <Box
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 8,
          marginBottom: 12,
        }}
      >
        <Box>
          <Typography variant="h6" style={{ marginBottom: 2 }}>
            Weather Alert Posts
          </Typography>
          <Typography variant="body2" color="textSecondary">
            Fetches live NWS alerts for KY, WV, VA and TN. Each alert is saved
            as a formatted post you can edit, copy, and paste to Facebook.
            Already-posted alerts are never duplicated.
          </Typography>
        </Box>
        <Button
          variant="contained"
          color="primary"
          onClick={fetchAlerts}
          disabled={loading}
        >
          {loading ? (
            <>
              <CircularProgress size={14} style={{ marginRight: 6 }} />
              Fetching...
            </>
          ) : (
            "Fetch NWS Alerts"
          )}
        </Button>
      </Box>

      {fetchStatus && (
        <Typography variant="body2" color="textSecondary" style={{ marginBottom: 8 }}>
          {fetchStatus}
        </Typography>
      )}
      {error && (
        <Typography variant="body2" color="error" style={{ marginBottom: 8 }}>
          {error}
        </Typography>
      )}

      {/* Summary counts */}
      {posts.length > 0 && (
        <Box style={{ display: "flex", gap: 16, marginBottom: 12, flexWrap: "wrap" }}>
          {[
            { label: "Total", value: counts.total, key: "all" },
            { label: "Extreme", value: counts.extreme, key: "extreme" },
            { label: "Severe", value: counts.severe, key: "severe" },
            { label: "Moderate", value: counts.moderate, key: "moderate" },
          ].map(({ label, value, key }) => (
            <Paper
              key={key}
              onClick={() => setFilter(key)}
              style={{
                padding: "8px 16px",
                cursor: "pointer",
                borderBottom:
                  filter === key ? "2px solid #1976d2" : "2px solid transparent",
                minWidth: 80,
                textAlign: "center",
              }}
            >
              <Typography variant="h6">{value}</Typography>
              <Typography variant="caption" color="textSecondary">
                {label}
              </Typography>
            </Paper>
          ))}
        </Box>
      )}

      {/* Empty states */}
      {filtered.length === 0 && posts.length === 0 && (
        <Paper style={{ padding: 24, textAlign: "center" }}>
          <Typography variant="body2" color="textSecondary">
            No posts yet. Click &ldquo;Fetch NWS Alerts&rdquo; to pull live
            alerts, or write a manual post below.
          </Typography>
        </Paper>
      )}
      {filtered.length === 0 && posts.length > 0 && (
        <Typography variant="body2" color="textSecondary" style={{ marginBottom: 8 }}>
          No posts match this filter.
        </Typography>
      )}

      {/* Post cards */}
      {filtered.map((post) => (
        <Paper
          key={post.id}
          style={{
            padding: 16,
            marginBottom: 12,
            borderLeft: `4px solid ${borderColor(post.severity)}`,
          }}
        >
          {/* Card header */}
          <Box
            style={{
              display: "flex",
              justifyContent: "space-between",
              flexWrap: "wrap",
              gap: 4,
              marginBottom: 8,
            }}
          >
            <Box>
              <Box
                style={{
                  display: "flex",
                  gap: 6,
                  alignItems: "center",
                  flexWrap: "wrap",
                  marginBottom: 4,
                }}
              >
                <Chip
                  label={post.severity || "Unknown"}
                  size="small"
                  color={severityColor(post.severity)}
                />
                {!post.nws_alert_id && <Chip label="Manual" size="small" />}
                <Typography variant="subtitle2">{post.event}</Typography>
              </Box>
              {post.area && (
                <Typography variant="body2" color="textSecondary" style={{ marginBottom: 2 }}>
                  {post.area.split(";").slice(0, 4).join(" · ")}
                </Typography>
              )}
            </Box>
            <Box style={{ textAlign: "right" }}>
              {post.expires_at && (
                <Typography variant="caption" color="textSecondary" display="block">
                  Expires {formatExpires(post.expires_at)}
                </Typography>
              )}
              <Typography variant="caption" color="textSecondary" display="block">
                Added{" "}
                {new Date(post.created_at).toLocaleString("en-US", {
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                  hour12: true,
                })}
              </Typography>
            </Box>
          </Box>

          {/* Post body — editable or read-only */}
          {editingId === post.id ? (
            <TextField
              multiline
              fullWidth
              variant="outlined"
              size="small"
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              inputProps={{ style: { fontFamily: "monospace", fontSize: 13 } }}
              style={{ marginBottom: 8 }}
            />
          ) : (
            <Paper
              variant="outlined"
              style={{
                padding: 12,
                marginBottom: 8,
                background: "rgba(0,0,0,0.02)",
                whiteSpace: "pre-wrap",
                fontFamily: "monospace",
                fontSize: 13,
                lineHeight: 1.6,
              }}
            >
              {post.post_text}
            </Paper>
          )}

          {/* Actions */}
          <Box style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <Button
              size="small"
              variant="outlined"
              onClick={() =>
                copyToClipboard(
                  post.id,
                  editingId === post.id ? editText : post.post_text
                )
              }
            >
              {copiedId === post.id ? "Copied!" : "Copy for Facebook"}
            </Button>

            {editingId === post.id ? (
              <>
                <Button
                  size="small"
                  variant="contained"
                  color="primary"
                  disabled={savingId === post.id}
                  onClick={() => saveEdit(post.id)}
                >
                  {savingId === post.id ? "Saving..." : "Save"}
                </Button>
                <Button
                  size="small"
                  onClick={() => {
                    setEditingId(null);
                    setEditText("");
                  }}
                >
                  Cancel
                </Button>
              </>
            ) : (
              <Button
                size="small"
                variant="outlined"
                onClick={() => {
                  setEditingId(post.id);
                  setEditText(post.post_text);
                }}
              >
                Edit
              </Button>
            )}

            <Button
              size="small"
              variant="outlined"
              color="secondary"
              disabled={deletingId === post.id}
              onClick={() => handleDelete(post.id)}
            >
              {deletingId === post.id ? "Deleting..." : "Delete"}
            </Button>
          </Box>
        </Paper>
      ))}

      {/* Manual post composer */}
      <Paper style={{ padding: 16, marginTop: 8 }}>
        <Typography variant="subtitle2" style={{ marginBottom: 8 }}>
          Create manual post
        </Typography>
        <TextField
          multiline
          fullWidth
          variant="outlined"
          size="small"
          placeholder="Write a custom weather update, local observation, or note..."
          value={manualText}
          onChange={(e) => setManualText(e.target.value)}
          rows={4}
          style={{ marginBottom: 8 }}
        />
        <Box style={{ display: "flex", gap: 8 }}>
          <Button
            variant="contained"
            color="primary"
            size="small"
            disabled={savingManual || !manualText.trim()}
            onClick={addManualPost}
          >
            {savingManual ? "Saving..." : "Add to console"}
          </Button>
          <Button size="small" onClick={() => setManualText("")}>
            Clear
          </Button>
        </Box>
      </Paper>
    </Box>
  );
}
