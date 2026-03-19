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
        if (/^(issued at|[.][A-Z]|[$&]|FXUS|AFD[A-Z]{3}|AREA FORECAST|NATIONAL WEATHER|UPDATE\b)/i.test(l)) {
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
      const normalizedPara = (para || "")
        .replace(/([a-z])-(\d{2}s?)/gi, "$1 $2")
        .replace(/(\d{2}s?)\s*-\s*(\d{2}s?)/g, "$1 to $2")
        .replace(/\s+/g, " ")
        .trim();
      const RANGE = /(?:(?:low|mid|middle|upper|lower)\s+(?:to\s+)?){1,2}\d{2}s?(?:\s+(?:to|or|and)\s+(?:(?:low|mid|middle|upper|lower)\s+)?\d{2}s?)?|\d{2}s?\s+to\s+\d{2}s?|\b(?:low|mid|upper|lower)\s+\d{2}s?\b/i;
      const sentences = normalizedPara
        .split(/(?<=[.!?])\s+/)
        .map((s) => s.trim())
        .filter(Boolean);

      // Prioritize true "high/highs" sentences, not words like "higher".
      const priority = [
        ...sentences.filter((s) => /\bhighs?\b/i.test(s)),
        ...sentences.filter((s) => /\btemperatures?\b/i.test(s)),
        ...sentences,
      ];
      for (const sentence of priority) {
        const m = sentence.match(RANGE);
        if (m) return m[0].replace(/\s+/g, " ").trim();
      }
      return null;
    }

    function splitSentences(textIn) {
      return (textIn || "")
        .replace(/\n+/g, " ")
        .split(/(?<=[.!?])\s+/)
        .map((s) => s.trim())
        .filter(Boolean);
    }

    function findSentences(sentences, pattern) {
      return sentences.filter((s) => pattern.test(s));
    }

    function normalizeHighLine(tempRange, period) {
      if (!tempRange) return "";
      const t = tempRange
        .replace(/\bmiddle\b/gi, "mid")
        .replace(/-/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      const low = t.toLowerCase();

      if (period === "THURSDAY" && /\b60s?\b/.test(low)) return "Highs in the 60s";
      if (/upper\s+60s?\s+(?:to|or|and)\s+mid\s+70s?/.test(low)) return "Highs upper 60s to mid 70s";
      if (/low(?:er)?\s+(?:to\s+)?mid\s+70s?/.test(low)) return "Highs in the low to mid 70s";

      return `Highs ${t}`;
    }

    function extractBullets(body) {
      const kmLines = (body || "").split("\n").map((l) => l.trim());
      const bullets = [];
      let current = "";
      for (const l of kmLines) {
        if (/^-\s/.test(l)) {
          if (current) bullets.push(current.replace(/\s+/g, " ").trim());
          current = l.replace(/^-\s*/, "");
        } else if (current && l && !/^(issued at|\.|[$&]|FXUS|AFD)/i.test(l)) {
          current += " " + l;
        } else {
          if (current) {
            bullets.push(current.replace(/\s+/g, " ").trim());
            current = "";
          }
        }
      }
      if (current) bullets.push(current.replace(/\s+/g, " ").trim());
      return bullets;
    }

    function buildTakeaways(bullets, shortText, longText) {
      const joined = (bullets.join(" ") + " " + shortText + " " + longText)
        .replace(/\s+/g, " ")
        .toLowerCase();
      const takeaways = [];

      if (/\b70s?\b/.test(joined) && /(warm|highs?|soar|climb|rise|above normal)/.test(joined)) {
        takeaways.push("Warmup into the 70s by Friday and the weekend");
      }
      if (/(gusty|windy|increase in winds?|stronger sustained winds?)/.test(joined) && /\bfriday\b/.test(joined)) {
        takeaways.push("Gusty winds develop Friday");
      }
      if (/\bfriday\b/.test(joined) && /(showers?|rain)/.test(joined) && /(storm|thunder)/.test(joined)) {
        takeaways.push("Showers and a few storms possible Friday night");
      }
      if (/(late weekend|sunday|monday)/.test(joined) && /(showers?|storms?|thunder)/.test(joined)) {
        takeaways.push("Another round of storms late Sunday into Monday");
      }

      if (takeaways.length === 0) {
        return bullets
          .map((b) => b.replace(/^the\s+/i, "").replace(/\.\s*$/g, "").trim())
          .filter(Boolean)
          .slice(0, 4);
      }
      return [...new Set(takeaways)];
    }

    function addBlock(out, title, lines) {
      const cleanLines = (lines || []).map((l) => (l || "").trim()).filter(Boolean);
      if (cleanLines.length === 0) return;
      out.push(title);
      cleanLines.forEach((l) => out.push(l));
      out.push("");
    }

    function extractKentuckyAlerts(body) {
      if (!body) return [];
      const matches = [...body.matchAll(/(?:^|\n)KY\.\.\.([\s\S]*?)(?=(?:\n[A-Z]{2}\.\.\.)|\n&&|\n\$\$|$)/gim)];
      const alerts = [];
      for (const m of matches) {
        const txt = (m[1] || "")
          .replace(/\r/g, "")
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
        if (!txt || /^none\.?$/i.test(txt)) continue;
        alerts.push(txt.replace(/\.\.+$/, "."));
      }
      return alerts;
    }

    function inferHighLine(period, periodSent, shortText, longText) {
      const direct = normalizeHighLine(extractTemp(periodSent), period);
      if (direct) return direct;

      const shortLower = (shortText || "").toLowerCase().replace(/-/g, " ");
      const longLower = (longText || "").toLowerCase().replace(/-/g, " ");
      const allLower = `${shortLower} ${longLower}`;

      if (period === "THURSDAY") {
        if (/\b60s\b/.test(shortLower) || /highs[^.]{0,180}60s/.test(shortLower)) return "Highs in the 60s";
      }
      if (period === "FRIDAY") {
        if (/upper\s+60s\s+to\s+mid\s+70s/.test(allLower)) return "Highs upper 60s to mid 70s";
        if (/friday[^.]{0,200}upper\s+60s\s+to\s+mid\s+70s/.test(longLower) || /highs[^.]{0,200}upper\s+60s\s+to\s+mid\s+70s/.test(longLower)) {
          return "Highs upper 60s to mid 70s";
        }
        if (/friday[^.]{0,200}\b70s\b/.test(allLower)) return "Highs in the 70s";
      }
      if (period === "SATURDAY") {
        if (/low\s+to\s+mid\s+70s/.test(allLower)) return "Highs in the low to mid 70s";
        if (/saturday[^.]{0,200}low\s+to\s+mid\s+70s/.test(longLower) || /highs[^.]{0,200}low\s+to\s+mid\s+70s/.test(longLower)) {
          return "Highs in the low to mid 70s";
        }
        if (/saturday[^.]{0,200}\b70s\b/.test(allLower)) return "Highs in the 70s";
      }

      return "";
    }

    // ── 3. Assemble the post ──────────────────────────────────────────────────
    const label = officeLabel || "Eastern Kentucky";
    const out = [];
    out.push(`🌤️ ${String(label).toUpperCase()} WEATHER UPDATE`);
    out.push("");

    // Active watches/warnings: include only Kentucky alerts when present.
    const wwaSection = sections.find(
      (s) => (s.name.includes("WATCHES") || s.name.includes("WARNINGS")) && s.name !== "_HDR"
    );
    const kyAlerts = wwaSection ? extractKentuckyAlerts(wwaSection.body) : [];
    if (kyAlerts.length > 0) {
      out.push("ACTIVE ALERTS");
      kyAlerts.forEach((l) => out.push(l));
      out.push("");
    }

    const shortSec = findSection("SHORT TERM");
    const longSec = findSection("LONG TERM");
    const discussionSec = findSection("DISCUSSION");
    const shortClean = shortSec ? removeJargon(cleanBody(shortSec.body)) : "";
    const longClean = longSec ? removeJargon(cleanBody(longSec.body)) : "";
    const discussionClean = discussionSec ? removeJargon(cleanBody(discussionSec.body)) : "";
    const forecastText = `${shortClean}\n\n${longClean}`.trim() || discussionClean;
    const allSentences = splitSentences(forecastText);
    const textLower = forecastText.toLowerCase().replace(/-/g, " ");
    const isCentral = /central kentucky/i.test(label);
    const isWestern = /western kentucky/i.test(label);

    const kmSec = findSection("KEY MESSAGE");
    const keyBullets = kmSec ? extractBullets(kmSec.body) : [];

    if (isCentral) {
      const takeaways = [];
      if (/\b70s\b/.test(textLower) && /\b80s\b/.test(textLower) && /(weekend|friday)/.test(textLower)) {
        takeaways.push("Temperatures warming into the 70s and even 80s by the weekend");
      }
      if (/(sprinkle|sprinkles|light precipitation|mostly dry|remain dry|stay dry)/.test(textLower)) {
        takeaways.push("Mostly dry through Friday with only a few spotty sprinkles");
      }
      if (/cold front/.test(textLower) && /(sunday night|monday)/.test(textLower)) {
        takeaways.push("Cold front arrives Sunday night into Monday");
      }
      if (/(cooler|drop|50s|60s|early next week)/.test(textLower)) {
        takeaways.push("Cooler air returns early next week");
      }

      const finalTakeaways =
        takeaways.length > 0
          ? [...new Set(takeaways)]
          : keyBullets
              .map((b) => b.replace(/\.\s*$/g, "").trim())
              .filter(Boolean)
              .slice(0, 4);

      if (finalTakeaways.length > 0) {
        out.push("KEY TAKEAWAYS");
        out.push("");
        if (finalTakeaways.length >= 4) {
          out.push(finalTakeaways[0]);
          out.push("");
          out.push(finalTakeaways[1]);
          out.push("");
          out.push(finalTakeaways[2]);
          out.push("");
          if (finalTakeaways[3]) out.push(finalTakeaways[3]);
        } else {
          finalTakeaways.forEach((t) => out.push(t));
        }
        out.push("");
      }

      const todayLines = [];
      if (/cloud/.test(textLower)) todayLines.push("Partly to mostly cloudy");
      if (/sprinkle|sprinkles/.test(textLower)) todayLines.push("A few sprinkles possible, but most stay dry");
      if (/mid\s+60s\s+to\s+low\s+70s/.test(textLower)) todayLines.push("Highs mid 60s to low 70s");
      addBlock(out, "TODAY (THURSDAY)", todayLines);

      const fridayLines = [];
      if (/friday/.test(textLower) && /\b70s\b/.test(textLower)) fridayLines.push("Warmer with highs in the 70s");
      if (/(light precipitation|rain showers?|chances? for (?:light )?precipitation|eastern counties|remaining to our east)/.test(textLower)) {
        fridayLines.push("Slight chance of light rain, mainly east");
      }
      addBlock(out, "FRIDAY", fridayLines);

      const weekendLines = [];
      if (/sunshine|high surface pressure|extra sunshine/.test(textLower)) weekendLines.push("Plenty of sunshine at times");
      if (/70s\s+to\s+mid\s+80s|mid\s+80s/.test(textLower)) weekendLines.push("Highs in the 70s to mid 80s");
      addBlock(out, "WEEKEND", weekendLines);

      const sunMonLines = [];
      if (/cold front/.test(textLower) && /(sunday night|monday)/.test(textLower)) sunMonLines.push("Cold front moves through");
      if (/rain|precipitation/.test(textLower)) {
        sunMonLines.push(/east|eastern/.test(textLower) ? "Chance for rain, mainly east" : "Chance for rain");
      }
      if (/cooler|drop|50s|60s/.test(textLower)) sunMonLines.push("Turning cooler");
      addBlock(out, "SUNDAY NIGHT – MONDAY", sunMonLines);

      const earlyWeekLines = [];
      if (/50s|60s/.test(textLower)) earlyWeekLines.push("Temperatures drop back into the 50s to 60s");
      if (/not too concerning|wind threat looks low|trend drier|bulk of precipitation remaining to our east/.test(textLower)) {
        earlyWeekLines.push("No major storm concerns right now");
      }
      addBlock(out, "EARLY NEXT WEEK", earlyWeekLines);

      out.push("BOTTOM LINE");
      out.push("A big warmup is on the way with spring-like temperatures this weekend, followed by a cooldown early next week.");

      return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    }

    if (isWestern) {
      const takeaways = [];
      if (/15 to 20 degrees above normal|20\+ degrees above normal|around 20 degrees above normal/.test(textLower)) {
        takeaways.push("Big warmup continues with temps 15–20° above normal");
      }
      if (/\b80s\b|lower to middle 80s|mid 80s/.test(textLower)) {
        takeaways.push("Highs reach the 80s by the weekend");
      }
      if (/cold front/.test(textLower) && /sunday night/.test(textLower)) {
        takeaways.push("Cold front arrives late Sunday night");
      }
      if (/(below normal monday|little below normal|warming trend will begin tuesday|another warming trend will begin tuesday|back to 5 to 10 degrees above normal by wednesday)/.test(textLower)) {
        takeaways.push("Cooler air returns Monday before warming again");
      }

      const finalTakeaways =
        takeaways.length > 0
          ? [...new Set(takeaways)]
          : keyBullets
              .map((b) => b.replace(/\.\s*$/g, "").trim())
              .filter(Boolean)
              .slice(0, 4);

      if (finalTakeaways.length > 0) {
        out.push("KEY TAKEAWAYS");
        out.push("");
        if (finalTakeaways.length >= 4) {
          out.push(finalTakeaways[0]);
          out.push("");
          out.push(finalTakeaways[1]);
          out.push("");
          out.push(finalTakeaways[2]);
          out.push("");
          if (finalTakeaways[3]) out.push(finalTakeaways[3]);
        } else {
          finalTakeaways.forEach((t) => out.push(t));
        }
        out.push("");
      }

      const todayLines = [];
      if (/sunshine|partly|clouds/.test(textLower)) todayLines.push("Partly sunny");
      if (/near seasonal values today|seasonal values today|near seasonal/.test(textLower)) todayLines.push("Seasonal temperatures");
      addBlock(out, "TODAY (THURSDAY)", todayLines);

      const fridayLines = [];
      if (/warming trend|south to southwest winds|temperatures around 20 degrees above normal by the weekend/.test(textLower)) {
        fridayLines.push("Warmer with increasing sunshine");
      }
      if (/above normal|15 to 20 degrees above normal|20\+ degrees above normal/.test(textLower)) {
        fridayLines.push("Above normal temperatures");
      }
      addBlock(out, "FRIDAY", fridayLines);

      const weekendLines = [];
      if (/quite a bit of sunshine each day through sunday|overall there will be quite a bit of sunshine/.test(textLower)) {
        weekendLines.push("Very warm with plenty of sun");
      }
      if (/\blower to middle 80s\b|mid 80s|70s/.test(textLower)) {
        weekendLines.push("Highs in the upper 70s to mid 80s");
      }
      addBlock(out, "WEEKEND", weekendLines);

      const sunNightLines = [];
      if (/cold front/.test(textLower) && /late sunday|sunday night/.test(textLower)) {
        sunNightLines.push("Cold front moves through");
      }
      if (/(sprinkles|light showers?|15\s*20% chances?|trace to a couple of hundredths)/.test(textLower)) {
        sunNightLines.push("Small chance of light showers (mainly north/east)");
      }
      const mondayLines = [];
      if (/20 to 25 degrees cooler than sunday|below normal monday|temperatures behind the front will be around 5 degrees below normal/.test(textLower)) {
        mondayLines.push("Much cooler");
        mondayLines.push("Temperatures drop back below normal");
      }
      if (sunNightLines.length > 0 || mondayLines.length > 0) {
        out.push("SUNDAY NIGHT");
        sunNightLines.forEach((l) => out.push(l));
        if (mondayLines.length > 0) {
          out.push("");
          out.push("MONDAY");
          mondayLines.forEach((l) => out.push(l));
        }
        out.push("");
      }

      const tueWedLines = [];
      if (/another warming trend will begin tuesday|warming trend will begin tuesday/.test(textLower)) {
        tueWedLines.push("Warming trend returns");
      }
      if (/back to 5 to 10 degrees above normal by wednesday|above normal by wednesday/.test(textLower)) {
        tueWedLines.push("Back above normal by midweek");
      }
      addBlock(out, "TUESDAY – WEDNESDAY", tueWedLines);

      out.push("BOTTOM LINE");
      out.push("A major warmup peaks this weekend with 80s returning, followed by a quick cooldown Monday before temperatures rebound again.");

      return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    }

    // Key messages (default template, including Eastern KY)
    if (kmSec) {
      const takeaways = buildTakeaways(keyBullets, shortClean, longClean);
      if (takeaways.length > 0) {
        out.push("KEY TAKEAWAYS");
        out.push("");
        if (takeaways.length === 4) {
          out.push(takeaways[0]);
          out.push("");
          out.push(takeaways[1]);
          out.push(takeaways[2]);
          out.push("");
          out.push(takeaways[3]);
        } else {
          takeaways.forEach((t) => out.push(t));
        }
        out.push("");
      }
    }

    // Day-by-day (default template)
    const thursdaySent = findSentences(allSentences, /\bthursday\b/i).join(" ");
    const fridaySent = findSentences(allSentences, /\bfriday\b/i).join(" ");
    const saturdaySent = findSentences(allSentences, /\bsaturday\b/i).join(" ");
    const sundaySent = findSentences(allSentences, /\bsunday\b/i).join(" ");
    const mondaySent = findSentences(allSentences, /\bmonday\b/i).join(" ");
    const sunMonSent = `${sundaySent} ${mondaySent} ${longClean}`.replace(/\s+/g, " ").trim();

    const thursdayLines = [];
    if (thursdaySent || /\bthursday\b/.test(textLower)) {
      thursdayLines.push("Partly sunny and warmer");
      const highLine = inferHighLine("THURSDAY", thursdaySent || shortClean, shortClean, longClean);
      if (highLine) thursdayLines.push(highLine);
    }
    addBlock(out, "THURSDAY", thursdayLines);

    const fridayLines = [];
    if (fridaySent || /\bfriday\b/.test(textLower)) {
      fridayLines.push(/gusty|windy/.test(fridaySent.toLowerCase()) ? "Windy and much warmer" : "Much warmer");
      const highLine = inferHighLine("FRIDAY", fridaySent || longClean, shortClean, longClean);
      if (highLine) fridayLines.push(highLine);
      if (/\bfriday\b/.test(textLower) && /(showers?|rain)/.test(textLower) && /(storm|thunder)/.test(textLower)) {
        fridayLines.push("Slight chance of showers/storms late");
      }
    }
    addBlock(out, "FRIDAY", fridayLines);

    const saturdayLines = [];
    if (saturdaySent || /\bsaturday\b/.test(textLower)) {
      saturdayLines.push(/dry|nil chances|mostly dry|weaker gradient/.test(saturdaySent.toLowerCase()) ? "Dry and warm" : "Warm");
      const highLine = inferHighLine("SATURDAY", saturdaySent || longClean, shortClean, longClean);
      if (highLine) saturdayLines.push(highLine);
    }
    addBlock(out, "SATURDAY", saturdayLines);

    const sundayLines = [];
    if (sundaySent || /\bsunday\b/.test(textLower)) {
      sundayLines.push(/very warm|15 to 20 degrees above normal|even higher highs/.test(textLower) ? "Very warm" : "Warm");
      if (/end the weekend|late weekend|sun evening|sunday night/.test(textLower) && /(showers?|storm|thunder)/.test(textLower)) {
        sundayLines.push("Storm chances return late");
      }
    }
    addBlock(out, "SUNDAY", sundayLines);

    const sunMonLines = [];
    if (/sunday|monday|late weekend/.test(textLower)) {
      if (/(showers?|storm|thunder)/.test(sunMonSent.toLowerCase())) {
        sunMonLines.push("Better chance for showers and storms");
      }
      if (/east of i-75/.test(sunMonSent.toLowerCase())) {
        sunMonLines.push("Greatest chances east of I-75");
      }
    }
    addBlock(out, "SUNDAY NIGHT – MONDAY", sunMonLines);

    let bottomLine = "";
    if (/\b70s?\b/.test(textLower) && /(showers?|rain|storms?|thunder)/.test(textLower)) {
      bottomLine = "Spring warmth is here, but multiple chances for rain and storms return this weekend.";
    } else {
      const longSents = splitSentences(longClean).filter((s) => s.length > 45);
      bottomLine = longSents[longSents.length - 1] || "";
    }
    if (bottomLine) {
      out.push("BOTTOM LINE");
      out.push(bottomLine.replace(/\.\.+$/, "."));
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
