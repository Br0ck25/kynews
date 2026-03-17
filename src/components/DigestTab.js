import React, { useEffect, useState } from "react";
import {
  Box,
  Button,
  CircularProgress,
  Paper,
  TextField,
  Typography,
} from "@material-ui/core";

export default function DigestTab({ service }) {
  const [morning, setMorning] = useState(null); // { text, generatedAt }
  const [evening, setEvening] = useState(null);
  const [loading, setLoading] = useState(true);
  const [generatingMorning, setGeneratingMorning] = useState(false);
  const [generatingEvening, setGeneratingEvening] = useState(false);
  const [editingMorning, setEditingMorning] = useState(false);
  const [editingEvening, setEditingEvening] = useState(false);
  const [morningText, setMorningText] = useState("");
  const [eveningText, setEveningText] = useState("");
  const [savingMorning, setSavingMorning] = useState(false);
  const [savingEvening, setSavingEvening] = useState(false);
  const [copiedMorning, setCopiedMorning] = useState(false);
  const [copiedEvening, setCopiedEvening] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    loadDigests();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadDigests() {
    setLoading(true);
    setError("");
    try {
      const data = await service.getDigests();
      if (data?.morning) setMorning(data.morning);
      if (data?.evening) setEvening(data.evening);
    } catch {
      setError("Failed to load digests.");
    } finally {
      setLoading(false);
    }
  }

  async function handleGenerate(when) {
    const setGenerating = when === "morning" ? setGeneratingMorning : setGeneratingEvening;
    setGenerating(true);
    setError("");
    try {
      const data = await service.generateDigest(when);
      if (data?.text) {
        const entry = { text: data.text, generatedAt: data.generatedAt };
        if (when === "morning") {
          setMorning(entry);
          setMorningText(data.text);
          setEditingMorning(false);
        } else {
          setEvening(entry);
          setEveningText(data.text);
          setEditingEvening(false);
        }
      }
    } catch {
      setError(`Failed to generate ${when} digest.`);
    } finally {
      setGenerating(false);
    }
  }

  async function handleSave(when) {
    const text = when === "morning" ? morningText : eveningText;
    const setSaving = when === "morning" ? setSavingMorning : setSavingEvening;
    setSaving(true);
    setError("");
    try {
      await service.saveDigest(when, text);
      const entry = { text, generatedAt: new Date().toISOString() };
      if (when === "morning") {
        setMorning(entry);
        setEditingMorning(false);
      } else {
        setEvening(entry);
        setEditingEvening(false);
      }
    } catch {
      setError(`Failed to save ${when} digest.`);
    } finally {
      setSaving(false);
    }
  }

  async function handleCopy(text, when) {
    try {
      await navigator.clipboard.writeText(text);
      if (when === "morning") {
        setCopiedMorning(true);
        setTimeout(() => setCopiedMorning(false), 2500);
      } else {
        setCopiedEvening(true);
        setTimeout(() => setCopiedEvening(false), 2500);
      }
    } catch {
      setError("Copy failed — please select and copy the text manually.");
    }
  }

  function startEdit(when) {
    if (when === "morning") {
      setMorningText(morning?.text ?? "");
      setEditingMorning(true);
    } else {
      setEveningText(evening?.text ?? "");
      setEditingEvening(true);
    }
  }

  function cancelEdit(when) {
    if (when === "morning") setEditingMorning(false);
    else setEditingEvening(false);
  }

  function renderSection(when) {
    const entry = when === "morning" ? morning : evening;
    const generating = when === "morning" ? generatingMorning : generatingEvening;
    const editing = when === "morning" ? editingMorning : editingEvening;
    const editText = when === "morning" ? morningText : eveningText;
    const setEditText = when === "morning" ? setMorningText : setEveningText;
    const saving = when === "morning" ? savingMorning : savingEvening;
    const copied = when === "morning" ? copiedMorning : copiedEvening;
    const label = when === "morning" ? "Morning News Roundup" : "Evening Recap";

    return (
      <Paper style={{ padding: 20, marginBottom: 24 }}>
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
          <Typography variant="h6" style={{ fontWeight: 700 }}>
            {label}
          </Typography>

          <Box style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {entry && !editing && (
              <>
                <Button
                  variant="contained"
                  color="primary"
                  size="small"
                  onClick={() => handleCopy(entry.text, when)}
                >
                  {copied ? "✓ Copied!" : "Copy for Facebook"}
                </Button>
                <Button
                  variant="outlined"
                  size="small"
                  onClick={() => startEdit(when)}
                >
                  Edit
                </Button>
              </>
            )}

            {editing && (
              <>
                <Button
                  variant="contained"
                  color="primary"
                  size="small"
                  disabled={saving}
                  onClick={() => handleSave(when)}
                >
                  {saving ? "Saving…" : "Save"}
                </Button>
                <Button
                  variant="outlined"
                  size="small"
                  onClick={() => cancelEdit(when)}
                >
                  Cancel
                </Button>
              </>
            )}

            <Button
              variant="contained"
              color="secondary"
              size="small"
              disabled={generating}
              onClick={() => handleGenerate(when)}
              style={{ minWidth: 120 }}
            >
              {generating ? (
                <CircularProgress size={15} color="inherit" style={{ marginRight: 6 }} />
              ) : null}
              {generating ? "Generating…" : "Generate New"}
            </Button>
          </Box>
        </Box>

        {/* Timestamp */}
        {entry?.generatedAt && (
          <Typography
            variant="caption"
            color="textSecondary"
            style={{ display: "block", marginBottom: 10 }}
          >
            Last generated:{" "}
            {new Date(entry.generatedAt).toLocaleString("en-US", {
              timeZone: "America/New_York",
              dateStyle: "medium",
              timeStyle: "short",
            })}
          </Typography>
        )}

        {/* Body — edit textarea OR read-only pre block */}
        {editing ? (
          <TextField
            multiline
            fullWidth
            rows={18}
            variant="outlined"
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            inputProps={{ style: { fontFamily: "monospace", fontSize: 13, lineHeight: 1.6 } }}
          />
        ) : entry ? (
          <Box
            component="pre"
            style={{
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              fontFamily: "monospace",
              fontSize: 13,
              lineHeight: 1.6,
              background: "#f5f5f5",
              border: "1px solid #e0e0e0",
              borderRadius: 4,
              padding: "12px 14px",
              margin: 0,
            }}
          >
            {entry.text}
          </Box>
        ) : (
          <Typography color="textSecondary" variant="body2">
            No digest generated yet. Click <strong>Generate New</strong> to create one from
            today's top articles.
          </Typography>
        )}
      </Paper>
    );
  }

  if (loading) {
    return (
      <Box style={{ display: "flex", justifyContent: "center", padding: 40 }}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box>
      <Typography variant="body2" color="textSecondary" style={{ marginBottom: 20 }}>
        Digests are auto-generated at 6:45 AM and 6:45 PM Eastern from the latest today-category
        articles. Use <strong>Generate New</strong> to create one on demand,{" "}
        <strong>Edit</strong> to modify before posting, and{" "}
        <strong>Copy for Facebook</strong> to copy the formatted text to your clipboard.
      </Typography>

      {error && (
        <Typography color="error" variant="body2" style={{ marginBottom: 12 }}>
          {error}
        </Typography>
      )}

      {renderSection("morning")}
      {renderSection("evening")}
    </Box>
  );
}
