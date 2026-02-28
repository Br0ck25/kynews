import { KY_CITY_TO_COUNTY, KY_CITY_TO_COUNTIES, KY_COUNTIES } from '../data/ky-geo';

/**
 * US state names that indicate a county or city match is NOT in Kentucky.
 * When one of these appears within OUT_OF_STATE_WINDOW characters of a match,
 * the hit is discarded unless the full text also contains "Kentucky" / "KY".
 */
const OUT_OF_STATE_NAMES = [
  'alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado',
  'connecticut', 'delaware', 'florida', 'georgia', 'hawaii', 'idaho',
  'illinois', 'indiana', 'iowa', 'kansas', 'louisiana', 'maine',
  'maryland', 'massachusetts', 'michigan', 'minnesota', 'mississippi',
  'missouri', 'montana', 'nebraska', 'nevada', 'new hampshire', 'new jersey',
  'new mexico', 'new york', 'north carolina', 'north dakota', 'ohio',
  'oklahoma', 'oregon', 'pennsylvania', 'rhode island', 'south carolina',
  'south dakota', 'tennessee', 'texas', 'utah', 'vermont', 'virginia',
  'washington', 'west virginia', 'wisconsin', 'wyoming',
];

// simple helper used by several regex builders; define before any use so
// module initialization cannot fail with a temporal dead zone error.
export function escapeRegExp(value: string): string {
  // corrected character class: the `[` is now properly escaped so names
  // containing literal brackets will be handled safely.
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// precompile whole-word regexes for out-of-state names to avoid expensive
// substring checks (and false positives such as "georgia" matching inside
// "Georgetown").
const OUT_OF_STATE_RES: RegExp[] = OUT_OF_STATE_NAMES.map(
  (s) => new RegExp(`\\b${escapeRegExp(s)}\\b`, 'i')
);

/**
 * Counties whose names are extremely common English words or famous proper
 * names.  These terms routinely appear in contexts unrelated to a Kentucky
 * county (e.g. “Lincoln Center”, “green energy”, “Todd Bridges”).  For
 * entries in this set we only accept a hit when the article has explicit
 * Kentucky context *and* no nearby out-of-state signal.  This tightens the
 * matching rules compared with normal counties and helps avoid false
 * positives.
 */
const AMBIGUOUS_COUNTY_NAMES = new Set([
  'Green',    // color / adjective
  'Ohio',     // river, state, university etc.
  'Logan',    // personal name
  'Lincoln',  // Abe Lincoln, car brand, etc.
  'Monroe',   // Monroe doctrine, Marilyn Monroe
  'Mason',    // person name, mason jar
  'Warren',   // Warren Buffett
  'Grant',    // grant funding
  'Lee',      // very common surname
  'Todd',     // common first/last name
  'Lawrence', // person name
  'Fleming',  // person name
  'Boyd',     // person name
  'Clay',     // Henry Clay, clay material
  'Hart',     // person name, common word
  'Lewis',    // person name
  'Allen',    // person name
  'Powell',   // person name
  'Russell',  // person name
  'Spencer',  // person name
  'Taylor',   // person name
  'Wayne',    // person name
  'Webster',  // person/dictionary
]);

/**
 * Real Kentucky city names whose plain-language forms are so generic that
 * they produce far more noise than signal when scanned in article bodies.
 * These names are excluded entirely from automatic city detection; they may
 * still be suggested by the AI classifier when appropriate.
 */
const NOISE_CITY_NAMES = new Set([
  'ella', 'nell', 'chance', 'bliss', 'lamb', 'amos', 'settle', 'joy',
  'energy', 'quality', 'faith', 'bee', 'pig', 'art', 'ada', 'cap',
  'lola', 'flat', 'red', 'ray', 'crude', 'path', 'busy', 'age',
  'bloom', 'charm', 'tips', 'lick', 'purdy', 'ida', 'eda',
  'dell', 'emit', 'hip', 'jeff', 'vox', 'finn', 'clay city',
  'good luck', 'hima', 'mize', 'relief', 'index', 'milo',
]);

/**
 * Phrases indicating a federal court district rather than a Kentucky
 * municipality.  When a city match is immediately followed by “district” the
 * hit is suppressed to avoid misclassifying text like “Eastern District of
 * Kentucky” as the city of Eastern (Floyd County).
 *
 * NOTE: the previous implementation used a `SUPPRESSED_PHRASES` set here,
 * but the logic was migrated inline within `detectCity()`; the constant was
 * left behind and is now unused, so it has been removed.
 */

/**
 * Postal abbreviations for non-Kentucky states, lowercase for matching against
 * normalised text. KY is absent (positive signal). CO is absent because after
 * normalisation "co" is the county abbreviation itself; we rely on the full
 * state name "colorado" from OUT_OF_STATE_NAMES instead.
 */
const OUT_OF_STATE_ABBR_RE =
  /\b(al|ak|az|ar|ca|ct|de|fl|ga|hi|id|il|in|ia|ks|la|me|md|ma|mi|mn|ms|mo|mt|ne|nv|nh|nj|nm|ny|nc|nd|oh|ok|or|pa|ri|sc|sd|tn|tx|ut|vt|va|wa|wv|wi|wy)\b/;

/** Radius (characters) around a match to search for out-of-state signals. */
const OUT_OF_STATE_WINDOW = 150;

/** Matches "Kentucky" or the standalone postal abbreviation "KY". */
const KY_PRESENT_RE = /\bkentucky\b|\bky\b/i;

/**
 * Cities that share their name with many well-known places, universities, brands,
 * or common words outside Kentucky. For these, a bare global "Kentucky" context
 * is NOT sufficient — a location signal must appear nearby the city mention OR
 * "KY" / "Ky." must exist in the same vicinity, even when the full article has
 * heavy KY context (e.g. a UK basketball article).
 *
 * Exported so classify.ts can detect when a county assignment came from one of
 * these ambiguous cities and trigger an AI double-check.
 */
export const HIGH_AMBIGUITY_CITIES = new Set([
  'columbia',   // Columbia, SC / MO / MD / TN / OH — also Columbia Records, brand
  'franklin',   // Franklin, TN / PA / OH and many others
  'springfield',// Springfield, MO / IL / OH etc.
  'henderson',  // Henderson, NV / NC etc.
  'paris',      // Paris, France / TX etc.
  'london',     // London, UK / OH etc.
  'canton',     // Canton, OH etc.
  'auburn',     // Auburn, AL / ME etc.
  'stanford',   // Stanford University, CA
]);

/**
 * Unambiguous Kentucky signals used only in detectKentuckyGeo's final fallback.
 * Deliberately does NOT include "X county" strings — those must go through
 * detectCounty so the out-of-state context guard runs. The previous version
 * included KY_COUNTIES.map(c => `${c} county`) which meant "christian county"
 * in a Missouri article bypassed the guard and set isKentucky = true.
 */
const KY_UNAMBIGUOUS_KEYWORDS = ['kentucky', 'commonwealth of kentucky'];

/**
 * @typedef {object} GeoDetection
 * @property {boolean} isKentucky
 * @property {string|null} county  primary county for backward compatibility
 * @property {string[]} counties   all detected counties (primary first)
 * @property {string|null} city
 */

/**
 * @param {string} input
 * @returns {GeoDetection}
 */
export function detectKentuckyGeo(input) {
  const haystack = normalizeForSearch(input);

  const counties = detectAllCounties(haystack, input);
  if (counties.length > 0) {
    return {
      isKentucky: true,
      county: counties[0],
      counties,
      city: null,
    };
  }

  const city = detectCity(input);
  if (city) {
    // A single city can span multiple counties; the plural map contains an
    // array of all counties that should be returned when a city is matched.
    // The original `KY_CITY_TO_COUNTY` remains available for callers that
    // expect the legacy single-county lookup.
    const cityCounties =
      KY_CITY_TO_COUNTIES[city] ??
      (KY_CITY_TO_COUNTY[city] ? [KY_CITY_TO_COUNTY[city]] : []);
    return {
      isKentucky: true,
      county: cityCounties[0] ?? null,
      counties: cityCounties,
      city,
    };
  }

  // Final fallback: unambiguous keywords only — county names are NOT checked here.
  const isKentucky =
    KY_UNAMBIGUOUS_KEYWORDS.some((token) => haystack.includes(token)) ||
    /\bky\b/.test(haystack);

  return { isKentucky, county: null, counties: [], city: null };
}

/**
 * Detects a Kentucky county name in the input text.
 *
 * Supported forms: "Leslie County", "Leslie Co", "Leslie Cnty".
 * The "Co" abbreviation only fires when followed by a space or end-of-string
 * (punctuation is already normalised to spaces in the input), preventing
 * mid-sentence matches like "oil co" or "holding co news".
 *
 * A match is accepted only when:
 *   (a) The article contains "Kentucky"/"KY" (hasKentuckyContext), OR
 *   (b) No out-of-state signal appears within OUT_OF_STATE_WINDOW chars of the match.
 *
 * @param input    Normalised (lowercase, punctuation→space) text.
 * @param rawInput Original text used for the global KY-presence check. Optional.
 */
export function detectCounty(input, rawInput) {
  const normalized = normalizeForSearch(input);
  const globalText = rawInput ? rawInput.toLowerCase() : normalized;
  const hasKentuckyContext = KY_PRESENT_RE.test(globalText);

  for (const county of KY_COUNTIES) {
    const escaped = escapeRegExp(county.toLowerCase());

    // NOTE: `[\\s]` inside the template literal becomes `[\s]` in the regex string,
    // which is the whitespace character class. Using a plain space ` ` would also
    // work but `\s` is more explicit and handles tab-separated text if it ever appears.
    const countyPattern = new RegExp(
      `\\b${escaped}\\s+(?:county|counties|cnty|co(?=[\\s]|$))\\b`,
      'i',
    );

    const match = countyPattern.exec(normalized);
    if (!match) continue;

    const disqualified =
      isMatchDisqualifiedByState(normalized, match.index, match[0].length);

    if (AMBIGUOUS_COUNTY_NAMES.has(county)) {
      // Ambiguous county names require explicit Kentucky context *and*
      // absence of an out-of-state signal.
      if (hasKentuckyContext && !disqualified) {
        return county;
      }
    } else {
      if (hasKentuckyContext) {
        return county;
      }
      if (!disqualified) {
        return county;
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Derived data structures
// ---------------------------------------------------------------------------

// Longest-first ordering ensures multi-word cities (e.g. "Bowling Green")
// are matched before single-word substrings (e.g. "Green") that may appear
// inside them. Do not change this ordering.
const SORTED_CITY_ENTRIES =
  Object.keys(KY_CITY_TO_COUNTY)
    .filter((c) => !NOISE_CITY_NAMES.has(c))
    .map((c) => ({ city: c, county: KY_CITY_TO_COUNTY[c] }))
    .sort((a, b) => b.city.length - a.city.length);

/**
 * Detects a Kentucky city name in the input text.
 *
 * Guards (applied in order):
 *  1. City must appear at least once.
 *  2. Single mention requires a location signal nearby OR explicit KY context.
 *  3. Single mention that looks like a person's surname is skipped.
 *  4. Without KY context, a non-KY state name near the city disqualifies it.
 */
export function detectCity(input) {
  const raw = String(input || '');
  const normalized = normalizeForSearch(raw);
  const hasKentuckyContext = /\bkentucky\b|\bky\b/.test(normalized);
  const matchedRanges = [];

  // Iterate cities in longest-first order to give precedence to multi-word
  // names such as "Bowling Green" over their shorter substrings like "Green".
  for (const { city } of SORTED_CITY_ENTRIES) {
    // ignore cities whose names are generic noise words; they are only
    // ever returned via the AI classifier, not by automatic matching.
    if (NOISE_CITY_NAMES.has(city)) continue;

    const pattern = buildCityPattern(city);
    const globalPattern = new RegExp(pattern.source, 'gi');
    const allMatches = Array.from(normalized.matchAll(globalPattern));
    if (allMatches.length === 0) continue;

    // filter out any matches that overlap previously accepted ranges
    const nonOverlapping = allMatches.filter((m) => {
      const start = m.index;
      const end = start + m[0].length;
      return !overlaps(start, end, matchedRanges);
    });
    if (nonOverlapping.length === 0) continue;

    const likelyCount = nonOverlapping.length;
    const cityIndex = nonOverlapping[0].index ?? -1;
    const hasLocationSignals = hasLocationSignalNearby(normalized, city);
    const isHighAmbiguity = HIGH_AMBIGUITY_CITIES.has(city);

    // suppress cases like "Eastern District of Kentucky" – the word
    // "district" immediately following the city indicates a federal court
    // context rather than the municipality.
    if (cityIndex !== -1) {
      const matchEnd = cityIndex + nonOverlapping[0][0].length;
      const after = raw.slice(matchEnd, matchEnd + 20);
      if (/^\s*district\b/i.test(after)) {
        continue;
      }
    }

    if (!hasLocationSignals && !hasKentuckyContext && likelyCount < 2) {
      continue;
    }

    if (isHighAmbiguity && !hasLocationSignals) {
      continue;
    }

    if (likelyCount === 1 && isLikelyPersonName(raw, city)) {
      continue;
    }

    if (!hasKentuckyContext || isHighAmbiguity) {
      if (
        cityIndex !== -1 &&
        isMatchDisqualifiedByState(normalized, cityIndex, city.length)
      ) {
        continue;
      }
    }

    // record the accepted range so that later (shorter) cities don't stomp it
    const start = nonOverlapping[0].index;
    const end = start + nonOverlapping[0][0].length;
    matchedRanges.push({ start, end });

    return city;
  }

  return null;
}

export function normalizeCountyList(values) {
  const set = new Set();
  for (const value of values) {
    const normalized = value.trim().toLowerCase().replace(/ county$/u, '');
    if (!normalized) continue;
    const matched = KY_COUNTIES.find((county) => county.toLowerCase() === normalized);
    if (matched) set.add(matched);
  }
  return [...set];
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function normalizeForSearch(input) {
  return ` ${input.toLowerCase().replace(/[^a-z0-9\s]/g, ' ')} `.replace(/\s+/g, ' ');
}

/**
 * Detects all Kentucky county names in the input text, including counties
 * that appear in shared-suffix enumeration patterns like
 * "Laurel and Knox County" or "Pike, Floyd, and Knott County".
 *
 * This function performs two passes:
 *
 *   1. **Standard matching** – identical to `detectCounty` but collecting
 *      *every* occurrence rather than returning early. Each hit is vetted
 *      against the out-of-state guard.
 *
 *   2. **Shared-suffix enumeration** – identifies constructs where a single
 *      trailing "County" (or variant) applies to multiple county names
 *      separated by commas, "and", "or", or "&".  For each such match the
 *      individual county names are extracted and included in the result.
 *      This pass also honours the out-of-state disqualification rule.
 *
 * The returned array lists counties in the order they were encountered in
 * the text, and deduplicates any duplicates that may arise between the two
 * passes.
 */
export function detectAllCounties(input, rawInput) {
  const normalized = normalizeForSearch(input);
  const globalText = rawInput ? rawInput.toLowerCase() : normalized;
  const hasKentuckyContext = KY_PRESENT_RE.test(globalText);

  // temporary storage for match locations and associated county names
  const matches = [];

  // Pass A: direct county patterns (same as detectCounty but collect all)
  for (const county of KY_COUNTIES) {
    const escaped = escapeRegExp(county.toLowerCase());
    const pattern = new RegExp(
      `\\b${escaped}\\s+(?:county|counties|cnty|co(?=[\\s]|$))\\b`,
      'gi',
    );
    let m;
    while ((m = pattern.exec(normalized))) {
      const idx = m.index;
      const hasOutOfState = isMatchDisqualifiedByState(normalized, idx, m[0].length);

      if (AMBIGUOUS_COUNTY_NAMES.has(county)) {
        // ambiguous counties require both KY context and no out-of-state signal
        if (!hasKentuckyContext || hasOutOfState) {
          continue;
        }
      } else {
        // non-ambiguous counties still follow the original rule: either the
        // article has KY context or no nearby out-of-state mention.
        if (!hasKentuckyContext && hasOutOfState) {
          continue;
        }
      }
      matches.push({ index: idx, names: [county] });
    }
  }

  // Pass B: enumeration with shared "County" suffix.  Instead of building a
  // giant alternation regex (which could catastrophically backtrack on
  // pathological input), we scan for simple anchors and then inspect a short
  // preceding window for county names using the same token‑walking logic.
  //
  // Avoid firing on boilerplate phrases like "county road", "county seat",
  // "county clerk" etc. The anchor regex below uses a negative lookahead so
  // that the word "county" followed by common non-name nouns is skipped.  The
  // separate abbreviation matcher for "co" is kept distinct since the
  // negative lookahead would rarely apply and would make the pattern slower.
  const anchorRe = /\b(?:county|counties|cnty)(?!\s+(?:road|rd|seat|clerk|judge|executive|attorney|court|line|wide|fair|park|library|school|board|commission|government|official|employee|budget|tax|levy|fee|record|jail|detention|health|department|office|building|center|museum|airport|market|extension|agent|coroner|engineer|surveyor|treasurer|sheriff|constable|magistrate|landfill|garage|barn|farm|fairground|courthouse|emergency|dispatch|animal|control|humane|recycling))\b/gi;
  const coAbbrevRe = /\bco(?=[\s]|$)/gi;
  let am;
  // collect positions from both regexes so we can process them in order
  const anchors: Array<{index: number; text: string}> = [];
  while ((am = anchorRe.exec(normalized))) {
    anchors.push({ index: am.index, text: am[0] });
  }
  while ((am = coAbbrevRe.exec(normalized))) {
    anchors.push({ index: am.index, text: am[0] });
  }
  anchors.sort((a, b) => a.index - b.index);
  for (const { index: anchorIdx, text: anchorText } of anchors) {
    const idx = anchorIdx;
    if (!hasKentuckyContext && isMatchDisqualifiedByState(normalized, idx, anchorText.length)) {
      continue;
    }

    const windowStart = Math.max(0, idx - 120);
    let windowText = normalized.slice(windowStart, idx + anchorText.length);
    // strip the trailing suffix so our splitter only sees the county names
    windowText = windowText.replace(/\s+(?:county|counties|cnty|co\b)$/, '');

    const parts = windowText.split(/\s*(?:,|\/|-|and|or|&)\s*/).map((p) => p.trim());
    let names = [];
    for (const chunk of parts) {
      if (!chunk) continue;
      const tokens = chunk.split(/\s+/).filter((t) => t.length > 1);
      let j = 0;
      while (j < tokens.length) {
        let matchedCounty = null;
        for (const county of KY_COUNTIES) {
          const words = county.toLowerCase().split(' ');
          if (
            tokens.slice(j, j + words.length).join(' ') ===
            words.join(' ')
          ) {
            if (
              !matchedCounty ||
              words.length > matchedCounty.split(' ').length
            ) {
              matchedCounty = county;
            }
          }
        }
        if (matchedCounty) {
          names.push(matchedCounty);
          j += matchedCounty.split(' ').length;
        } else {
          j += 1;
        }
      }
    }

    if (names.length > 0) {
      const hasOutOfState = isMatchDisqualifiedByState(normalized, idx, am[0].length);
      if (AMBIGUOUS_COUNTY_NAMES.size > 0) {
        names = names.filter((county) => {
          if (AMBIGUOUS_COUNTY_NAMES.has(county)) {
            return hasKentuckyContext && !hasOutOfState;
          }
          return true;
        });
      }
    }
    if (names.length > 0) {
      matches.push({ index: idx, names });
    }
  }

  // -----------------------------------------------------------------------
  // Pass C: detect county names embedded in high-school style phrases. The
  // two primary patterns are:
  //   1. Directional prefix: "North Laurel", "South Warren", etc.  These
  //      are ambiguous words so we only accept them when there is some sports
  //      / school context nearby to avoid false hits on phrases like "Western
  //      Hills".
  //   2. County name + school suffix: "Johnson Central", "Pike Central",
  //      "Knott High" etc.  These are already specific enough that no extra
  //      context check is needed, but we still skip cases where the county is
  //      followed by the word "county" ("Clay County High").
  //
  // Both patterns re-use the same ambigious‑county and out‑of‑state guards as
  // Pass A, and their results are added to `matches` for downstream sorting.

  const directionalPrefixes =
    'north|south|east|west|central|upper|lower|western|eastern|' +
    'northern|southern|northeastern|northwestern|southeastern|southwestern';
  const countyAlt = KY_COUNTIES
    .map((c) => `(?:\\b${escapeRegExp(c.toLowerCase())}\\b)`)
    .join('|');
  const schoolDirectionalRe = new RegExp(
    `\\b(?:${directionalPrefixes})\\s+(${countyAlt})\\b`,
    'gi',
  );
  const schoolSuffixes =
    'central|high|middle|elementary|academy|junior|senior|preparatory|prep';
  const schoolSuffixRe = new RegExp(
    `\\b(${countyAlt})\\s+(?:${schoolSuffixes})\\b`,
    'gi',
  );

  // helper for pattern1 context check
  function hasSchoolSportsContext(text) {
    return /\b(?:school|high school|team|coach|tournament|district|region|game|score|player|roster|season|basketball|football|softball|baseball|volleyball|soccer|wrestling|swimming|track|cross\s+country|tennis|golf|quiz\s+bowl|khsaa|lady|jaguars|cardinals|hawks|panthers|eagles|tigers|bulldogs|warriors|colonels|knights)\b/i.test(text);
  }

  // PROCESS PATTERN 1
  let m;
  while ((m = schoolDirectionalRe.exec(normalized))) {
    const countyMatch = m[1];
    const idx2 = m.index + m[0].length - countyMatch.length;
    const countyName = countyMatch.toLowerCase();
    if (!hasSchoolSportsContext(normalized)) continue;
    if (!hasKentuckyContext && isMatchDisqualifiedByState(normalized, idx2, countyMatch.length)) {
      continue;
    }
    if (AMBIGUOUS_COUNTY_NAMES.has(countyMatch)) {
      if (!hasKentuckyContext) continue;
    }
    matches.push({ index: idx2, names: [countyMatch] });
  }

  // PROCESS PATTERN 2
  while ((m = schoolSuffixRe.exec(normalized))) {
    const countyMatch = m[1];
    const idx2 = m.index;
    // skip if followed shortly by the word "county"
    if (/^\s+county/i.test(normalized.slice(idx2 + m[0].length, idx2 + m[0].length + 20))) {
      continue;
    }
    if (!hasKentuckyContext && isMatchDisqualifiedByState(normalized, idx2, countyMatch.length)) {
      continue;
    }
    if (AMBIGUOUS_COUNTY_NAMES.has(countyMatch)) {
      if (!hasKentuckyContext) continue;
    }
    matches.push({ index: idx2, names: [countyMatch] });
  }

  // sort by appearance
  matches.sort((a, b) => a.index - b.index);
  const results = [];
  for (const m of matches) {
    for (const name of m.names) {
      // the names array can contain values from both passes; ensure we
      // perform a case-insensitive lookup since some branches push
      // capitalized strings while others are lowercase.
      const proper = KY_COUNTIES.find(
        (c) => c.toLowerCase() === name.toLowerCase(),
      );
      if (proper && !results.includes(proper)) {
        results.push(proper);
      }
    }
  }

  return results;
}



/**
 * Build a regex that matches the given city name as a whole word or phrase.
 *
 * Both single- and multi-word names are treated the same way, with `\b`
 * word-boundary anchors on either side.  The input is escaped so literal
 * characters like "." or "(" do not break the pattern.
 *
 * The returned regex is case‑insensitive but does **not** include the `g`
 * flag; callers can add `g` when they need to iterate over multiple matches.
 */
function buildCityPattern(city) {
  return new RegExp(`\\b${escapeRegExp(city.toLowerCase())}\\b`, 'i');
}

/**
 * Return true if the given character range overlaps any previously recorded
 * match ranges.  Used during city detection to prevent shorter city names from
 * firing when their text is part of a longer, already-accepted match.
 */
function overlaps(
  matchStart,
  matchEnd,
  matched,
) {
  return matched.some((r) => matchStart < r.end && matchEnd > r.start);
}

/**
 * Returns true if the text window around a geo match contains a signal
 * that places the location in a non-Kentucky US state.
 */
function isMatchDisqualifiedByState(
  normalized,
  matchIndex,
  matchLength,
) {
  const start = Math.max(0, matchIndex - OUT_OF_STATE_WINDOW);
  const end = Math.min(normalized.length, matchIndex + matchLength + OUT_OF_STATE_WINDOW);
  const window = normalized.slice(start, end);

  // use precompiled regexes to ensure we only match whole words
  for (const re of OUT_OF_STATE_RES) {
    if (re.test(window)) return true;
  }

  // We originally also checked for two-letter state abbreviations (e.g. "IN",
  // "OH") but in practice this provoked a lot of false positives.  Words like
  // "in" and "or" are extremely common in English and would almost always
  // cause a valid Kentucky county hit to be discarded when the surrounding
  // sentence happened to include that preposition.  Since full state names are
  // a far more reliable indicator and we already require Kentucky context or an
  // explicit out‑of‑state mention for a match to be accepted, drop the
  // abbreviation check entirely.

  return false;
}


function hasLocationSignalNearby(normalizedInput, city) {
  const signals = [' in ', ' at ', ' from ', ' near ', ' city of ', ' county ', ' ky ', ' kentucky '];
  const words = normalizedInput.trim().split(/\s+/);
  const cityWords = city.split(' ');

  for (let i = 0; i < words.length; i += 1) {
    let matches = true;
    for (let j = 0; j < cityWords.length; j += 1) {
      if (words[i + j] !== cityWords[j]) {
        matches = false;
        break;
      }
    }
    if (!matches) continue;

    const start = Math.max(0, i - 5);
    const end = Math.min(words.length, i + cityWords.length + 5);
    const windowText = ` ${words.slice(start, end).join(' ')} `;
    if (signals.some((signal) => windowText.includes(signal))) return true;
  }

  return false;
}

function isLikelyPersonName(rawInput, city) {
  if (city.includes(' ')) return false;
  const personRe = new RegExp(`\\b${escapeRegExp(city)}\\s+[A-Z][a-z]{2,}\\b`);
  return personRe.test(rawInput);
}
