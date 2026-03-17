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

---

### Change 7 — Force city-based resident phrasing when metadata is present

**File:** `worker/src/lib/ai.ts`

**What changed:**
- After final summary construction we now post-process the text to replace
  "What this means for Eastern Kentucky residents:" or "What this means for
  Kentucky residents:" with "What this means for [City] residents:" when
  `meta.city` is available.

**Why:**
The AI occasionally ignored the prompt instruction and used the generic
"Eastern Kentucky" fallback even when the article metadata included a city.
This deterministic post-processing ensures the local phrasing is always used
when the city is known.

---

### Change 8 — Prevent world-wire articles from being tagged as Kentucky

**File:** `worker/src/lib/classify.ts`

**What changed:**
- The classifier now requires an explicit Kentucky signal in the text (e.g. "Kentucky", "Ky.", a KY county/city name) before treating an article as a Kentucky story.
- A source default county alone no longer forces `isKentucky=true` for an article.
- AI responses claiming `isKentucky: true` are ignored unless the article text contains an actual Kentucky signal (via `detectKentuckyGeo`). This prevents AI hallucinations from tagging non-KY wire stories as Kentucky.
- The always-national override now checks for Kentucky mentions in the article lead (first ~2,200 chars) rather than the entire scraped text, preventing footer/nav boilerplate from triggering a false KY classification.

**Why:**
Lex18 and other Kentucky outlets publish wire stories (AP, Reuters, etc.) that have no local Kentucky context. Previously, small site chrome or footer mentions of "Kentucky" could accidentally satisfy the KY signal check and cause an otherwise national article to be tagged Kentucky. This fix ensures only the lead/news body can trigger KY classification, preventing unrelated global stories from leaking into KY feeds.

---

### Change 9 — Ignore nav/menu “Kentucky” mentions when counting KY signals

**File:** `worker/src/lib/classify.ts`

**What changed:**
- The KY mention counter now filters out lines that look like navigation tags or related-topic items (e.g. "Kentucky", "Kentucky News", "KY Sports"). These boilerplate snippets are excluded from the KY mention count.

**Why:**
Articles from global outlets often include "Kentucky" as a site navigation item or related-topic tag. Those incidental mentions were inflating the KY mention count and causing unrelated stories to be tagged as Kentucky. This guard ensures only meaningful narrative text can trigger a KY classification.

---

## 2026-03-16 — Four fixes for false KY tagging, obituary ingestion, and list formatting

---

### Change 10 — Add four domains to `ALWAYS_NATIONAL_SOURCES`; move `pbs.org` from explicit-evidence set

**File:** `worker/src/lib/classify.ts`

**What changed:**
Added `wlky.com`, `aginguntold.com`, `popularmechanics.com`, and `pbs.org` to `ALWAYS_NATIONAL_SOURCES`.
Removed `pbs.org` from `COUNTY_REQUIRES_EXPLICIT_EVIDENCE` (now fully covered by always-national).

**Articles that triggered this fix:**
- *Prostate cancer survivor* (Charlotte, NC) from `aginguntold.com` — tagged Kentucky; no KY content.
- *2026 Academy Awards winners* from `pbs.org` — tagged Kentucky; AP wire, set in Los Angeles.
- *Behind the scenes at the Oscars* from `wlky.com` — tagged Kentucky; AP wire, set in Los Angeles. The dateline ("LOS ANGELES —") was not appearing in the scraped lead so `NATIONAL_WIRE_OVERRIDE_RE` did not fire.
- *Scientists discovered glass orbs from ancient asteroid impact* from `popularmechanics.com` — tagged Kentucky; story is set in Brazil with no KY content.

**Root cause:**
- `aginguntold.com` and `popularmechanics.com` were not in any classification list. When the scraped page included any sidebar/nav text containing "Kentucky" or "KY", the mention counter pushed the article over the Kentucky threshold.
- `wlky.com` had `null` default county but was not in `ALWAYS_NATIONAL_SOURCES`. AP wire articles on WLKY omit their original dateline in the scraped text, so the wire-override regex never triggered; site-chrome KY mentions classified the article as Kentucky.
- `pbs.org` was in `COUNTY_REQUIRES_EXPLICIT_EVIDENCE` (county only when explicit) but not `ALWAYS_NATIONAL_SOURCES`. PBS sidebar/related-article links containing "Kentucky" satisfied the 2-mention threshold and set `baseIsKentucky = true`, which survived the early-return `isNationalWireStory` path.

**Safety of always-national guard for pbs.org and wlky.com:**
The `ALWAYS_NATIONAL_SOURCES` block has a `strongTextEvidence` exception: an article is kept as Kentucky only when `mentionCount >= 2` in the lead text AND the AI also returns `isKentucky: true`. Genuine KY-focused PBS or WLKY stories (e.g. a PBS documentary about Appalachia) satisfy this bar and are not affected. Louisville news from WLKY is also covered by WDRB, Courier Journal, and Wave3.

---

### Change 11 — Reject obituary articles in `ingestSingleUrl`

**File:** `worker/src/lib/ingest.ts`

**What changed:**
Added an obituary detection block immediately after the betting-content rejection check. Five strong structural patterns that only appear in formal death notices are matched against the article title and first 1,500 characters of content:
- `preceded in death by`
- `funeral services will be / are scheduled / are set`
- `visitation will be / hours / are`
- `in lieu of flowers`
- `expressions of sympathy`

If any pattern matches, the article is rejected with `reason: 'obituary — not a news story'` and never reaches the summarization step.

**Article that triggered this fix:**
- *DePresto Gary, 79* from `k105.com` — a formal obituary with funeral details, incorrectly ingested as a news article.

**Why:**
Individual death notices are not news stories. They are not summarizable in the site's editorial voice, they do not serve local audiences the same way news articles do, and ingesting them fills feeds with content that is not editorially appropriate for the platform. The five-signal filter is strict enough to avoid false positives on news stories about deaths (e.g. "preceded in office by" would not match because it lacks "death").

---

### Change 12 — Improve obituary detection with additional phrasing patterns

---

### Change 13 — Reject real estate transfer listings

**File:** `worker/src/lib/ingest.ts`

**What changed:**
- Added a hard reject for articles whose title or body contains "Real Estate Transfers". These posts are typically public-record lists of property transactions and not editorial news stories.

**Why:**
Real estate transfer pages are bulk lists of deeds and amounts and provide no meaningful news value. They can generate noisy, useless articles when ingested automatically.

---

### Change 14 — Drop stray photo-credit lines before dateline to avoid them becoming the summary lead

**File:** `worker/src/lib/ingest.ts`

**What changed:**
Expanded the obituary signal set to include additional common phrases from formal death notices, such as:
- `passed away`
- `survived by` / `is survived by`
- `celebration of life`
- `memorial service`
- `has gone to be with God`

This makes the filter more robust against obits that do not mention funeral arrangements explicitly.

**Why:**
The previous filter relied on a narrow set of phrases and missed many typical obituaries (e.g. those that focus on life details, survivors, and a simple "passed away" line). The expanded signal set helps prevent future obituary posts from slipping through.

---

### Change 15 — Ignore political affiliation abbreviations (R-Ky/D-Ky) when counting Kentucky mentions

**File:** `worker/src/lib/classify.ts`

**What changed:**
- `countKentuckyMentions` now strips out political affiliation patterns like "R-Ky." and "D-Ky." before tallying Kentucky mentions.
- The new guard also handles normalized variants such as "R Ky" (punctuation removed) that can appear in downstream text processing.

**Why:**
National stories often quote or mention Kentucky lawmakers using party abbreviations (e.g. "Sen. Mitch McConnell, R-Ky."). These should not be treated as geographic Kentucky signals, because the story is not about Kentucky itself. Without this fix, such articles could be incorrectly classified as Kentucky local news.

---

### Change 16 — Treat WYMT/Gray News WV wire stories as national

**File:** `worker/src/lib/classify.ts`

**What changed:**
- Expanded the `NATIONAL_WIRE_OVERRIDE_RE` regex to match additional wire-style bylines, including `WDTV/Gray News`, and to recognize datelines like `WESTON, W.Va` (state abbreviations with dots) as out-of-state.

**Why:**
Stories from WYMT (Gray Television) that begin with `WESTON, W.Va (WDTV/Gray News) —` were being misclassified as Kentucky because the wire override pattern did not recognize that format as a national wire dateline. This change ensures such WV wire stories are treated as national regardless of the source domain.

---

### Change 17 — Stabilize slugs on retagging; only regenerate when title changes (2026-03-17 12:10 UTC)

**File:** `worker/src/lib/db.ts`

**What changed:**
- `generateSeoSlug()` now uses `getUTCFullYear()` so slug generation is consistent across timezones.
- `updateArticleContent()` still regenerates slugs when a title changes (keeping permalinks aligned with the headline).
- `updateArticleClassification()` and `updateArticlePrimaryCounty()` no longer touch the slug, preventing retags/retags from breaking existing links.

**Why:**
Permalinks must remain stable once published. Changing the slug when an article is retagged (e.g., national → Kentucky) caused previously shared links to break. Slugs now only change when the title itself changes.

---

### Change 18 — Treat WHAS11 weather advisories as Kentucky despite syndicated wire content (2026-03-17 12:22 UTC)

**File:** `worker/src/lib/classify.ts`

**What changed:**
- Removed `whas11.com` from `ALWAYS_NATIONAL_SOURCES` so local Louisville stories are not automatically forced into the national category.
- Added `whas11.com` to `SOURCE_DEFAULT_COUNTY` with a default of `Jefferson` so that Kentucky stories without explicit county mentions still get a reasonable county assignment.
- Added regression coverage to ensure WHAS11 stories with a KY dateline (e.g. Crestwood/Oldham County fire) stay classified as Kentucky and extract the correct county when present.

**Why:**
WHAS11 publishes both local Louisville/Kentucky weather advisories and syndicated national wire content. The previous “always national” override incorrectly prevented genuine Kentucky stories (e.g., the March 17, 2026 Bradshaw‑Duncan House fire in Crestwood and the related weather advisory) from being classified as local. This change lets text-based geo signals (like “LOUISVILLE, Ky.” and the list of affected counties) determine whether the story is Kentucky.

---

### Change 21 — Don’t default to Jefferson when the article explicitly lists other KY counties (2026-03-17 14:40 UTC)

**File:** `worker/src/lib/classify.ts`

**What changed:**
- Improved the `hasExplicitCountyMention` logic so that county list phrases like "Grayson, Meade and Hardin counties" count as explicit evidence even though only the final county includes the "counties" suffix.
- This prevents the classifier from falling back to the source default county (Jefferson for `wave3.com`) when the article is clearly about other Kentucky counties.

**Why:**
Some storm/alert stories use a shared suffix list ("X, Y and Z counties") which previously failed the explicit-county detection check. The classifier then treated the article as having no explicit county evidence and fell back to the source default (Jefferson), causing summaries and titles to incorrectly mention Jefferson County.

---

### Change 22 — Treat “LOUISVILLE, Ky.” datelines as strong KY signals (2026-03-17 15:10 UTC)

**File:** `worker/src/lib/classify.ts`

**What changed:**
- Fixed a bug where the Louisville-dateline detection regex contained an unexpected control character, causing `LOUISVILLE, Ky.` leads to be missed.
- Added a regression test so that articles starting with a Louisville dateline ("LOUISVILLE, Ky. —") are classified as Kentucky rather than national, even when the body text does not include a second KY mention.
- Ensured the classifier does *not* fall back to the source default county (Jefferson) when a clear KY dateline is present, preventing incorrect title suffixes.

**Why:**
Several crash/traffic/road-condition stories begin with a Louisville dateline and contain only a single explicit "Ky." mention. Previously the classifier required multiple KY signals and would incorrectly tag such stories as national, causing the UI to show the wrong section and summary styling.

---

### Change 23 — Prevent Georgia wire stories mentioning Piedmont Athens from being tagged Kentucky (2026-03-17 16:xx UTC)

**File:** `worker/src/lib/geo.ts`

**What changed:**
- Added a special-case guard so that “Piedmont Athens Regional” (a Georgia hospital) does not trigger a Kentucky “Athens” city match.
- Added a regression test ensuring a Gray News/ANF story datelined Atlanta remains classified as national even if the AI suggests Kentucky.

**Why:**
A wire story about a Georgia crash referenced “Piedmont Athens Regional,” which caused the geo detector to incorrectly identify "Athens" as Kentucky (Fayette County) and tag the article as Kentucky. This fix prevents that false local classification.

---

### Change 24 — Default blank categories to national when building URLs (2026-03-17)

**Files:** `worker/src/index.ts`, `src/customHooks/custom-hooks.js`

**What changed:**
- `buildArticlePath()` now treats an empty category as `national` when `isKentucky` is false, preventing invalid URLs like `/news//<slug>`.
- Updated the admin ingest/retag link builder and notification payloads to use `national` when `category` is missing.

**Why:**
When an article is retagged from Kentucky to national, the stored classification can sometimes have an empty category string. This previously resulted in broken links like `/news//cart-cell-therapy-offers-new-hope-lupus-patients-2026` that return an empty page. The fix ensures national articles always generate valid `/news/national/...` URLs.

---

### Change 13 — Allow list formatting for structured-list articles in `BASE_SYSTEM_PROMPT`

**File:** `worker/src/lib/ai.ts`

**What changed:**
Added a structured-list exception to Section 2 of the base system prompt:

```
EXCEPTION — structured lists: If the source article is itself a structured
list (for example, award winners by category, election results by race, or
ranked items), reproduce that list using the format "- Category: Winner"
(one item per line) instead of converting it to prose. Only apply this
exception when the source clearly enumerates discrete items under headings.
```

**Article that triggered this fix:**
- *Here's a full list of 2026 Academy Awards winners* from `pbs.org` — the summary collapsed all winners into prose ("best picture, best actor etc should have been a list"), losing the structured format that readers expect.

**Why:**
The base prompt's blanket "no bullet points or list formatting" rule was written for narrative news articles. Awards lists, ranked lists, and ballot-result articles are inherently tabular — converting them to prose loses the scannable structure that is their primary value. The exception is narrowly scoped to articles whose source is itself a structured list, preventing the rule from being applied to ordinary news stories.

---

## Rules derived from these fixes

| Pattern | Rule |
|---|---|
| Non-KY national source not in any classification list | Add to `ALWAYS_NATIONAL_SOURCES` proactively; sidebar leakage will eventually trigger false KY tags |
| Local TV station that syndicates heavy AP wire | Add to `ALWAYS_NATIONAL_SOURCES`; genuine local stories are usually duplicated by print outlets already in the system |
| Source in `COUNTY_REQUIRES_EXPLICIT_EVIDENCE` getting false KY tags | Escalate to `ALWAYS_NATIONAL_SOURCES`; the explicit-evidence guard only protects county assignment, not KY classification |
| AP dateline in `(CITY) —` format (parentheses around wire service) | `NATIONAL_WIRE_OVERRIDE_RE` handles this for listed cities; non-listed cities rely on the generic dateline pattern which requires a comma separator |
| Article with formal obituary structure | Reject in `ingestSingleUrl` using structural phrase matching before the summarization step |
| Source article is a structured list | Prompt must allow list formatting; prose conversion destroys the article's primary value |

---

## 2026-03-16 — Fix wrong county assigned to Fort Campbell article

---

### Change 13 — Add "fort campbell" to KY city→county mapping

**File:** `worker/src/data/ky-geo.ts`

**What changed:**
```diff
+ "fort campbell": "Christian",
  "fort campbell north": "Christian",
```

**Article that triggered this fix:**
- *Army seeks tips on $110,000 drone theft from engineer battalion* from `harlanenterprise.net` — tagged Kentucky (correct) but assigned to **Harlan County** (wrong). The story is set at Fort Campbell, Christian County, KY.

**Root cause:**
The `KY_CITY_TO_COUNTY` map contained `"fort campbell north"` (a census-designated place) but not `"fort campbell"` itself — the name used by the Army installation, the article dateline, and virtually all news coverage. When `detectCity` ran the dateline check (`/^\s*([A-Za-z][A-Za-z\s]+?),\s*ky\b/i`) it extracted `"fort campbell"` and looked it up in `KY_CITY_TO_COUNTY`. The lookup returned `undefined`, so the function fell through without returning a city or county. With no text-derived county and no county detected by the county-pattern scan, the classifier fell back to `harlanenterprise.net`'s source default county of **Harlan** — the newspaper's home, not the story's location.

**Why "Harlan" not "Christian":**
`SOURCE_DEFAULT_COUNTY` maps `harlanenterprise.net` → `"Harlan"`. This fallback is correct for the vast majority of that outlet's local content (Harlan County crime, schools, government). It only misfires when the newspaper publishes wire or state-desk stories set somewhere else in Kentucky. The source default was the last line of defence — it only fires when all text-derived geo detection fails.

**Why the Kentucky classification was correct:**
Unlike the WLKY/PBS national-wire cases, this article is genuinely set in Kentucky. Fort Campbell IS in KY (Christian County), the CID contact number is a Kentucky-area-code number, and the byline is "Fort Campbell, Ky." The `isKentucky: true` flag was correct. Only the county was wrong.

---

## Rules derived from these fixes

| Pattern | Rule |
|---|---|
| Military installation named "Fort X" | Add the plain "fort x" form to `KY_CITY_TO_COUNTY`; the census CDP variant ("fort x north/south") is insufficient for dateline matching |
| Source default county fires on a story from a different KY location | Root cause is always missing city/county in the geo data; fix the data, not the classification logic |
| Article with explicit `CITY, Ky.` dateline gets wrong county | Check `KY_CITY_TO_COUNTY` for the exact lowercase dateline form — the dateline parser uses that key verbatim |

---

### Change 14 — Drop stray photo-credit lines before dateline to avoid them becoming the summary lead

**File:** `worker/src/lib/ai.ts`

**What changed:**
- In `cleanContentForSummarization`, remove short caption-like lines (e.g. "Laurel County Correctional Center") when they appear immediately before the dateline or on the same line.
- In `stripBoilerplateFromOutput`, apply the same removal so the final summary does not start with photo credit fragments.

**Why:**
Some scraped pages put the photo credit or caption just before the dateline, causing the AI to treat it as the opening sentence. This fix prevents those stray credit lines from leaking into generated summaries.

---

### Change 15 — Prefer the article’s actual first sentence when the AI truncates it

**File:** `worker/src/lib/ai.ts`

**What changed:**
- After the AI produces a summary, if the first sentence of the summary is a substring of the article’s actual first sentence, we replace it with the full first sentence from the source.

**Why:**
Some AI outputs begin mid-sentence (e.g. "Side in Laurel County…" instead of "A 19-year-old was killed…"). This deterministic post-processing ensures the summary always opens with a complete, self-contained first sentence.

---

### Change 15 — Ignore nav/menu “Kentucky” lines when detecting KY relevance

**File:** `worker/src/lib/geo.ts`

**What changed:**
- When scanning for Kentucky signals, strip standalone nav/menu lines like "Kentucky", "KY", or "Kentucky News" before counting mentions.
- This prevents sidebar/navigation artifacts from convincing the classifier that an article is about Kentucky.

**Why:**
National stories (e.g. Yahoo Finance / Reuters) can contain a stray "Kentucky" link or tag in the scraped HTML. Those isolated nav items should not trigger Kentucky tagging, but previously they did because `detectKentuckyGeo` treated any appearance of "Kentucky" as a positive signal.

---

### Change 16 — Treat “Waterford” as a high-ambiguity city to prevent mis-tagging national stories as KY

**File:** `worker/src/lib/geo.ts`

**What changed:**
- Added `waterford` to `HIGH_AMBIGUITY_CITIES` so that the city name only triggers Kentucky classification when there is an explicit KY location signal nearby.

**Why:**
“Waterford” is a city name in both Connecticut (national story) and Kentucky (Spencer County). Without this, a CT business article about “Waterford” could be incorrectly tagged as Kentucky simply because the city name matched.

---

### Change 17 — Strip broadcaster branding (e.g. "- WTVQ") before summarization

**File:** `worker/src/lib/ingest.ts`

**What changed:**
- Normalized titles via `normalizeTitleForSource()` before sending them to the summarizer.
- This removes tags like "- WTVQ" / "- ABC 36" so summaries and stored titles don’t include original reporting credit.

**Why:**
Broadcast outlet suffixes were leaking into stored titles and causing summaries to begin with truncated or irrelevant fragments. Normalizing the title ensures the summary prompt gets clean, content-focused input.

---

## 2026-03-16 — Prevent non-KY datelines from triggering KY tagging

### Change 18 — Treat dateline state abbreviations (e.g. "N.C.") as out-of-state signals

**File:** `worker/src/lib/geo.ts`

**What changed:**
- Added logic to detect dateline-style state abbreviations like `, N.C.` (normalized to `n c`) and treat them as explicit out-of-state location markers. This prevents `detectKentuckyGeo()` from misclassifying articles whose lead is a non-KY dateline (e.g., `WASHINGTON, N.C.`).

**Why:**
Some national wire stories begin with a U.S. city dateline (e.g., `WASHINGTON, N.C.`). Because city names like “Washington” can also appear in Kentucky, the geo detector was incorrectly tagging such stories as KY. This guard ensures the dateline state code prevents that false positive.

---

### Change 19 — Reject articles with identical titles to existing posts

**File:** `worker/src/lib/ingest.ts` / `worker/src/lib/db.ts`

**What changed:**
- Added an exact title dedupe check (case-insensitive) before the similarity filter.
- If an existing article has the same title, the second ingestion is rejected as a duplicate.

**Why:**
Two separate feeds (or the same feed re-queued) can deliver the same story under the same headline. Title similarity alone can miss these when the previous story is older than the recent-title scan window. Rejecting exact-title matches ensures the same headline is not posted twice.

---

### Change 20 — Strengthen Kentucky detection to avoid false national tagging

**File:** `worker/src/lib/geo.ts` / `worker/src/lib/classify.ts`

**What changed:**
- County-pattern matching now treats possessive forms (`County's`, `County’ s`) as a valid county mention. This prevents Kentucky counties (e.g., "Hardin County's") from being ignored and causing a story to be misclassified as national.
- Added `Hardin` to `AMBIGUOUS_COUNTY_NAMES` so that "Hardin County" no longer triggers a KY match unless the article also provides an explicit KY signal (e.g. "Kentucky", local city/state name, etc.).
- Expanded the KY keyword filter to ignore short nav/tag lines containing "Kentucky" or "KY" so site chrome doesn't accidentally trigger Kentucky classification.
- Added a new filter to ignore nav/header lines containing "Kentucky" when they use separators like `|`, `>`, `»`, or `/`, preventing sites whose header includes "Kentucky | News" from making a story appear KY.
- Added a multi-state guard: if the text mentions more than one U.S. state (including Kentucky) but contains **no explicit Kentucky city/county**, the story is treated as national. This prevents storm/region stories (e.g., "Kentucky and southern Indiana") from being tagged as KY.

**Why:**
Some Kentucky stories refer to local government entities in possessive form (e.g., "Hardin County's sheriff") and were previously missed by the county detection regex, causing valid Kentucky stories to be treated as national. Additionally, stories that mention multiple states but lack a local KY location (e.g., storm coverage spanning KY + other states) were being mis-tagged as Kentucky because the text contained the word "Kentucky". These improvements prevent both false negatives (missing KY stories) and false positives (tagging national stories as KY).

---

### Change 24 — Fix N.C. datelines being treated as Kentucky (2026-03-17)

**File:** `worker/src/lib/classify.ts`

**What changed:**
- Expanded the `NON_KY_DATELINE_RE` regex to recognize state abbreviations with internal periods (e.g. `N.C.`, `N.Y.`) as explicit out-of-state datelines.
- Added a regression test ensuring a wire-style lead like "CHAPEL HILL, N.C. (InvestigateTV) —" results in a national classification even if stray "Kentucky" mentions appear later.

**Why:**
Some national wire stories begin with datelines like "CHAPEL HILL, N.C.". The previous dateline regex failed to match the dotted state abbreviation, allowing Kentucky signal heuristics (e.g., sidebar/menu text mentioning "Kentucky") to incorrectly classify the story as Kentucky. The fix ensures the dateline override works reliably across common abbreviation formats.
