import React from "react";
import {
  Box,
  Button,
  CircularProgress,
  Paper,
  Typography,
} from "@material-ui/core";

const OFFICES = [
  { id: "KJKL", label: "Jackson KY", sublabel: "Eastern Kentucky" },
  { id: "KLMK", label: "Louisville KY", sublabel: "Central Kentucky" },
  { id: "KPAH", label: "Paducah KY", sublabel: "Western Kentucky" },
];

const NWS_HEADERS = {
  "User-Agent": "LocalKYNews/1.0 (localkynews.com; news@localkynews.com)",
  Accept: "application/geo+json, application/json",
};

function fmtTime(dateStr) {
  if (!dateStr) return "";
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

export default function NwsDiscussionsTab() {
  const [byOffice, setByOffice] = React.useState({});
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState("");
  const [activeOffice, setActiveOffice] = React.useState("KJKL");
  const [expanded, setExpanded] = React.useState(null);
  const [texts, setTexts] = React.useState({});
  const [loadingId, setLoadingId] = React.useState(null);
  const [copiedId, setCopiedId] = React.useState(null);
  const [copiedFbId, setCopiedFbId] = React.useState(null);

  function formatForFacebook(rawText, officeLabel) {
    if (!rawText) return "";
    const text = rawText.replace(/\r\n/g, "\n");

    // ── 1. Split AFD into named sections (separated by && on its own line) ──
    const rawChunks = text.split(/\n&&\s*\n/);
    const sections = [];
    for (const chunk of rawChunks) {
      const hm = chunk.match(/^\s*\.([\w /\-]+?)\.\.\./m);
      sections.push({
        name: hm ? hm[1].trim().toUpperCase().replace(/\s+/g, " ") : "_HDR",
        body: chunk,
      });
    }
    const findSection = (prefix) => sections.find((s) => s.name.startsWith(prefix));

    // ── 2. Preserve blank-line paragraph structure, strip only NWS metadata ──
    function cleanBody(body) {
      // Re-join word-wrapped lines within a paragraph (lines that don't start
      // a new paragraph or bullet), then preserve paragraph breaks.
      const rawLines = body.split("\n");
      const joined = [];
      let buf = "";
      for (const raw of rawLines) {
        const l = raw.trim();
        // Blank line → flush buffer and record paragraph break
        if (!l) {
          if (buf) { joined.push(buf); buf = ""; }
          joined.push("");
          continue;
        }
        // Drop NWS header / metadata lines
        if (/^(issued at|[.][A-Z]|[$&]|FXUS|AFDJKL|AREA FORECAST|NATIONAL WEATHER|UPDATE\b)/i.test(l)) {
          if (buf) { joined.push(buf); buf = ""; }
          continue;
        }
        // Bullet lines (start with "-") are their own paragraph
        if (/^-/.test(l)) {
          if (buf) { joined.push(buf); buf = ""; }
          buf = l;
          joined.push(buf); buf = "";
          continue;
        }
        // Continuation of current paragraph
        buf = buf ? buf + " " + l : l;
      }
      if (buf) joined.push(buf);
      // Collapse runs of blank lines to a single blank line
      return joined.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    }

    function removeJargon(s) {
      return s
        .replace(/\b(BUFKIT|QPF|PoPs?|NBM|CWA|ENS|GEFS|NDFD|T\/Td|CAA|ASOS|SAF|FXUS|TAF|progg?ed|sfc|aloft|\d+\s*mb|\d{2,3}Z\b|MOS|BUFR|deterministic|insolation|trough|shortwave|vort|theta-e|dewpoint|dew point|omega|helicity|hodograph|virga|escarpment|Pottsville)\b/gi, "")
        .replace(/\s{2,}/g, " ")
        .trim();
    }

    // Extract a temperature range from a paragraph.
    // Handles: "highs in the low to mid 60s", "temperatures will peak in the mid to upper 40s",
    //          "highs reaching the low to mid-60s", "highs in the upper 60s to mid 70s"
    function extractTemp(para) {
      const RANGE = /(?:(?:low|mid|middle|upper|lower)\s+(?:to\s+)?){1,2}\d{2}s?(?:\s+(?:to|or|and)\s+(?:(?:low|mid|middle|upper|lower)\s+)?\d{2}s?)?|\d{2}s?\s+to\s+\d{2}s?/i;
      // Prefer a sentence that contains "high"
      const highSent = para.match(/high[s]?[^.!?]{0,160}/i);
      if (highSent) {
        const m = highSent[0].match(RANGE);
        if (m) return m[0].replace(/\s+/g, " ").trim();
      }
      // Fall back: any temperature sentence with "low/mid/upper Xs"
      const tempSent = para.match(/temp[^.!?]{0,160}/i);
      if (tempSent) {
        const m = tempSent[0].match(RANGE);
        if (m) return m[0].replace(/\s+/g, " ").trim();
      }
      return null;
    }

    function weatherConditions(para) {
      const bullets = [];
      const p = para.toLowerCase();
      if (/t-?storm|thunder.?storm/.test(p)) {
        bullets.push(/isolated|stray|brief|few|slight/.test(p) ? "Isolated storm possible" : "Storms possible");
      } else if (/shower/.test(p)) {
        const qualifier = /stray|isolated|slight|chance/.test(p) ? "Slight chance of showers" : "Showers possible";
        bullets.push(qualifier);
      }
      if (/gusty|gusts/.test(p)) bullets.push("Gusty winds expected");
      else if (/\bwindy\b/.test(p)) bullets.push("Windy");
      if (!bullets.length && /\bmostly sunny\b|\bclear\b/.test(p)) bullets.push("Mostly sunny");
      return bullets;
    }

    // ── 3. Day-by-day extraction ──────────────────────────────────────────────
    const DAY_EMOJI = {
      TONIGHT: "🌙", OVERNIGHT: "🌙", TOMORROW: "🌤️", "TOMORROW NIGHT": "🌙",
      "FRIDAY NIGHT": "🌩️", "SATURDAY NIGHT": "🌙", "SUNDAY NIGHT": "🌩️",
      "MONDAY NIGHT": "🌙", "TUESDAY NIGHT": "🌙", "WEDNESDAY NIGHT": "🌙", "THURSDAY NIGHT": "🌙",
      MONDAY: "🌤️", TUESDAY: "🌤️", WEDNESDAY: "🌦️",
      THURSDAY: "🌤️", FRIDAY: "🌬️", SATURDAY: "☀️", SUNDAY: "☀️",
    };
    // Match "FRIDAY NIGHT" before "FRIDAY"
    const DAY_RE = /\b((?:MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY|SATURDAY|SUNDAY) NIGHT|TONIGHT|OVERNIGHT|TOMORROW NIGHT|TOMORROW|MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY|SATURDAY|SUNDAY)\b/gi;

    function extractDays(forecastText) {
      // Split on preserved paragraph breaks
      const paras = forecastText
        .split(/\n\n+/)
        .map((p) => p.replace(/\n/g, " ").replace(/\s+/g, " ").trim())
        .filter(Boolean);

      const result = [];
      const seen = new Set();
      for (const para of paras) {
        DAY_RE.lastIndex = 0;
        const found = [];
        let m;
        while ((m = DAY_RE.exec(para)) !== null) {
          const d = m[1].toUpperCase();
          if (!found.includes(d)) found.push(d);
        }
        if (!found.length) continue;
        const day = found.find((d) => !seen.has(d));
        if (!day) continue;
        seen.add(day);
        const lines = [];
        const highT = extractTemp(para);
        if (highT) lines.push(`Highs ${highT}`);
        lines.push(...weatherConditions(para));
        if (lines.length > 0) {
          result.push({ header: `${DAY_EMOJI[day] || "🌤️"} ${day}`, lines });
        }
      }
      return result;
    }

    // ── 4. Assemble the post ──────────────────────────────────────────────────
    const label = officeLabel || "Eastern Kentucky";
    const out = [];
    out.push(`🌤️ ${label} Weather Update`);
    out.push("");

    // Active watches/warnings (skip if "None")
    const wwaSection = sections.find(
      (s) => (s.name.includes("WATCHES") || s.name.includes("WARNINGS")) && s.name !== "_HDR"
    );
    if (wwaSection) {
      const advLines = cleanBody(wwaSection.body)
        .split("\n")
        .filter((l) => l.trim() && !/^none\.?$/i.test(l.trim()));
      if (advLines.length > 0) {
        out.push("⚠️ ACTIVE ALERTS:");
        advLines.forEach((l) => out.push(l));
        out.push("");
      }
    }

    // Key Messages → KEY TAKEAWAYS
    // Bullets in AFDs are word-wrapped, so we must re-join continuation lines
    const kmSec = findSection("KEY MESSAGE");
    if (kmSec) {
      const kmLines = kmSec.body.split("\n").map((l) => l.trim());
      const bullets = [];
      let current = "";
      for (const l of kmLines) {
        if (/^-\s/.test(l)) {
          if (current) bullets.push(current.replace(/\s+/g, " ").trim());
          current = l.replace(/^-\s*/, "");
        } else if (current && l && !/^(issued at|\.|[$&])/i.test(l)) {
          // continuation of previous bullet
          current += " " + l;
        } else {
          if (current) { bullets.push(current.replace(/\s+/g, " ").trim()); current = ""; }
        }
      }
      if (current) bullets.push(current.replace(/\s+/g, " ").trim());
      if (bullets.length > 0) {
        out.push("KEY TAKEAWAYS:");
        bullets.forEach((b) => out.push("- " + b));
        out.push("");
      }
    }

    // SHORT TERM + LONG TERM → WHAT TO EXPECT (day-by-day)
    const fSecs = sections.filter(
      (s) => s.name.startsWith("SHORT TERM") || s.name.startsWith("LONG TERM")
    );
    if (fSecs.length > 0) {
      const combined = fSecs.map((s) => removeJargon(cleanBody(s.body))).join("\n\n");
      const days = extractDays(combined);
      if (days.length > 0) {
        out.push("WHAT TO EXPECT:");
        out.push("");
        for (const d of days) {
          out.push(d.header + ":");
          d.lines.forEach((l) => out.push(l));
          out.push("");
        }
      }

      // Bottom line: last substantive sentence of the long-term section
      const lastClean = removeJargon(cleanBody(fSecs[fSecs.length - 1].body))
        .replace(/\n/g, " ")
        .replace(/\s+/g, " ");
      const sents = lastClean
        .split(/(?<=[.!?])\s+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 50 && !/^(as of|issued)/i.test(s));
      if (sents.length > 0) {
        out.push("BOTTOM LINE:");
        out.push(sents[sents.length - 1]);
      }
    }

    return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  function copyForFacebook(pid) {
    const text = texts[pid] || "";
    const office = OFFICES.find((o) => o.id === activeOffice);
    const formatted = formatForFacebook(text, office ? office.sublabel : undefined);
    const markCopied = () => {
      setCopiedFbId(pid);
      setTimeout(() => setCopiedFbId(null), 2000);
    };
    if (navigator.clipboard) {
      navigator.clipboard.writeText(formatted).then(markCopied).catch(() => {
        fallbackCopy(formatted);
        markCopied();
      });
    } else {
      fallbackCopy(formatted);
      markCopied();
    }
  }

  React.useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function load() {
    setLoading(true);
    setError("");
    setExpanded(null);
    try {
      const res = await fetch("https://api.weather.gov/products/types/AFD", {
        headers: NWS_HEADERS,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const all = data["@graph"] || [];
      const grouped = {};
      for (const o of OFFICES) grouped[o.id] = [];
      for (const p of all) {
        if (grouped[p.issuingOffice]) grouped[p.issuingOffice].push(p);
      }
      setByOffice(grouped);
    } catch (e) {
      setError("Failed to fetch discussions: " + e.message);
    } finally {
      setLoading(false);
    }
  }

  async function toggle(product) {
    const pid = product.id;
    if (expanded === pid) {
      setExpanded(null);
      return;
    }
    setExpanded(pid);
    if (texts[pid] !== undefined) return;
    setLoadingId(pid);
    try {
      const res = await fetch(`https://api.weather.gov/products/${pid}`, {
        headers: NWS_HEADERS,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setTexts((prev) => ({ ...prev, [pid]: data.productText || "(No text available)" }));
    } catch (e) {
      setTexts((prev) => ({ ...prev, [pid]: "Error loading text: " + e.message }));
    } finally {
      setLoadingId(null);
    }
  }

  function copy(pid) {
    const text = texts[pid] || "";
    const markCopied = () => {
      setCopiedId(pid);
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

  const currentProducts = byOffice[activeOffice] || [];

  return (
    <Box>
      {/* Header */}
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
            NWS Discussions
          </Typography>
          <Typography variant="body2" color="textSecondary">
            Area Forecast Discussions from NWS Jackson, Louisville, and Paducah
            offices. Click any discussion to read the full text.
          </Typography>
        </Box>
        <Button
          variant="contained"
          color="primary"
          onClick={load}
          disabled={loading}
        >
          {loading ? (
            <>
              <CircularProgress size={14} style={{ marginRight: 6 }} />
              Loading...
            </>
          ) : (
            "Refresh"
          )}
        </Button>
      </Box>

      {error && (
        <Typography variant="body2" color="error" style={{ marginBottom: 8 }}>
          {error}
        </Typography>
      )}

      {/* Office selector */}
      <Box style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        {OFFICES.map((o) => {
          const count = (byOffice[o.id] || []).length;
          return (
            <Paper
              key={o.id}
              onClick={() => {
                setActiveOffice(o.id);
                setExpanded(null);
              }}
              style={{
                padding: "10px 20px",
                cursor: "pointer",
                borderBottom:
                  activeOffice === o.id
                    ? "3px solid #1976d2"
                    : "3px solid transparent",
                minWidth: 140,
                textAlign: "center",
                userSelect: "none",
              }}
            >
              <Typography
                variant="subtitle2"
                style={{ fontWeight: activeOffice === o.id ? 700 : 400 }}
              >
                {o.label}
              </Typography>
              <Typography variant="caption" color="textSecondary" display="block">
                {o.sublabel}
              </Typography>
              {!loading && count > 0 && (
                <Typography
                  variant="caption"
                  color="textSecondary"
                  display="block"
                  style={{ marginTop: 2 }}
                >
                  {count} discussion{count !== 1 ? "s" : ""}
                </Typography>
              )}
            </Paper>
          );
        })}
      </Box>

      {/* Loading spinner */}
      {loading && (
        <Box style={{ display: "flex", justifyContent: "center", padding: 48 }}>
          <CircularProgress />
        </Box>
      )}

      {/* Empty state */}
      {!loading && currentProducts.length === 0 && !error && (
        <Paper style={{ padding: 24, textAlign: "center" }}>
          <Typography variant="body2" color="textSecondary">
            No discussions found for this office.
          </Typography>
        </Paper>
      )}

      {/* Discussion cards */}
      {!loading &&
        currentProducts.map((p) => (
          <Paper key={p.id} style={{ marginBottom: 10, overflow: "hidden" }}>
            <Box
              style={{
                padding: "12px 16px",
                cursor: "pointer",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "flex-start",
                userSelect: "none",
              }}
              onClick={() => toggle(p)}
            >
              <Box>
                <Typography variant="subtitle2" style={{ marginBottom: 2 }}>
                  {p.productName}
                </Typography>
                <Typography variant="caption" color="textSecondary">
                  {fmtTime(p.issuanceTime)}
                </Typography>
              </Box>
              <Typography
                variant="body2"
                color="textSecondary"
                style={{ marginLeft: 8, flexShrink: 0 }}
              >
                {expanded === p.id ? "▲ Collapse" : "▼ Expand"}
              </Typography>
            </Box>

            {expanded === p.id && (
              <Box
                style={{
                  borderTop: "1px solid rgba(0,0,0,0.08)",
                  padding: "12px 16px",
                }}
              >
                {loadingId === p.id ? (
                  <Box style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <CircularProgress size={16} />
                    <Typography variant="body2" color="textSecondary">
                      Loading discussion text...
                    </Typography>
                  </Box>
                ) : (
                  <>
                    <Paper
                      variant="outlined"
                      style={{
                        padding: 12,
                        marginBottom: 8,
                        background: "rgba(0,0,0,0.02)",
                        whiteSpace: "pre-wrap",
                        fontFamily: "monospace",
                        fontSize: 12,
                        lineHeight: 1.6,
                        maxHeight: 500,
                        overflow: "auto",
                      }}
                    >
                      {texts[p.id]}
                    </Paper>
                    <Box style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <Button
                        size="small"
                        variant="outlined"
                        onClick={() => copy(p.id)}
                      >
                        {copiedId === p.id ? "Copied!" : "Copy Text"}
                      </Button>
                      <Button
                        size="small"
                        variant="outlined"
                        onClick={() => copyForFacebook(p.id)}
                      >
                        {copiedFbId === p.id ? "Copied!" : "Copy for Facebook"}
                      </Button>
                    </Box>
                  </>
                )}
              </Box>
            )}
          </Paper>
        ))}
    </Box>
  );
}
