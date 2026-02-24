import { KY_CITY_TO_COUNTY, KY_COUNTIES } from '../data/ky-geo';

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
] as const;

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
 */
const HIGH_AMBIGUITY_CITIES = new Set<string>([
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
const KY_UNAMBIGUOUS_KEYWORDS = ['kentucky', 'commonwealth of kentucky'] as const;

export interface GeoDetection {
  isKentucky: boolean;
  county: string | null;
  city: string | null;
}

export function detectKentuckyGeo(input: string): GeoDetection {
  const haystack = normalizeForSearch(input);

  const county = detectCounty(haystack, input);
  if (county) {
    return { isKentucky: true, county, city: null };
  }

  const city = detectCity(input);
  if (city) {
    return {
      isKentucky: true,
      county: KY_CITY_TO_COUNTY[city] ?? null,
      city,
    };
  }

  // Final fallback: unambiguous keywords only — county names are NOT checked here.
  const isKentucky =
    KY_UNAMBIGUOUS_KEYWORDS.some((token) => haystack.includes(token)) ||
    /\bky\b/.test(haystack);

  return { isKentucky, county: null, city: null };
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
export function detectCounty(input: string, rawInput?: string): string | null {
  const normalized = normalizeForSearch(input);
  const globalText = rawInput ? rawInput.toLowerCase() : normalized;
  const hasKentuckyContext = KY_PRESENT_RE.test(globalText);

  for (const county of KY_COUNTIES) {
    const escaped = escapeRegExp(county.toLowerCase());

    // NOTE: `[\\s]` inside the template literal becomes `[\s]` in the regex string,
    // which is the whitespace character class. Using a plain space ` ` would also
    // work but `\s` is more explicit and handles tab-separated text if it ever appears.
    const countyPattern = new RegExp(
      `\\b${escaped}\\s+(?:county|cnty|co(?=[\\s]|$))\\b`,
      'i',
    );

    const match = countyPattern.exec(normalized);
    if (!match) continue;

    if (hasKentuckyContext) {
      return county;
    }

    if (isMatchDisqualifiedByState(normalized, match.index, match[0].length)) {
      continue;
    }

    return county;
  }

  return null;
}

/**
 * Detects a Kentucky city name in the input text.
 *
 * Guards (applied in order):
 *  1. City must appear at least once.
 *  2. Single mention requires a location signal nearby OR explicit KY context.
 *  3. Single mention that looks like a person's surname is skipped.
 *  4. Without KY context, a non-KY state name near the city disqualifies it.
 */
export function detectCity(input: string): string | null {
  const raw = String(input || '');
  const normalized = normalizeForSearch(raw);
  const hasKentuckyContext = /\bkentucky\b|\bky\b/.test(normalized);

  for (const city of Object.keys(KY_CITY_TO_COUNTY)) {
    const likelyCount = countCityMentions(normalized, city);
    if (likelyCount === 0) continue;

    const hasLocationSignals = hasLocationSignalNearby(normalized, city);

    // High-ambiguity city names (e.g. "columbia", "auburn") require a nearby
    // location signal even when the article has global KY context.  A story
    // about Kentucky basketball at Auburn (Alabama) must not be assigned a KY
    // county just because "Auburn" exists somewhere in the scraped text.
    const isHighAmbiguity = HIGH_AMBIGUITY_CITIES.has(city);

    if (!hasLocationSignals && !hasKentuckyContext && likelyCount < 2) {
      continue;
    }

    if (isHighAmbiguity && !hasLocationSignals) {
      continue;
    }

    if (likelyCount === 1 && isLikelyPersonName(raw, city)) {
      continue;
    }

    // Without KY context, check whether the city appears alongside a non-KY state.
    if (!hasKentuckyContext) {
      const cityIndex = findCityIndex(normalized, city);
      if (cityIndex !== -1 && isMatchDisqualifiedByState(normalized, cityIndex, city.length)) {
        continue;
      }
    }

    const token = city.includes(' ') ? city : ` ${city} `;
    if (city.includes(' ')) {
      if (normalized.includes(city)) return city;
      continue;
    }

    if (normalized.includes(token)) return city;
  }
  return null;
}

export function normalizeCountyList(values: string[]): string[] {
  const set = new Set<string>();
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

function normalizeForSearch(input: string): string {
  return ` ${input.toLowerCase().replace(/[^a-z0-9\s]/g, ' ')} `.replace(/\s+/g, ' ');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Returns true if the text window around a geo match contains a signal
 * that places the location in a non-Kentucky US state.
 */
function isMatchDisqualifiedByState(
  normalized: string,
  matchIndex: number,
  matchLength: number,
): boolean {
  const start = Math.max(0, matchIndex - OUT_OF_STATE_WINDOW);
  const end = Math.min(normalized.length, matchIndex + matchLength + OUT_OF_STATE_WINDOW);
  const window = normalized.slice(start, end);

  for (const state of OUT_OF_STATE_NAMES) {
    if (window.includes(state)) return true;
  }

  if (OUT_OF_STATE_ABBR_RE.test(window)) return true;

  return false;
}

/** Returns the char index of the first city mention in normalised text, or -1. */
function findCityIndex(normalized: string, city: string): number {
  if (city.includes(' ')) return normalized.indexOf(city);
  const match = new RegExp(`\\b${escapeRegExp(city)}\\b`).exec(normalized);
  return match ? match.index : -1;
}

function countCityMentions(normalizedInput: string, city: string): number {
  const re = city.includes(' ')
    ? new RegExp(escapeRegExp(city), 'g')
    : new RegExp(`\\b${escapeRegExp(city)}\\b`, 'g');
  return (normalizedInput.match(re) ?? []).length;
}

function hasLocationSignalNearby(normalizedInput: string, city: string): boolean {
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

function isLikelyPersonName(rawInput: string, city: string): boolean {
  if (city.includes(' ')) return false;
  const personRe = new RegExp(`\\b${escapeRegExp(city)}\\s+[A-Z][a-z]{2,}\\b`);
  return personRe.test(rawInput);
}
