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

---

### Change 12 — Assign counties when a KY dateline city is present (even without "County" text)

**Files:** `worker/src/lib/geo.ts`, `worker/src/lib/classify.ts`

**What changed:**
- `detectCity()` now treats a known Kentucky city followed by an em-dash/ndash (`—`, `–`, `-`) near the top of the article as a valid dateline signal.
- The classifier now treats a detected KY city (unless it is a known ambiguous city like Louisville/Lexington) as strong enough evidence to assign the corresponding county, even if the text does not explicitly include the phrase "X County".

**Why:**
Local stories frequently use datelines like "LEXINGTON —" or "GLASGOW, Ky. —" without explicitly repeating the county name. The previous logic required an explicit "County" mention before assigning a county, causing many valid local stories to be tagged only as "Kentucky" with no county.

---

### Change 13 — Guard D1 inserts against undefined bind values

**File:** `worker/src/lib/db.ts`

**What changed:**
- `insertArticle()` now converts any `undefined` bind values to `null` before sending them to Cloudflare D1.

**Why:**
D1 rejects undefined values but many tests (and some edge-case insert paths) may omit optional fields. This makes the insert path more robust and prevents sporadic test failures.

---

### Change 14 — Add regression tests for county tagging on common KY datelines

**File:** `worker/test/index.spec.ts`

**What changed:**
- Added regression tests ensuring stories datelined in KY (e.g., "LEXINGTON —", "GLASGOW, Ky. —") are tagged with the correct county.



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

---

## 2026-03-17 — Two fixes: national city datelines without state suffix; opinion column rejection

---

### Change 25 — Extend `NON_KY_DATELINE_RE` to match known non-KY cities without state abbreviation (2026-03-17)

**File:** `worker/src/lib/classify.ts`

**What changed:**
Added a third alternative to `NON_KY_DATELINE_RE` that matches a set of well-known major non-KY US cities (e.g. `LOS ANGELES —`, `CHICAGO —`) appearing at the start of a line or after a sentence-ending period, with or without a state suffix.

**Article that triggered this fix:**
- *Carnival Cruise Line cancels nearly a dozen sailings due to 'changes to itinerary plans'* from `whas11.com` — tagged Kentucky despite a clear "LOS ANGELES —" dateline and no Kentucky content.

**Root cause:**
`NATIONAL_WIRE_OVERRIDE_RE` correctly detected "LOS ANGELES —" as a national wire story, setting `isNationalWireStory = true`. However, the override block that forces `isKentucky = false` is gated on `hasOnlyPoliticianKyMention || hasNonKyDateline`. The existing `NON_KY_DATELINE_RE` requires either "WASHINGTON" specifically, or a "CITY, STATE —" form (with a comma and state abbreviation). "LOS ANGELES —" has no state suffix, so `hasNonKyDateline = false`. With `isNationalWireStory = true` but neither condition met, the code returned early (skipping the AI) with `isKentucky = true` still set from WHAS11's site-chrome Louisville/KY navigation text.

Change 18 (2026-03-17) removed `whas11.com` from `ALWAYS_NATIONAL_SOURCES` to allow genuine Louisville stories to be tagged Kentucky. That was correct, but it exposed this gap: WHAS11 AP wire stories with a non-KY city dateline that lacks a state suffix now rely entirely on `NON_KY_DATELINE_RE` to override the site-chrome KY signal. The third alternative closes this gap.

**Cities added to `NON_KY_DATELINE_RE`:**
los angeles, new york, chicago, miami, houston, dallas, atlanta, boston, denver, phoenix, seattle, nashville, charlotte, memphis, jacksonville, san francisco, san diego, austin, baltimore, san antonio, las vegas, indianapolis, detroit, oklahoma city, raleigh, fort worth, baton rouge, new orleans, albuquerque, tucson, minneapolis, pittsburgh, virginia beach, colorado springs, el paso, omaha.

Note: `richmond` is intentionally excluded because Richmond, KY is a Kentucky city.

---

### Change 26 — Reject personal opinion columns at ingestion (2026-03-17)

**File:** `worker/src/lib/ingest.ts`

**What changed:**
Added a rejection filter that checks the article title and the first 1,500 characters of content for the `/Columnist` byline pattern (case-insensitive). When matched, the article is rejected with `reason: 'opinion column — not a news story'`, identical in structure to the obituary and real estate transfer rejections.

**Article that triggered this fix:**
- *Finding Sanctuary: One Woman's Spiritual Retreat* by Rhonda Gould/Columnist from `harlanenterprise.net` — tagged Kentucky despite containing zero Kentucky geographic content.

**Root cause:**
The article is a personal spiritual reflection column with no news value and no mention of any Kentucky location in the article text. It was tagged Kentucky because:
1. The scraped harlanenterprise.net page includes "Harlan County, Kentucky" in the newspaper's header/branding, which satisfies `detectKentuckyGeo`.
2. The source default county for `harlanenterprise.net` is `Harlan`, which was accepted as county evidence because "Harlan" appears in the scraped page header.
This is the same site-chrome leakage pattern as the WHAS11/PBS cases, but no classification fix is appropriate here — the source IS a Kentucky newspaper and the site chrome correctly reflects that. The fix instead belongs at ingestion: personal columns from community newspaper columnists are not news stories and should not be ingested.

The `/Columnist` byline format (e.g. "By Rhonda Gould/Columnist") is consistently used by community newspapers across Kentucky to distinguish their regular opinion columnists from staff reporters. It is a strong, narrow signal for non-news editorial content.

---

### Investigation note — Healthcare/Cancer article from lanereport.com was correctly tagged (2026-03-17)

**Article:** *Healthcare: Are We Closer to Curing Cancer?* from `lanereport.com`

**Finding:**
This article was **correctly tagged as Kentucky** and required no fix. The article:
- Quotes three named Kentucky physicians at specific Kentucky institutions (UofL Health—Brown Cancer Center, Baptist Health Lexington, St. Elizabeth Healthcare in Northern Kentucky, Norton Cancer Institute in Louisville)
- Cites Kentucky-specific statistics: "Kentucky still has a cancer mortality rate of 182 deaths per 100,000 people — higher than the national average" and "Kentucky is the only state seeing an increase in cervical cancer rates"
- Is published by the Lane Report, a Kentucky business/policy publication

Any investigation finding `isKentucky: true` and category `today` for this article is correct behavior. Do not add this domain to non-KY overrides.

---

## Rules derived from these fixes

| Pattern | Rule |
|---|---|
| National wire station (e.g. WHAS11) removed from `ALWAYS_NATIONAL_SOURCES` | Add all major non-KY US cities to `NON_KY_DATELINE_RE` city list; otherwise AP wire stories without a state suffix in the dateline can slip through with `isKentucky = true` from site chrome |
| Wire story `isNationalWireStory = true` but `hasNonKyDateline = false` | Root cause is that `NON_KY_DATELINE_RE` requires a comma+state suffix that some datelines omit; fix the regex, not the station's classification list |
| Opinion column from community newspaper tagged Kentucky | Source-default county and header branding will always make these look KY; fix is a byline-pattern rejection at ingestion, not a classifier change |
| `/Columnist` byline format | Treat as hard reject in `ingestSingleUrl`; do not attempt to classify or summarize |
| Article from Kentucky publication mentions only Kentucky entities and Kentucky-specific statistics | This is a genuine Kentucky story; do not add the source to non-KY overrides |

---

## 2026-03-17 — Three fixes: WLKY false national, S.C. dateline miss, summary spacing

---

### Change 27 — Remove `wlky.com` from `ALWAYS_NATIONAL_SOURCES`; set Jefferson as default county (2026-03-17)

**File:** `worker/src/lib/classify.ts`

**What changed:**
- Commented out `'wlky.com'` in `ALWAYS_NATIONAL_SOURCES`. WLKY articles now go through the standard text-based geo classification pipeline.
- Updated `SOURCE_DEFAULT_COUNTY['wlky.com']` from `null` to `'Jefferson'` so that genuine Louisville/Jefferson County stories without explicit county mention still get a county assignment.

**Article that triggered this fix:**
- *Kentucky lawmakers vote to override governor's veto of school tax credit bill* from `wlky.com` — tagged **national** despite a clear `FRANKFORT, Ky. —` dateline and multiple Kentucky legislative signals (House Bill 1, KY Legislature, Gov. Andy Beshear).

**Root cause:**
`wlky.com` was added to `ALWAYS_NATIONAL_SOURCES` in Change 10 to prevent AP wire stories (e.g. Academy Awards from Los Angeles) from leaking Kentucky tags via site-chrome KY navigation text. However, that hard override blocks ALL WLKY articles from being classified as Kentucky, including genuine local stories. Change 25 (same session) already solved the original problem by adding major non-KY US cities (including `los angeles`) to `NON_KY_DATELINE_RE` pattern 3, so AP wire datelines without a state suffix are now caught. The `ALWAYS_NATIONAL_SOURCES` guard for WLKY is therefore no longer needed and causes false negatives for WLKY's substantial local Kentucky reporting.

This mirrors exactly what Change 18 did for `whas11.com`.

---

### Change 28 — Fix `NON_KY_DATELINE_RE` pattern 2 for single-letter state abbreviations (2026-03-17)

**File:** `worker/src/lib/classify.ts`

**What changed:**
Changed `[a-z]{2,}` to `[a-z]+` in pattern 2 of `NON_KY_DATELINE_RE`. This allows the pattern to match single-letter state abbreviations like "S.C.", "N.C.", "S.D." where the state token before the first period is just one character.

**Article that triggered this fix:**
- *Mom charged with DUI after running stop sign, causing crash that killed 8-year-old daughter* from a Kentucky Gray Television outlet (WYMT or similar) — tagged **Kentucky** despite `SPARTANBURG COUNTY, S.C. (WHNS/Gray News) —` dateline and no Kentucky content.

**Root cause:**
`NATIONAL_WIRE_OVERRIDE_RE` correctly detected `(WHNS/Gray News)` and set `isNationalWireStory = true`. However, the block that forces `isKentucky = false`:
```
if (isNationalWireStory && (hasOnlyPoliticianKyMention || hasNonKyDateline))
```
requires `hasNonKyDateline = true`. Pattern 2 of `NON_KY_DATELINE_RE` requires the state token to match `[a-z]{2,}` (minimum 2 chars). "SPARTANBURG COUNTY, S.C." — the state abbreviation starts with a single "S" before the first period, which fails `{2,}`. So `hasNonKyDateline = false`, the override block did not fire, and `isKentucky = true` from the KYOW outlet's site-chrome navigation survived into the stored article.

Change 24 (previous session) was intended to fix N.C. datelines but used the same `[a-z]{2,}` pattern, so it only fixed dotted abbreviations where the first component is 2+ chars (e.g. "Okla." → "Okla" = 4 chars ✓, but "N.C." → "N" = 1 char ✗).

**Safety:** `[a-z]+` still requires at least one letter and the negative lookahead `(?!ky\b|kentucky\b)` prevents `KY` or `Kentucky` from triggering a false national override.

---

### Change 29 — Fix missing spaces between sentences in AI summaries (2026-03-17)

**File:** `worker/src/lib/ai.ts`

**What changed:**
Added a `.replace(/(?<=[a-z0-9][.!?])([A-Z])/g, ' $1')` step inside the `.map()` in `normalizeParagraphBoundaries`. This inserts a space between a sentence-ending character and the next sentence when they run together without whitespace.

**Article that triggered this fix:**
- *Kentucky lawmakers vote to override governor's veto of school tax credit bill* from `wlky.com` — the AI summary displayed as "House Bill 1.The education bill..." and "organizations.Gov. Andy Beshear vetoed it last week." with no spaces between sentences.

**Root cause:**
WLKY (and certain other broadcast CMS sites) publishes articles where each sentence is its own `<p>` tag. Readability extracts these as separate paragraphs separated by `\n\n`. When the AI model summarizes this style of content, it sometimes produces a dense output with sentences concatenated without spaces between them (e.g. `1.The education bill` instead of `1. The education bill`). `normalizeParagraphBoundaries` splits on `\n{2,}` to find paragraph breaks, but if the AI output lacks newlines between sentences, the missing space is never inserted.

**Why the lookbehind `(?<=[a-z0-9])` is safe:**
Only fires when the character BEFORE the period is lowercase (letter or digit). This prevents the regex from inserting spaces inside single-letter abbreviations like "U.S.Army" → the "S" before the period is uppercase, so it does NOT match. Titles/abbreviations like "Gov.", "Rep.", "Dr.", "St." are correctly matched because their final letter is lowercase (`v`, `p`, `r`, `t`) and they ARE followed by a name that needs a space.

---

## Rules derived from these fixes

| Pattern | Rule |
|---|---|
| Local TV station removed from `ALWAYS_NATIONAL_SOURCES` for genuine KY content | Remove the station from `ALWAYS_NATIONAL_SOURCES` and set the correct county in `SOURCE_DEFAULT_COUNTY`; rely on `NON_KY_DATELINE_RE` pattern 3 (city list) to catch AP wire content |
| Gray News/WHNS/wire story tagged Kentucky from a KY outlet | Check `NON_KY_DATELINE_RE` pattern 2 — dotted state abbreviations with single-char first component (S.C., N.C.) need `[a-z]+` not `[a-z]{2,}` |
| AI summary has sentences running together without spaces | Root cause is AI model joining one-sentence-per-paragraph articles; fix is in `normalizeParagraphBoundaries` with lookbehind-guarded space insertion after `[a-z0-9][.!?]` |
| Lookbehind in Cloudflare Workers V8 | ES2018 lookbehind assertions (`(?<=...)`) are supported in V8/Workers — safe to use |

---

## 2026-03-17 — Four cleaning fixes: CMS byline/credit blocks, timestamp+byline lines, "Share This Story", pre-dateline teaser

---

### Change 30 — Strip Hearst TV CMS image credit blocks (Credit/description/Author) (2026-03-17)

**File:** `worker/src/lib/ai.ts`

**What changed:**
- Added a multi-line strip in `cleanContentForSummarization` (before the existing caption strip) that removes Hearst TV CMS image credit blocks in the form `Credit: attribution\n[optional description line]\nAuthor: Name`.
- Added standalone `Credit:` and `Author:` strips as fallbacks for cases where the block is not intact.
- Added the same Credit/Author strips to `stripBoilerplateFromOutput` so the AI cannot echo these lines into the summary.

**Articles that triggered this fix:**
- *Kentucky's film incentive bill passes Senate* from `whas11.com` — summary began with "The House of Representatives will hear the bill next." followed by "LOUISVILLE, Ky. —", because the WHAS11 article had a credit block (`Credit: nisara - stock.adobe.com\nDirector chair and Clapper board...\nAuthor: Margaret Vancampen`) sitting between the teaser and the dateline. The AI received the teaser sentence as the first thing it saw and reproduced it as the opening of the summary.

**Root cause:**
Hearst TV (WHAS11, WLKY, WLWT) CMS emits three lines above the article body when an image is attached:
1. `Credit: photographer/agency` — the photo credit
2. `[image description]` — alt text or stock photo description (e.g. "Director chair and Clapper board...")
3. `Author: Reporter Name` — article byline

`cleanContentForSummarization` had no patterns for `Credit:` or `Author:` lines. The `By Name` strip requires a "By " prefix which these lack. The credit+description+author block was therefore passed intact to the AI.

---

### Change 31 — Strip relative-timestamp+byline lines (e.g. "1 hour ago  WNKY Staff") (2026-03-17)

**File:** `worker/src/lib/ai.ts`

**What changed:**
Changed the timestamp strip regex from:
```
/^\d+ (?:second|minute|hour|day|week|month)s? ago\s*$/gim
```
to:
```
/^\d+\s+(?:second|minute|hour|day|week|month)s?\s+ago\b[^\n]*/gim
```
The old pattern required end-of-line (`$`) so it only stripped standalone timestamp lines. The new pattern strips the entire line content after the timestamp keyword (`\b[^\n]*`), including any byline text that follows on the same line.

**Article that triggered this fix:**
- *Collision reconstruction to impact traffic on Glasgow Road* from `wnky.com` — summary began with "WNKY Staff, WARREN COUNTY, Ky. –". The scraped content had "1 hour ago  WNKY Staff" as a single line (WNKY's CMS concatenates the timestamp and staff byline). The old strip missed it because "WNKY Staff" follows "ago" on the same line.

---

### Change 32 — Add "Share This Story" to social media strip (2026-03-17)

**File:** `worker/src/lib/ai.ts`

**What changed:**
Added `Share\s+This\s+Story` to the social media boilerplate strip pattern in `cleanContentForSummarization`, so the 3-word variant is stripped in addition to the standalone "Share" word. The pattern now reads: `(?:...|Share\s+This\s+Story|Share|...)`.

**Why:**
WNKY and certain other broadcast CMS sites emit "Share This Story" as a CTA above the article body. The old pattern only matched the single word "Share", not the phrase form, so "Share This Story" survived into the cleaned content.

---

### Change 33 — Add late-pass teaser/callout strip after blank-line collapse (2026-03-17)

**File:** `worker/src/lib/ai.ts`

**What changed:**
Added a new regex pass at the end of `cleanContentForSummarization` (immediately after the `\n{3,} → \n\n` collapse) that strips any 10–160 character line that is separated from the first KY dateline by exactly one blank line (`\n\n`). This runs after all boilerplate (Published, Updated, Facebook, Credit, Author, etc.) has been stripped, so the teaser is now adjacent to the dateline with only a blank line between.

**Why:**
The existing "caption-before-dateline" strip (at the top of the function) requires the line to be IMMEDIATELY followed by the dateline (`\n` with no blank). For Hearst TV articles, the teaser sentence ("The House of Representatives will hear the bill next.") was separated from the dateline by a credit block + Author + Published + Updated + Facebook — none of which were stripped at the time the early caption pass ran. After Change 30 handles Credit/Author/description, and the late boilerplate passes handle Published/Updated/Facebook, the teaser is now separated from the dateline by only blank lines, and `\n{3,} → \n\n` leaves exactly `\n\n`. The late pass then catches it cleanly.

---

## Rules derived from these fixes

| Pattern | Rule |
|---|---|
| Hearst TV (WHAS11/WLKY/WLWT) article starts with wrong sentence | Check for un-stripped `Credit:` / `Author:` block above the dateline; add multi-line strip before caption pass |
| Broadcast CMS timestamp+byline on same line ("N ago  OUTLET Staff") | Timestamp strip must use `\b[^\n]*` not `\s*$`, otherwise trailing byline survives |
| CMS "Share This Story" leaking into AI prompt | Social media strip must include phrase variants, not just single-word forms |
| Teaser sentence before dateline not stripped by early caption pass | Check if boilerplate (Credit/Author/Published/Updated/Facebook) is sitting between teaser and dateline at the time the early pass runs; if so, add a late pass after all boilerplate is stripped and blank lines are collapsed |
| Order matters in `cleanContentForSummarization` | Credit/Author must be stripped BEFORE the early caption pass; the late-pass teaser strip must run AFTER `\n{3,} → \n\n` |

---

## 2026-03-17 — Facebook caption format overhaul

---

### Change 34 — Richer caption structure: ALL CAPS headline, prose+bullet layout, "Read more:" URL (2026-03-17)

**File:** `worker/src/lib/facebook.ts` — `generateFacebookCaption`

**What changed:**
- Headline is now uppercased via `.toUpperCase()` after branding-strip cleaning.
- "In County," location prefix removed — the dateline already provides location and the county is in the hashtags.
- Summary fallback improved: if every sentence in `article.summary` has fewer than 5 words, the function falls back to `article.contentText` before extracting usable sentences.
- Content layout now uses up to 6 sentences in three blocks:
  - **Prose block**: sentences 1–2, truncated to 50 words each.
  - **Bullet block**: sentences 3–5 formatted as `• sentence`, each truncated to 40 words; only appear when there are ≥ 4 usable sentences.
  - **Closing**: sentence 6 (if present), truncated to 40 words.
- URL is now prefixed with `"Read more: "`.
- Obituaries return `''` immediately (no post, no hashtags).

**Why:**
The old 3-linear-sentence format gave weak context and the "In County," prefix was sometimes misleading when the article's dateline was a city rather than a county. The new layout mirrors high-reach local news post patterns: clear ALL CAPS headline for scroll-stopping impact, two opening paragraphs to set the scene, then bullet points summarising the key facts for readers who scan.

---

### Change 35 — Hashtag format: #WarrenCountyKY, #KentuckyNews, #KentuckyEducation; suppress for obituaries (2026-03-17)

**File:** `worker/src/lib/facebook.ts` — `generateFacebookHashtags`

**What changed:**
- County tag changed from `#Warren` to `#WarrenCountyKY` (`county + "CountyKY"`).  The full-form tag is more searchable and unambiguous.
- `#Kentucky` changed to `#KentuckyNews` — the bare state name has lower signal-to-noise on Facebook; the news variant has more relevant followers.
- `#KYEducation` changed to `#KentuckyEducation` — consistent with the fuller format used by other tags.
- Obituaries category returns `''` — obituary posts are personal and should not carry hashtags.

---

### Change 36 — Fix `generateFacebookHook` min-length guard (2026-03-17)

**File:** `worker/src/lib/facebook.ts` — `generateFacebookHook`

**What changed:**
Guard changed from `wordCount < 3 || hook.length < 20` to `wordCount < 2 || hook.length < 5`.

**Why:**
The old threshold rejected 2-word sentences like "First sentence." (2 words, 15 chars) which are perfectly valid hooks. The guard's intent is to suppress single-word stubs like "Gov." (1 word) and "Hi" (1 word / 2 chars). The new thresholds correctly achieve that: ≥ 2 words AND ≥ 5 characters are required.

---

## Rules derived from these fixes

| Pattern | Rule |
|---|---|
| Facebook posts look weak with only 1–3 sentences | Use prose + bullet layout: 2 prose paragraphs, up to 3 bullets, 1 closing — gives more information without overwhelming |
| County hashtag unclear (`#Warren` could be many states) | Always use `#CountyNameCountyKY` format for unambiguous state-scoped discoverability |
| `generateFacebookHook` drops legitimate 2-word sentences | Hook guard must use `< 2 words` not `< 3 words`; length guard must use tiny (< 5 chars) to catch only true stubs |
| Obituaries should not be posted to Facebook | Return `''` from `generateFacebookCaption` and `generateFacebookHashtags` when `category === 'obituaries'` |

---

## 2026-03-18 — Two fixes: NKY Tribune Cincinnati false KY tag; Owensboro Times missing county

---

### Change 37 — Add `REQUIRES_EXPLICIT_KY_GEO` guard for Cincinnati/NKY border sources (2026-03-18)

**File:** `worker/src/lib/classify.ts`

**What changed:**
- Added a new `REQUIRES_EXPLICIT_KY_GEO` set containing `nkytribune.com` and `linknky.com`.
- For these sources, `baseIsKentucky` now additionally requires either:
  - (a) an explicit KY city or county detected in the article text (`detectedKyGeo.county || detectedKyGeo.city`), OR
  - (b) "Northern Kentucky" spelled out verbatim in the first 3,000 characters of the article body.
- Without this guard, the bare "Kentucky" keyword from site-chrome (e.g. "Northern Kentucky Tribune" appearing in a footer copyright line) was sufficient to set `baseIsKentucky = true` even when the article had zero Kentucky geographic content.

**Article that triggered this fix:**
- *Midwest Living's Best of the Midwest names Cincinnati one of Best Cities in Midwest* from `nkytribune.com` — tagged Kentucky despite being entirely about Cincinnati, Ohio. No KY city, county, or "Northern Kentucky" phrase appeared in the article body; only the "Northern Kentucky Tribune" brand name in the footer provided the keyword.

**Root cause:**
`nkytribune.com` is the Northern Kentucky Tribune. Its scraped page content includes "Northern Kentucky Tribune" in footer copyright lines (e.g. "Copyright 2026 Northern Kentucky Tribune") which are > 4 words and therefore NOT filtered by the `countKentuckyMentions` nav guard. These lines push the KY mention count to ≥ 2, causing `classifyArticle` to return `category: 'kentucky'`. Even when `classifyArticle` correctly returns `'national'` (e.g. if the multi-state guard fires on "Ohio" from "Ohio River"), `detectKentuckyGeo(semanticText)` still returns `isKentucky: true` from the same chrome text. Since `baseIsKentucky` combines `relevance.category === 'kentucky'` **OR** `detectedKyGeo.isKentucky`, either path alone is sufficient to mark the article Kentucky — even when the article body is entirely about an Ohio city.

**Why this fix is safe for genuine NKY Tribune Kentucky articles:**
- Articles about crimes, schools, or events in KY cities (Covington, Florence, Newport, etc.) will have a KY city detected by `detectCity` → `detectedKyGeo.city` is non-null → condition (a) passes → `baseIsKentucky = true` ✓
- Articles about "Northern Kentucky" as a region (e.g. "Northern Kentucky businesses growing") contain "Northern Kentucky" in the body text → condition (b) passes → `baseIsKentucky = true` ✓
- The Cincinnati award article has neither: no KY city/county detected, no "Northern Kentucky" in body → `baseIsKentucky = false` → correctly national ✓

**Implementation:**
```typescript
const requiresExplicitKyGeo = REQUIRES_EXPLICIT_KY_GEO.has(hostname);
const hasExplicitKyGeoOrNKY =
  !!(detectedKyGeo.county || detectedKyGeo.city) ||
  /\bnorthern\s+kentucky\b/i.test(cleanContent.slice(0, 3000));

const baseIsKentucky =
  (relevance.category === 'kentucky' || hasKhsaa || detectedKyGeo.isKentucky) &&
  !isAlwaysNational &&
  (!requiresExplicitKyGeo || hasExplicitKyGeoOrNKY);
```

---

### Change 38 — Add `owensborotimes.com` to `SOURCE_DEFAULT_COUNTY` (2026-03-18)

**File:** `worker/src/lib/classify.ts`

**What changed:**
```diff
  // Western Kentucky
  'paducahsun.com': 'McCracken',
  'murrayledger.com': 'Calloway',
  'mayfield-messenger.com': 'Graves',
+ 'owensborotimes.com': 'Daviess',  // Owensboro Times — Daviess County hyperlocal
```

**Article that triggered this fix:**
- *OPD: 17-year-old charged with murder in Orchard Street shooting* from `owensborotimes.com` — tagged Kentucky but assigned no county. owensborotimes.com exclusively covers Owensboro (Daviess County) and should always receive a county tag.

**Root cause:**
`owensborotimes.com` was absent from `SOURCE_DEFAULT_COUNTY`. The article's geo detection path produced `county = null` in scenarios where:
1. The scraped page lacked a "Kentucky"/"KY" context signal → Warren County (from "Warren County Juvenile Detention Center") was not detected because `AMBIGUOUS_COUNTY_NAMES` requires `hasKentuckyContext = true` for ambiguous county names.
2. Without an explicit county match, `hasExplicitCountyMention = false` → `effectiveGeoCounty = null`.
3. `detectCity` found "owensboro" (non-HIGH_AMBIGUITY) → source-default fallback path was skipped (source default only applies when no city is found or city is ambiguous).
4. If the AI then failed or returned `isKentucky: false`, `return fallback` produced `{county: null}`.

Adding `'Daviess'` as the source default provides a fallback in the `mergedCounty` path via `aiGeo.county` and the source-default-when-no-had-geo path:
```
mergedCounty = fallback.county ?? aiCounty ?? aiGeo.county ??
               (mergedIsKentucky && !hadGeo ? allowedSourceDefaultCounty : null)
```

**Why Daviess:**
Owensboro is the county seat of Daviess County, Kentucky. owensborotimes.com is a hyperlocal news publication exclusively covering Owensboro and Daviess County. It publishes no content outside this area.

**Note on the Warren County / Daviess County ordering issue:**
The specific murder article mentioned "Warren County Juvenile Detention Center" (where the suspect was lodged), which is in Warren County — a different county from Owensboro (Daviess). When `hasKentuckyContext = true`, `detectAllCounties` may assign Warren as primary (it appears first as an explicit "X County" match). The AI is expected to override this to Daviess because the crime occurred in Owensboro, not Warren County. Adding the source default ensures Daviess is available as a fallback even when the AI path fails.

---

## Rules derived from these fixes

| Pattern | Rule |
|---|---|
| NKY/OH border source (nkytribune.com, linknky.com) with Cincinnati-focused article | Add source to `REQUIRES_EXPLICIT_KY_GEO`; brand footer "Northern Kentucky Tribune" is not a geographic Kentucky signal |
| Site-chrome KY keyword bypassing nav filter | Lines with ≤4 words are filtered but copyright lines like "Copyright 2026 Northern Kentucky Tribune" (5 words) slips through — the `REQUIRES_EXPLICIT_KY_GEO` guard is the correct fix, not lengthening the filter threshold |
| New hyperlocal KY source with no county tag | Add to `SOURCE_DEFAULT_COUNTY` immediately with the correct county; do not wait for geo detection failures to surface |
| Detention facility county ≠ crime scene county | AI correctly overrides geo when crime scene city (Owensboro) is named; source default provides backstop when AI fails |

---

## 2026-03-18 — Two fixes: AFP canonical URL bypass; WLKY national wire tagged Kentucky

---

### Change 39 — Check canonical URL against blocked sources after fetch (2026-03-18)

**File:** `worker/src/lib/ingest.ts`

**What changed:**
Added a second `isBlockedSourceUrl` check immediately after `fetchAndExtractArticle` returns, comparing against `extracted.canonicalUrl`. The first check (against `normalizedUrl = source.url`) was already in place; this adds a complementary check for the canonical URL that the page itself declares.

```typescript
if (
  extracted.canonicalUrl !== normalizedUrl &&
  isBlockedSourceUrl(extracted.canonicalUrl)
) {
  return { status: 'rejected', reason: 'source blocked (canonical)', urlHash };
}
```

**Article that triggered this fix:**
- An article from `news.afp.com` (AFP international wire) was tagged Kentucky and posted, despite `news.afp.com` and `afp.com` being in `BLOCKED_SOURCE_HOSTNAMES`.

**Root cause:**
The AFP article arrived via an RSS feed from another domain (e.g. a local Kentucky TV station that syndicates AFP content). The `source.url` (the RSS entry URL) came from the local station's domain and therefore passed the `isBlockedSourceUrl(normalizedUrl)` check. After `fetchAndExtractArticle` fetched and parsed the page, Readability extracted the canonical URL (`<link rel="canonical">` or `<meta property="og:url">`) pointing to `news.afp.com/...`. This canonical URL was never checked against the block list — it was sent directly to `classifyArticleWithAi` with `hostname = 'news.afp.com'`. Since `news.afp.com` was not in `ALWAYS_NATIONAL_SOURCES`, the AFP article went through normal classification and could be tagged Kentucky if the article text mentioned any KY content.

**Why this fix is safe:**
The check skips the equality guard (`extracted.canonicalUrl !== normalizedUrl`) so that direct ingests from a blocked domain that produce a self-referencing canonical URL continue to be caught by the first check. The second check only fires when the canonical URL is genuinely different from (and more authoritative than) the source URL.

---

### Change 40 — Add `afp.com` / `news.afp.com` to `ALWAYS_NATIONAL_SOURCES` (2026-03-18)

**File:** `worker/src/lib/classify.ts`

**What changed:**
```diff
+ // afp.com / news.afp.com — Agence France-Presse international wire service.
+ 'afp.com',
+ 'news.afp.com',
```

**Why:**
Defence in depth: even if a future code path bypasses the ingestion block check (e.g. manual /api/admin/ingest called with an AFP URL), the classification step will still refuse to tag AFP content as Kentucky unless there is overwhelming geographic evidence (≥2 KY mentions plus AI confirmation). The ingest block is the primary gate; ALWAYS_NATIONAL_SOURCES is the backstop.

---

### Change 41 — Add `washington` to `NON_KY_DATELINE_RE` pattern 3; make line-start optional (2026-03-18)

**File:** `worker/src/lib/classify.ts`

**What changed:**
- Added `washington` to the known-non-KY city list in pattern 3 of `NON_KY_DATELINE_RE`.
- Changed pattern 3's prefix from `(?:^|\n|\.\s+)` (line-start required) to `(?:^|\n|\.\s+)?` (optional). This allows the pattern to match mid-paragraph occurrences of any listed city followed by a dash.

**Articles that triggered this fix:**
- *Watch live: Markwayne Mullin faces confirmation hearing as Trump's DHS pick* from `wlky.com` — tagged Kentucky despite a clear `WASHINGTON —` dateline and `By REBECCA SANTANA, Associated Press` byline.

**Root cause:**
When WLKY's Readability-parsed article text places the byline and dateline on one paragraph line (e.g. `...Associated Press WASHINGTON — Markwayne Mullin...`), the `WASHINGTON —` text is not preceded by a newline or sentence-ending period + space. The three NON_KY_DATELINE_RE patterns all required `(?:^|\n|\.\s+)` before the city name:
- Pattern 1: explicit `(?:^|\n|\.\s+)WASHINGTON` — fails for inline WASHINGTON
- Pattern 2: `(?:^|\n|\.\s+)[A-Z][A-Za-z\s]{1,25}, STATE —` — not applicable (no state suffix)
- Pattern 3 (cities list): `(?:^|\n|\.\s+)\b(?:los angeles|...)` — did not include `washington` and required line-start

`NATIONAL_WIRE_OVERRIDE_RE` does match `\bwashington\s*...[-—–]\s*` inline (using `\b` not line-start), correctly setting `isNationalWireStory = true`. But the override block that forces `isKentucky = false` requires `hasNonKyDateline = true`:
```typescript
if (isNationalWireStory && (hasOnlyPoliticianKyMention || hasNonKyDateline)) {
  fallback.isKentucky = false;
  ...
}
```
Because `hasNonKyDateline = false` (and `hasOnlyPoliticianKyMention = false` since no KY politicians are mentioned in the Mullin article), this block never fired. `fallback.isKentucky` remained `true` from WLKY's site-chrome KY navigation text (the WLKY page includes Louisville/Kentucky references in header/footer). Then `if (isNationalWireStory || ...) { return fallback }` returned the fallback early with `isKentucky = true`.

**Why `washington` is safe in the non-KY city list:**
Washington, KY (Mason County) is a tiny unincorporated community that has never been the subject of a `CITY —` wire dateline. All major AP/Reuters/AFP/wire stories with a `WASHINGTON —` dateline refer to Washington, DC. The negative lookaheads in patterns 1 and 2 and the dash-requirement in pattern 3 provide sufficient specificity that "Washington Street" or "Washington County" (a real KY county) will not match — only `washington —` followed by a dash will fire.

**Safety for genuine Kentucky AP stories:**
When a legitimate KY-AP story starts with "FRANKFORT, Ky. (AP) —", pattern 2 of `NON_KY_DATELINE_RE` has a negative lookahead `(?!ky\b|kentucky\b)` that prevents it from matching. "Frankfort" is not in pattern 3's city list and "washington" does not appear in those articles. So genuine KY AP wire stories are unaffected.

---

## Rules derived from these fixes

| Pattern | Rule |
|---|---|
| Wire-service article (AFP/AP/Reuters) arriving via a local-TV syndication URL | The canonical URL may differ from the RSS source URL; always check `extracted.canonicalUrl` against `isBlockedSourceUrl` after fetch |
| AFP content slipping through ingestion block | Defence in depth: add `afp.com` / `news.afp.com` to `ALWAYS_NATIONAL_SOURCES` as a backstop classification guard |
| `isNationalWireStory = true` but `hasNonKyDateline = false` | Root cause: NON_KY_DATELINE_RE required `(?:^|\n|\.\s+)` before the city name but WLKY/Hearst CMS often presents byline + dateline as one paragraph without a newline; fix is to add the city to pattern 3 with optional line-start prefix |
| `WASHINGTON —` dateline inline (no preceding newline) | Add `washington` to pattern 3 city list with `(?:^|\n|\.\s+)?` (optional prefix); the `[-—–]` after the city is specific enough to avoid false matches on "Washington Street" |
| AP wire story on a local TV station (WLKY, WHAS11) tagged Kentucky | Trace whether `isNationalWireStory` fired AND whether `hasNonKyDateline` fired; both must be true for the override to work — if the dateline is inline (no line break), only pattern 3 catches it |

---

## 2026-03-18 — Three fixes: abcnews.com hostname, CNN byline detection, Orlando/Tampa/Tallahassee city lists

---

### Change 42 — Add `abcnews.com` to `ALWAYS_NATIONAL_SOURCES` (2026-03-18)

**File:** `worker/src/lib/classify.ts`

**What changed:**
```diff
- // abcnews.go.com — ABC network news, national coverage.
- 'abcnews.go.com',
+ // abcnews.go.com / abcnews.com — ABC network news, national coverage.
+ // Both hostnames are used by ABC News.
+ 'abcnews.go.com',
+ 'abcnews.com',
```

**Article that triggered this fix:**
- *US and allied radar sites in the Middle East struck at least 10 times* from `abcnews.com` — tagged Kentucky despite being an international wire story with zero Kentucky content.

**Root cause:**
`ALWAYS_NATIONAL_SOURCES` contained `'abcnews.go.com'` but not `'abcnews.com'`. ABC News serves content from both hostnames (`abcnews.com` often resolves directly without the `.go.` subdomain). When a URL is `https://abcnews.com/...`, `new URL(...).hostname` returns `abcnews.com`, which was not in the set. The article was processed through the full classification pipeline, and WLKY/other KY outlet site-chrome leakage (or any stray KY mention in the article's navigation) was sufficient to push `isKentucky = true`.

**Why safe:**
`ALWAYS_NATIONAL_SOURCES` has a strong-text-evidence exception in the merge step: AI + geo detector must both agree on Kentucky before a story from an always-national source is kept as KY. Genuine ABC News content set in Kentucky (rare as ABC national) would still pass that bar.

---

### Change 43 — Detect major national network byline (e.g. "By Name, CNN") as wire signal (2026-03-18)

**File:** `worker/src/lib/classify.ts`

**What changed:**
Added an `isMajorNetworkByline` check immediately after the `hasNonKyDateline` override block:

```typescript
const isMajorNetworkByline =
  /\bBy\s+[A-Za-z]{2,20}(?:\s+[A-Za-z]{2,20}){0,3},\s*(?:CNN|NBC\s+News|ABC\s+News|CBS\s+News)\b/i
    .test(semanticLeadText);
if (fallback.isKentucky && isMajorNetworkByline && !baseGeo.county && !baseGeo.city) {
  fallback.isKentucky = false;
  fallback.county = null;
  fallback.counties = [];
}
```

**Article that triggered this fix:**
- *TSA workers face reality of working without pay as passengers unaware of the shutdown see long lines* from `wlky.com` (CNN story, "By Alexandra Skores, CNN") — tagged Kentucky despite being a CNN national story about Atlanta, Houston, Denver, and Seattle airports with zero Kentucky content.

**Root cause:**
The existing `NATIONAL_WIRE_OVERRIDE_RE` catches CNN via `\bcnn\s*[-—–]` (the dateline form "CNN —") and `\(cnn\s+newsource\)` (the parenthetical syndication credit). It does NOT catch byline-attributed CNN stories in the format "By Alexandra Skores, CNN" (a comma-separated attribution with no dash). Without a matching wire pattern, `isNationalWireStory = false`. The TSA article also has no non-KY city dateline at the start (it begins with "More than a third of the security screeners at Hartsfield-Jackson Atlanta…"). Since both `isNationalWireStory` and `hasNonKyDateline` are false, the `fallback.isKentucky = false` override block never fires.

The `mergedIsKentucky` merge is `fallback.isKentucky || (aiIsKentucky && aiGeo.isKentucky)`. Because `fallback.isKentucky = true` (from site-chrome KY signal), the AI cannot override it regardless of what it returns.

**Why the condition `!baseGeo.county && !baseGeo.city` is safe:**
If a genuine KY story filed by a CNN reporter has a KY dateline or KY location in the text, `detectKentuckyGeo` will return county or city values — `baseGeo.county` or `baseGeo.city` will be non-null — and the forced-national block will NOT fire. The block only fires when the article text contains no explicit KY location, i.e. it is a syndicated national story on a local outlet with only site-chrome KY signals.

---

### Change 44 — Add `orlando`, `tampa`, `tallahassee` to `NON_KY_DATELINE_RE` pattern 3 (2026-03-18)

**File:** `worker/src/lib/classify.ts`

**What changed:**
Added `orlando`, `tampa`, and `tallahassee` to pattern 3 of `NON_KY_DATELINE_RE` (the known-non-KY city list with optional line-start prefix):

```diff
- ...|colorado\s+springs|el\s+paso|omaha)\s*...
+ ...|colorado\s+springs|el\s+paso|omaha|orlando|tampa|tallahassee)\s*...
```

Note: `tallahassee` and `orlando` were already present in `NATIONAL_WIRE_OVERRIDE_RE`'s first city list but were missing from `NON_KY_DATELINE_RE` pattern 3.

**Article that triggered this fix:**
- *Florida hospital sues to evict a patient who won't leave room 5 months after discharge* from `wlky.com` (AP story, "MIKE SCHNEIDER ORLANDO, Fla. —") — tagged Kentucky despite being a Florida AP story with zero Kentucky content.

---

### Change 45 — Reject `owensborotimes.com/record/...` pages (2026-03-18)

**File:** `worker/src/lib/ingest.ts`

**What changed:**
- Added a reject rule in `ingestSingleUrl` to reject any URL on `owensborotimes.com` whose path includes `/record/`. These pages are public-record permit/transaction listings, not editorial news stories.

**Example rejected URL:**
- `https://owensborotimes.com/record/permits-august-27-2025-2-2-2-2-2-2-2-2-2-2-2-2-2-2-2-2-2-2-2-2-2-2-2-2-2-2-2-2-2`

**Why:**
Owensboro Times publishes a series of automated public-record listings under `/record/...` (permits, licenses, etc.). These are not meant to be summarized as news and should never be ingested into the system.

**Root cause:**
The AP byline format on WLKY sometimes presents as `MIKE SCHNEIDER ORLANDO, Fla. —` on a single line (no newline between the byline and the dateline). In this case:
- `NATIONAL_WIRE_OVERRIDE_RE` pattern 2 (`(?:^|\n|\.\s+)[CITY], STATE —`) does NOT match because "ORLANDO" is not preceded by `^`, `\n`, or `.\s+` — it's preceded by "SCHNEIDER " (a space after a word end, not a sentence boundary).
- `NON_KY_DATELINE_RE` pattern 2 also requires `(?:^|\n|\.\s+)` prefix and fails for the same reason.
- `NATIONAL_WIRE_OVERRIDE_RE` first city list DOES include `orlando` with `\b` (no prefix requirement), so `isNationalWireStory = true` fires. BUT the override block requires `hasNonKyDateline = true` as well — and since pattern 3 of `NON_KY_DATELINE_RE` did not include `orlando`, `hasNonKyDateline = false`. With only one of the two conditions met, the `fallback.isKentucky = false` override never fires.

Adding `orlando|tampa|tallahassee` to `NON_KY_DATELINE_RE` pattern 3 (which has an optional `(?:^|\n|\.\s+)?` prefix) ensures that `hasNonKyDateline = true` whenever `ORLANDO —` or `ORLANDO, Fla. —` appears anywhere in the lead text, closing the gap between the two guards.

---

## Rules derived from these fixes

| Pattern | Rule |
|---|---|
| National outlet with two hostnames (e.g. `abcnews.go.com` / `abcnews.com`) | Add BOTH hostnames to `ALWAYS_NATIONAL_SOURCES`; URL normalization via `new URL(...).hostname` will return whichever the page is served from |
| CNN (or NBC/ABC/CBS) wire story syndicated on local TV with `By Name, CNN` byline | `NATIONAL_WIRE_OVERRIDE_RE` only catches `CNN —` dateline form; add `isMajorNetworkByline` check that fires when brand byline is present AND no KY geo found in text |
| `isNationalWireStory = true` from NATIONAL_WIRE_OVERRIDE_RE first city list but `hasNonKyDateline = false` | City is in NATIONAL_WIRE_OVERRIDE_RE but missing from NON_KY_DATELINE_RE pattern 3; add it to both so the override block fires |
| Florida AP story with `CITY, Fla. —` dateline inline (no newline before city) | Add major Florida cities (`orlando`, `tampa`, `tallahassee`) to NON_KY_DATELINE_RE pattern 3 with its optional prefix — the `\b` anchor is enough to catch inline occurrences |

---

### Change 46 — Strip transcript redaction markers (*** ) before summarization (2026-03-18)

**File:** `worker/src/lib/ai.ts`

**What changed:**
- Added regex cleanup in both `cleanContentForSummarization` and `stripBoilerplateFromOutput` that removes long runs of asterisks (`***`, `****`, etc.) and collapses surrounding whitespace.

**Why:**
Some scraped content includes embedded video transcripts with redaction markers like `***` (e.g. "being *** coach"), which leaked into the AI summary. These tokens provide no editorial value and make summaries look broken. The fix removes them before the text is sent to the model and also cleans them from the final AI output.

---

### Change 47 — Strip AP “FILE -” photo captions and station-id header lines (2026-03-18)

**File:** `worker/src/lib/ai.ts`

**What changed:**
- Added a regex to `cleanContentForSummarization()` that removes lines starting with `FILE -` (common AP/AFP photo caption labels) before the text is sent to the AI.
- Added a regex to both `cleanContentForSummarization()` and `stripBoilerplateFromOutput()` to remove standalone station header lines like `WHAS11`, `WLKY`, `WDRB`, etc. These often appear as a second header line above the dateline and were being pulled into summaries.

**Why:**
Some wire/photo caption formats include a standalone `FILE - ...` line immediately before the story lead; this line is not part of the news narrative and should not be treated as the opening sentence of a summary. Likewise, broadcast station IDs are boilerplate that can end up as the first phrase of a summary if not stripped.

---

### Change 48 — Default `wektradio.com` articles to Todd County (2026-03-18)

**File:** `worker/src/lib/classify.ts`

**What changed:**
- Added `wektradio.com` to `SOURCE_DEFAULT_COUNTY` with a default of `Todd`.

**Why:**
Articles from WK&T Radio frequently refer to Todd County locations (e.g. Todd County Extension Arena) but often do not mention "Kentucky" explicitly. Without a default county, these articles were being tagged as Kentucky with no county assigned. The source default provides a safe fallback so the story appears under the correct county feed.

---

### Change 49 — Allow Louisville-dateline stories to inherit the source default county (2026-03-18)

**File:** `worker/src/lib/classify.ts`

**What changed:**
- Removed the special-case suppression that blocked the source default county for articles that begin with a "Louisville, Ky." dateline.

**Why:**
Louisville datelines are common, and many Louisville stories are indeed about Jefferson County even when the text does not explicitly mention county names. Preventing the default county from applying left valid Louisville stories tagged only as "Kentucky" with no county, reducing the usefulness of county-based filtering.

---

## 2026-03-19 — Four fixes: WLKY wire bleed, Indiana PM false KY, budget county, kychamberbottomline county

---

### Change 50 — Re-add `wlky.com` to `ALWAYS_NATIONAL_SOURCES` (2026-03-19)

**File:** `worker/src/lib/classify.ts`

**What changed:**
- Uncommented `'wlky.com'` in `ALWAYS_NATIONAL_SOURCES`.

**Articles that triggered this fix:**
- *US Mint can begin producing Trump commemorative gold coin* (AP/WLKY) — tagged **Kentucky + Union County**. No KY content; set in Washington DC.
- *'Hell heron': Paleontologists discover odd new dinosaur species* (CNN/WLKY) — tagged **Kentucky + Madison County**. No KY content; set in Niger.
- *Body of Alabama student missing in Barcelona found at sea* (WVTM/WLKY) — tagged **Kentucky + Campbell County**. No KY content; set in Spain.
- *Epstein's former attorney tells House panel he didn't know about the abuse* (AP/WLKY) — tagged **Kentucky + Hickman County**. No KY content; set in Washington DC.
- *Tina Turner's name, image, likeness and most music catalog rights acquired by Pophouse* (AP/WLKY) — tagged **Kentucky + Kenton County**. No KY content.

**Root cause:**
Change 27 (2026-03-17) removed `wlky.com` from `ALWAYS_NATIONAL_SOURCES` to allow genuine Louisville/Frankfort stories to be tagged as Kentucky. The rationale was that Change 25 (adding major non-KY cities to `NON_KY_DATELINE_RE` pattern 3) and Change 41 (adding `washington` with optional line-start) would catch AP wire datelines. However, many WLKY-published AP wire articles present the wire dateline and byline as a single paragraph block rather than as a line-start token, placing the critical text outside the 2,200-character `semanticLeadText` window. In those cases, `isNationalWireStory = false`, `hasNonKyDateline = false`, and `isMajorNetworkByline = false` — all three guards miss the article. WLKY's scraped page content always includes Kentucky mentions in site-chrome (navigation, related-article sidebar links), which satisfies `baseIsKentucky = true`. The sidebar links also inject county names, which pass `isCountyEvidenced` (literal text match) and get assigned as the story's county — producing the random county assignments observed (Union, Madison, Campbell, Hickman, Kenton).

**Why re-adding is safe:**
The `ALWAYS_NATIONAL_SOURCES` merge guard allows genuine KY stories through when `relevance.mentionCount >= 2` AND the AI returns `isKentucky: true`. For legitimate Louisville/Frankfort stories:
- `LOUISVILLE, Ky. —` dateline + article body → mentionCount ≥ 2 → passes the guard.
- `FRANKFORT, Ky. (AP) —` legislative story → mentionCount ≥ 2 → passes the guard.
For pure AP wire stories (Trump coin, dinosaur, etc.):
- After the nav-line filter removes site-chrome Kentucky mentions, mentionCount is 0 or 1 → fails the guard → correctly national.

**Mirrors:** Change 10 (original addition), Change 27 (removal), this change (re-addition).

---

### Change 51 — Add `ipm.org` to `ALWAYS_NATIONAL_SOURCES` (2026-03-19)

**File:** `worker/src/lib/classify.ts`

**What changed:**
```diff
+ // ipm.org (WFIU/WTIU) — Indiana Public Media
+ 'ipm.org',
```

**Article that triggered this fix:**
- *New state law to increase penalties for animal abuse, neglect* from `ipm.org` — tagged **Kentucky + Rowan County**. The article is entirely about an Indiana state law (House Enrolled Act 1165) with an Indiana lawmaker and Indiana Animal Care director quoted. No Kentucky content.

**Root cause:**
`ipm.org` (Indiana Public Media, home of WFIU/WTIU in Bloomington, IN) was not in any classification list. The article body mentioned "Indiana" many times but also included "Kentucky" in site-chrome navigation or related-article links (likely "Kentucky News" or "KY" tags in WFIU's topic sidebar). These site-chrome mentions satisfied `baseIsKentucky = true`. The AI, receiving only the first 800 characters (which includes Indiana-focused content), still returned `isKentucky: true` — possibly because "Bloomington" can be confused with Kentucky by the model, or because the navigation sidebar appeared early in the scraped text. Rowan County assignment likely came from a sidebar link to Morehead State University news or a related Rowan County article in ipm.org's sidebar.

**Why safe:**
`ipm.org` is Indiana Public Media. It covers Indiana news and public radio. No article from this source would legitimately be a Kentucky-primary story.

---

### Change 52 — Add `conference committee`, `biennium`, `two-year budget`, `executive branch budget` to statewide bill check (2026-03-19)

**File:** `worker/src/lib/classify.ts` — `isStatewideKyPoliticalStory`

**What changed:**
```diff
- if (/\bfrankfort\b|\bstatewide\b|\ball\s+of\s+kentucky\b/i.test(text)) {
+ if (/\bfrankfort\b|\bstatewide\b|\ball\s+of\s+kentucky\b|\bconference\s+committee\b|\bbiennium\b|\btwo-year[^.]{0,30}budget\b|\bexecutive\s+branch\s+budget\b/i.test(text)) {
```

**Article that triggered this fix:**
- *Senate Passes Two-Year Budget Plan, Sends Proposal Back to House* from `kychamberbottomline.com` — tagged **Kentucky + Madison County**. The story is a statewide KY legislative budget; no connection to Madison County.

**Root cause:**
`isStatewideKyPoliticalStory` detected `House Bill 500/503/504/900` in the text (triggering the bill check), then required one of `frankfort` / `statewide` / `all of kentucky` to be present. The kychamberbottomline.com article used neither; it said "conference committee" and described a "two-year executive branch budget" — both unambiguous statewide signals. Without any match, `isStatewideKyPolitics` returned `false`, the county suppression did not fire, and the AI hallucinated (or picked up from sidebar) Madison County.

**New signals added:**
| Signal | Rationale |
|---|---|
| `\bconference\s+committee\b` | A conference committee only exists when both chambers of a legislature must reconcile competing bills — inherently statewide |
| `\bbiennium\b` | Two-year budget cycle terminology; always refers to state-level budgeting |
| `\btwo-year[^.]{0,30}budget\b` | Phrase form of biennium budget; used by chamber/policy publications |
| `\bexecutive\s+branch\s+budget\b` | The formal name of the KY state budget; unambiguously statewide |

---

### Change 53 — Add `kychamberbottomline.com` to `COUNTY_REQUIRES_EXPLICIT_EVIDENCE` (2026-03-19)

**File:** `worker/src/lib/classify.ts`

**What changed:**
```diff
+ // kychamberbottomline.com — Kentucky Chamber of Commerce legislative/business
+ // roundups always cover all of KY; county only when explicitly named in the text.
+ 'kychamberbottomline.com',
```

**Why:**
The Kentucky Chamber Bottomline publishes statewide Kentucky business and legislative news. Its articles cover all 120 counties and should never receive a county tag derived from AI hallucination or sidebar leakage. Requiring an explicit "X County" mention in the article text ensures county tags only appear when the story is actually about a specific county.

---

### Investigation note — Spring break travel article from `wnky.com` is correctly tagged (2026-03-19)

**Article:** *How spring break travel plans could impact your vacation* from `wnky.com`
**Tagged:** Kentucky + Warren County

**Finding:**
This tagging is **correct and intentional**. The article:
- Has a `BOWLING GREEN, Ky.` dateline (Warren County).
- Quotes a named local representative: "Lynda Lambert with AAA East Central" — a regional AAA office serving the Bowling Green/south-central Kentucky market.
- Was filed specifically from a Bowling Green local affinity, not from a national AAA wire release.

No fix needed. Warren County is the correct county for WNKY (Bowling Green market) stories with a Bowling Green dateline and a local source on camera.

---

## Rules derived from these fixes

| Pattern | Rule |
|---|---|
| Local TV station removed from `ALWAYS_NATIONAL_SOURCES` for KY false-national | Re-add after confirming `NON_KY_DATELINE_RE` cannot reliably catch all wire dateline formats from that CMS; the strong-text-evidence guard is the correct baseline protection for genuine KY stories |
| Non-KY public media outlet (Indiana, Ohio, etc.) not in any list | Add to `ALWAYS_NATIONAL_SOURCES`; sidebar/nav "Kentucky" links will always leak KY tags otherwise |
| KY state budget article not detected as statewide | Add `conference committee`, `biennium`, `two-year budget`, `executive branch budget` to the bill-context check in `isStatewideKyPoliticalStory`; Frankfort dateline is NOT required for statewide budget coverage |
| Statewide KY policy source (chamber, trade publication) getting hallucinated county | Add to `COUNTY_REQUIRES_EXPLICIT_EVIDENCE`; these sources never cover a single county |

---

### Change 54 — Add `governor's desk`, `full senate`, `full house` to statewide bill check (2026-03-19)

**File:** `worker/src/lib/classify.ts` — `isStatewideKyPoliticalStory`

**What changed:**
```diff
- if (/\bfrankfort\b|\bstatewide\b|...|\bexecutive\s+branch\s+budget\b/i.test(text)) {
+ if (/\bfrankfort\b|\bstatewide\b|...|\bexecutive\s+branch\s+budget\b|\bgovernor'?s\s+desk\b|\bheading\s+to\s+the\s+governor\b|\bfull\s+senate\b|\bfull\s+house\b/i.test(text)) {
```

**Article that triggered this fix:**
- *18-year-old Kentuckians could carry concealed guns under bill moving toward final passage* from `lpm.org` — tagged **Kentucky + Shelby County**. The article (House Bill 312) is a statewide Kentucky gun bill. Shelby County was assigned because the text says "GOP Sen. Aaron Reed of Shelbyville" — `detectCity` found "shelbyville" → Shelby County. No connection to actual story geography.

**Root cause:**
The bill check in `isStatewideKyPoliticalStory` fired for "House Bill 312" then required one of `frankfort|statewide|conference committee|biennium|two-year budget|executive branch budget` to be present. The article used "heading to the governor's desk" and "needs only pass the full Senate" — neither matched the existing patterns.

**New signals added:**
| Signal | Rationale |
|---|---|
| `\bgovernor'?s\s+desk\b` | Bill reaching the governor's desk = passed both chambers = statewide |
| `\bheading\s+to\s+the\s+governor\b` | Phrase variant of the above |
| `\bfull\s+senate\b` | Vote by the full chamber = statewide legislative action |
| `\bfull\s+house\b` | Same for House chamber |

---

### Change 55 — Add `lpm.org` to `COUNTY_REQUIRES_EXPLICIT_EVIDENCE` (2026-03-19)

**File:** `worker/src/lib/classify.ts`

**What changed:**
```diff
+ // lpm.org — Louisville Public Media (formerly WFPL); covers all of KY statewide;
+ // county only when explicitly named.
+ 'lpm.org',
```

**Why:**
Louisville Public Media (`lpm.org`) is the successor brand to WFPL and covers all of Kentucky (state legislature, statewide policy, Louisville metro). A senator's hometown ("Shelbyville") in a statewide gun bill article should not produce a Shelby County tag. Requiring an explicit "Shelby County" mention prevents hometown-based county hallucinations.

---

### Change 56 — Add `theroamreport.com` to `ALWAYS_NATIONAL_SOURCES` (2026-03-19)

**File:** `worker/src/lib/classify.ts`

**What changed:**
```diff
+ // theroamreport.com — national outdoor/travel publication
+ 'theroamreport.com',
```

**Article that triggered this fix:**
- *The Appalachian Trail Makes History With Its First Appearance on the Most Visited National Parks List* from `theroamreport.com` — tagged **Kentucky + Madison County**. The article covers 14 US states and never mentions Kentucky.

**Root cause:**
`theroamreport.com` had no classification entry. Site-chrome Kentucky mentions (navigation links) caused `baseIsKentucky = true`. AI (or geo detector) produced Madison County — likely from the Appalachian Trail article mentioning Virginia/Blue Ridge context, combined with WYMT/KY sidebar bleed. Zero Kentucky content in the article body.

---

### Change 57 — Expand `isNationalWireStory` strip: clear KY when no genuine geo signal (2026-03-19)

**File:** `worker/src/lib/classify.ts`

**What changed:**
Added a third condition to the `isNationalWireStory` Kentucky-strip block:
```diff
- if (isNationalWireStory && (hasOnlyPoliticianKyMention || hasNonKyDateline)) {
+ const hasNoKyBodySignal =
+   !detectedKyGeo.county && !detectedKyGeo.city && relevance.mentionCount < 2;
+ if (isNationalWireStory && (hasOnlyPoliticianKyMention || hasNonKyDateline || hasNoKyBodySignal)) {
```

**Article that triggered this fix:**
- *USPS wants to raise the price of a stamp to almost $1* from `wymt.com` — tagged **Kentucky + Floyd County**. The article is a "(Gray News) -" national wire story with no Kentucky content. WYMT is a genuine Kentucky outlet (Hazard) but syndicates national Gray News content.

**Root cause:**
`NATIONAL_WIRE_OVERRIDE_RE` matched "(Gray News)" → `isNationalWireStory = true`. However the strip condition `(hasOnlyPoliticianKyMention || hasNonKyDateline)` did not fire:
- No KY politician mention.
- No non-KY city dateline (the article has no "CITY, STATE —" prefix).
So `fallback.isKentucky = true` (from WYMT site-chrome KY nav text) was returned via the early-exit `return fallback`. Floyd County came from a WYMT sidebar link to a Floyd County-related story appearing in `semanticText`.

**`hasNoKyBodySignal` definition:**
`!detectedKyGeo.county && !detectedKyGeo.city && relevance.mentionCount < 2`
- `detectedKyGeo.county = null` — no KY county found by geo detector in article body
- `detectedKyGeo.city = null` — no KY city found in article body
- `relevance.mentionCount < 2` — after nav-line filtering, fewer than 2 meaningful KY mentions

**Safety for genuine WYMT local stories:**
A real WYMT story about a crash in Floyd County would have "Floyd, KY", "Floyd County", or "Prestonsburg" → `detectedKyGeo.county = 'Floyd'` → condition fails → stays Kentucky. ✓
A FRANKFORT AP story would have "Frankfort" city detected → condition fails. ✓
A national wire story from WYMT (USPS, NFL, national politics) → no KY geo → condition passes → national. ✓

---

## Rules derived from these fixes

| Pattern | Rule |
|---|---|
| State bill moving to "governor's desk" or needing "full Senate" vote | Add these phrases to statewide bill context; they are unambiguous signs of bicameral legislation reaching final stage |
| Statewide public media outlet (LPM, WFPL) getting lawmaker-hometown county | Add to `COUNTY_REQUIRES_EXPLICIT_EVIDENCE`; a quoted senator's hometown is not the story's geographic subject |
| National outdoor/travel/lifestyle publication not in any list | Add to `ALWAYS_NATIONAL_SOURCES`; site-chrome leakage will always produce false KY tags |
| `isNationalWireStory = true` but `hasNonKyDateline = false` and article has no KY body content | The two existing conditions are insufficient — add `hasNoKyBodySignal` (no county, no city, < 2 KY mentions) as third condition |

---

### Change 58 — Upgrade `hasNoKyBodySignal` to `mentionCount === 0` (2026-03-19)

**File:** `worker/src/lib/classify.ts`

**What changed:**
```diff
- const hasNoKyBodySignal =
-   !detectedKyGeo.county && !detectedKyGeo.city && relevance.mentionCount < 2;
+ // Using mentionCount === 0 (rather than also checking !detectedKyGeo.county)
+ // ensures that sidebar-bleed county names without any "Kentucky"/"Ky." text
+ // in the article body are correctly stripped.
+ const hasNoKyBodySignal = relevance.mentionCount === 0;
```

**Articles that triggered this fix:**
- *Trump makes joke about Pearl Harbor* from `wbko.com` — tagged **Kentucky + Knox County**
- *Nearly 90,000 bottles of children's ibuprofen recalled* from `wbko.com` — tagged **Kentucky + Knox County**
- *Housing market won't bounce back to normal* from `wymt.com` — tagged **Kentucky + Knox County** (InvestigateTV wire)

**Root cause of Change 57 gap:**
Change 57's `hasNoKyBodySignal` only fired when `!detectedKyGeo.county`. But Knox County and Floyd County names appearing in sidebar/navigation text scraped from the wbko.com/wymt.com pages were being detected by `detectKentuckyGeo(semanticText)`, setting `detectedKyGeo.county = 'Knox'` or `'Floyd'`. This made the `!detectedKyGeo.county` part of the condition false, so the strip didn't fire, even though `relevance.mentionCount = 0` (zero "Kentucky"/"Ky." text in the article).

**Updated logic:**
`hasNoKyBodySignal = relevance.mentionCount === 0` — fires when there is absolutely zero organic Kentucky keyword content in the article. A county name in a sidebar link is NOT a Kentucky keyword; it doesn't produce any `mentionCount`. So articles with ONLY sidebar-bleed county names and no actual Kentucky language are correctly identified.

**Safety for genuine local stories:**
A genuine AP brief filed from Kentucky ("PIKEVILLE, Ky. (AP) — A Pike County man was...") always contains at least one "Ky." in the dateline → `mentionCount >= 1` → condition fails → article stays Kentucky. ✓
Any local KY story with a Kentucky dateline, city name written as "City, Ky.", or explicit "Kentucky" in the body → `mentionCount >= 1` → not stripped. ✓

---

### Change 59 — `isStatewideKyPoliticalStory`: recognize abbreviated "Gov." (2026-03-19)

**File:** `worker/src/lib/classify.ts`

**What changed:**
Added a new check after the existing `hasFrankfortDateline && hasPoliticalSignal` check:
```typescript
// Governor's office announcement (abbreviated "Gov.") from Frankfort
if (hasFrankfortDateline && /\bgov\.\s+[A-Z]/i.test(text)) return true;
```

**Article that triggered this fix:**
- *Team Kentucky's second Safe Teen Driving Challenge offers cash prizes* from `wnky.com` — tagged **Kentucky + Warren County**. Article has dateline "FRANKFORT, Ky. –" and body says "Gov. Andy Beshear announced..." — a statewide governor's press release that was incorrectly tagged Warren County (wnky.com's source default).

**Root cause:**
`hasPoliticalSignal` regex matches `\bgovernor\b` (the full word) but not the abbreviation `Gov.`. The article used `Gov. Andy Beshear` throughout. Zero other political signals fired (no bill text, no statewide keyword in the regex). So `isStatewideKyPoliticalStory` returned `false` → source default Warren County applied.

**Why this is safe:**
The condition requires BOTH a Frankfort dateline AND the `gov. [Capital letter]` pattern. An article about Frankfort history that happens to mention "Gov. [Historical figure]" would still pass both conditions — but those articles are genuinely statewide stories about historical Kentucky governors, so suppressing the county is correct.

---

### Change 60 — `isStatewideKyPoliticalStory`: add "targeting Kentuckians"/"across Kentucky" signals (2026-03-19)

**File:** `worker/src/lib/classify.ts`

**What changed:**
Added a new early-return block in `isStatewideKyPoliticalStory` after the existing roundup-language check:
```typescript
// Statewide alert/warning language
if (/\btargeting\s+(?:all\s+)?kentuckians?\b|\bacross\s+(?:all\s+of\s+)?kentucky\b/i.test(text)) {
  return true;
}
```

**Article that triggered this fix:**
- *FBI warns of rising sheriff impersonation scams in Kentucky* from `harlanenterprise.net` — tagged **Kentucky + Harlan County**. Article body: "schemes targeting Kentuckians" and "law enforcement agencies across Kentucky". This is a statewide FBI warning, not a Harlan-county-specific story.

**Root cause:**
The article has a Louisville dateline (not Frankfort), no bill text, no legislative signals, fewer than 4 KY cities. None of the existing `isStatewideKyPoliticalStory` checks fired. The harlanenterprise.net source default (Harlan County) was applied.

**Safety:**
`targeting Kentuckians` only appears in statewide-scope alert/advisory articles. `across Kentucky` (or `across all of Kentucky`) is a reliable indicator that the story has statewide scope with no single-county subject. False-positive risk is very low.

---

### Change 61 — Strip "What you need to know" CMS section header in summarization (2026-03-19)

**File:** `worker/src/lib/ai.ts`

**What changed:**
Added a strip in `cleanContentForSummarization`:
```typescript
// Strip "What you need to know" CMS summary boxes (linknky.com / LINK nky).
t = t.replace(/^What\s+you\s+need\s+to\s+know\b.+?(?=\n{2,})/gims, '');
```

**Article that triggered this fix:**
- *Independence opposes bill to partially abolish property tax* from `linknky.com` — summary started with "What you need to know" section header and bullet points instead of the article narrative.

**Root cause:**
linknky.com (LINK nky) articles use a CMS pattern where a "What you need to know" header precedes 2–4 bullet-synopsis lines before the article body. The `cleanContentForSummarization` function did not strip this header, so the AI summarizer was receiving the teaser bullets as the lead content and incorporating the header phrase into the summary.

**Pattern details:**
- `^What\s+you\s+need\s+to\s+know\b` — anchored at line start
- `.+?(?=\n{2,})` with `gims` flags — matches everything up to (but not including) the first blank line (the section separator). The `s` (dotAll) flag allows `.` to match newlines within the section.
- After stripping, the blank line remains as a paragraph break before the article body.

**Also applies to:** Any other publication that uses identical "What you need to know" section headers (common in modern CMS templates).

---

## Rules derived from these additional fixes

| Pattern | Rule |
|---|---|
| Wire story (`isNationalWireStory = true`) with county name only from sidebar bleed, no "Kentucky"/"Ky." in article body | Use `mentionCount === 0` for `hasNoKyBodySignal`; county-only bleed without any KY language is always sidebar noise |
| Governor's press release from Frankfort with abbreviated "Gov." title | Extend `isStatewideKyPoliticalStory` Gov.-abbreviation check; `hasPoliticalSignal` only catches full "governor" |
| Statewide law-enforcement/health warning "targeting Kentuckians" from local outlet | Add `targeting Kentuckians` as statewide signal; these always affect the entire Commonwealth |
| CMS "What you need to know" bullet list before article body | Strip in `cleanContentForSummarization`; prevents summary from parroting teaser bullets |
