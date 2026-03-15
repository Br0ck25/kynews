# AI Change Log

This file documents targeted changes made to AI summarization logic.
Use it to avoid re-introducing the same bugs or re-debating resolved decisions.

---

## 2026-03-15 — Six targeted fixes to `worker/src/lib/ai.ts`

---

### Change 1 — Lower short-article passthrough threshold (line ~301)

**File:** `worker/src/lib/ai.ts`

**What changed:**
```diff
- if (originalWords < 60) {
+ if (originalWords < 30) {
```

**Why:**
Articles between 30–60 words still benefit from going through the AI with the `brevityHint` active. The old 60-word cutoff caused these articles to be returned verbatim, bypassing the consistent editorial voice. Only truly micro-content (< 30 words) should skip the AI entirely.

---

### Change 2 — Fix "Summary" label strip in `cleanContentForSummarization` (line ~994)

**File:** `worker/src/lib/ai.ts`

**What changed:**
```diff
- t = t.replace(/^\s*Summary\s*$/gim, '');
+ t = t.replace(/^\s*Summary\s*\n?/gim, '');
```

**Why:**
The original pattern used `$` (end-of-line anchor) which only fires when "Summary" appears as a completely isolated line surrounded by blank lines on both sides. NKY Tribune and some other CMSes emit `Summary\n` immediately before the body text with no trailing blank line, so the pattern never matched. The `\n?` variant consumes the newline if present, making it fire in both cases.

---

### Change 3 — Fix "Summary" label strip in `stripBoilerplateFromOutput` (line ~1143)

**File:** `worker/src/lib/ai.ts`

**What changed:**
```diff
- t = t.replace(/^\s*Summary\s*$/gim, '');
+ t = t.replace(/^\s*Summary\s*\n?/gim, '');
```

**Why:**
Same root cause as Change 2, but in the output-cleaning function. The AI occasionally echoes the "Summary" label from the source into its output. The fix ensures it is stripped regardless of whether a newline immediately follows.

---

### Change 4 — Increase `targetMax` ratio for short, fact-dense articles (lines ~323–330)

**File:** `worker/src/lib/ai.ts`

**What changed:**
```diff
  const targetMax = Math.min(
-   originalWords < 200
-     ? Math.round(originalWords * 0.85)
-     : Math.round(originalWords * 0.80),
+   originalWords < 150
+     ? Math.round(originalWords * 0.95)
+     : originalWords < 200
+     ? Math.round(originalWords * 0.90)
+     : Math.round(originalWords * 0.80),
    600
  );
```

**Why:**
KYTC road project notices, government meeting announcements, and similar press-release content pack many facts (contractor name, cost, completion date, road number) into 60–150 words. The old 85% cap caused the AI to truncate these closing details. The new tiered approach preserves nearly all content for short articles where every sentence carries unique information.

---

### Change 5 — Add first-person voice rule to `BASE_SYSTEM_PROMPT` (line ~151)

**File:** `worker/src/lib/ai.ts`

**What changed:**
Added a new bullet to the "Your summary must never:" list, immediately after the existing "Start with 'According to'…" rule:

```
- Use first-person pronouns ("we", "our", "us") unless they appear inside a
  direct quote from a named speaker. Always rewrite institutional first-person
  voice in third person, attributing statements to the named organization.
  Example: write "The center's staff guided them" not "We guided them."
```

**Why:**
Government agencies, nonprofits, and community organizations frequently write press releases in first-person institutional voice ("We are proud to announce…", "Our team will…"). Without an explicit rule, the AI reproduced this voice verbatim, creating a jarring inconsistency against the third-person editorial style of the rest of the site. The rule now forces a rewrite to third person while protecting genuine speaker quotes.

---

### Change 6 — Update county fallback in `BASE_SYSTEM_PROMPT` (line ~107)

**File:** `worker/src/lib/ai.ts`

**What changed:**
```diff
- county is unknown, use "Eastern Kentucky residents". Write 1–2 sentences
+ county is unknown but city is known from the metadata, use "[City] residents";
+ if neither county nor city is known, use "Kentucky residents". Write 1–2 sentences
```

**Why:**
The old fallback hardcoded "Eastern Kentucky residents" for every article without county metadata. Articles from Louisville, Lexington, Bowling Green, and other non-Eastern Kentucky cities produced geographically inaccurate copy. The new two-tier fallback uses the city name when available and falls back to the neutral "Kentucky residents" only when neither piece of geographic metadata is present.

---

## Rules derived from these fixes

| Pattern | Rule |
|---|---|
| Regex using `$` to strip a label line | Use `\n?` instead of `$` if the label may appear without a trailing blank line |
| Short article word-count thresholds | Verify against real sources (KYTC, government notices) before setting cutoffs |
| AI echoing source voice | Always add a "must never" rule; do not rely on the AI to infer style by example |
| Geographic fallback text | Never hardcode a regional fallback when city metadata may be available |
