// See TAGGING_SYSTEM.md in the repository root for the full set of
// editorial tagging guidelines (Kentucky/National rules, county
// assignment logic, weather/sports/school tags, etc.).  The algorithms in
// this file attempt to implement those rules automatically during article
// ingestion.
import type { Category, ClassificationResult } from '../types';
import { detectCounty, detectCity, detectKentuckyGeo, HIGH_AMBIGUITY_CITIES, escapeRegExp, textContainsCounty, AMBIGUOUS_COUNTY_NAMES } from './geo';

// lightweight runtime schema guard for AI responses – avoids silent failures
// when the model returns malformed JSON or unexpected field types.  We only
// care about the fields our merging logic reads.
function validateAiResponse(parsed: unknown): parsed is {
  category: string;
  isKentucky: boolean;
  counties?: string[];
  county?: string | null;
} {
  if (!parsed || typeof parsed !== 'object') return false;
  const p = parsed as Record<string, unknown>;
  if (typeof p.category !== 'string') return false;
  if (typeof p.isKentucky !== 'boolean') return false;
  if (p.counties !== undefined && !Array.isArray(p.counties)) return false;
  if (p.county !== undefined && p.county !== null && typeof p.county !== 'string') return false;
  return true;
}
import { KY_COUNTIES } from '../data/ky-geo';

type AiResultLike = {
  response?: string;
  result?: { response?: string };
  output_text?: string;
  choices?: Array<{ message?: { content?: string | null } }>;
};

const VALID_AI_CATEGORIES = new Set<string>(['sports', 'weather', 'schools', 'today', 'national']);

const KY_REGION_TERMS = [
  'eastern kentucky',
  'western kentucky',
  'central kentucky',
  'appalachian kentucky',
] as const;

const KY_CITY_TERMS = [
  'lexington',
  'louisville',
  'frankfort',
  'bowling green',
  'owensboro',
  'covington',
  'pikeville',
  'paducah',
  'ashland',
  'elizabethtown',
  'hopkinsville',
  'richmond',
  'florence',
  'georgetown',
  'nicholasville',
  'jeffersontown',
  'radcliff',
  'madisonville',
  'winchester',
  'erlanger',
] as const;

/**
 * City names that exist in multiple US states. A hit on one of these only counts
 * toward the Kentucky threshold when "Kentucky" or "KY" is also present.
 */
const AMBIGUOUS_CITY_TERMS = new Set<string>([
  'lexington',
  'louisville',
  'georgetown',
  'franklin',
  'winchester',
  'ashland',      // also Ashland, VA / OR
  'covington',    // also Covington, VA / GA / OH
  'richmond',     // also Richmond, VA and many others
  'florence',     // also Florence, AL / SC / OR
  'madisonville', // also Madisonville, TN / TX
]);

/**
 * Greater Cincinnati / NKY regional weather and news articles often mention
 * cities on the Ohio side of the metro.  When this signal is detected we
 * suppress county assignment derived solely from a city match unless an
 * explicit county name appears elsewhere in the text.  (Explicit
 * "X County" phrases should continue to work normally.)
 */
const GREATER_CINCINNATI_RE =
  /\bgreater\s+cincinnati\b|\bcincinnati\s+(?:area|metro|region|market)\b|\bnorthern\s+kentucky\s+(?:and|area|region)\b/i;

// Regional weather phrases that cover most of KY rather than a specific
// county.  When a forecast uses these and the article is categorized as
// weather, we suppress any source-default county so the story shows up
// as statewide rather than belonging to a single county.
const STATEWIDE_WEATHER_RE =
  /\b(?:central\s+and\s+eastern\s+kentucky|across\s+(?:the\s+)?(?:bluegrass|kentucky|central\s+ky|eastern\s+ky)|much\s+of\s+(?:the\s+)?(?:bluegrass|kentucky)|statewide|state-?wide)\b/i;

/**
 * Kentucky county patterns.
 *
 * Supports: "Pike County", "Leslie Co", "Leslie Cnty".
 * For the "Co" abbreviation: `[\\s]` in the template literal becomes the `[\s]`
 * whitespace class in the compiled regex. This ensures "Leslie Co" (space after)
 * and "Leslie Co" (end of string) match, while "oil co report" does not (the
 * county name "oil" isn't in KY_COUNTIES, so it never fires anyway — but the
 * boundary guard prevents hypothetical same-named false positives).
 */
const COUNTY_PATTERNS = KY_COUNTIES.map((county) => ({
  county,
  pattern: new RegExp(
    // include plural "counties" suffix to stay synced with geo.ts
    // allow a forward-slash after the county suffix so phrases like
    // "Barren County/Metcalfe EMS" still match.
    `\\b${escapeRegExp(county)}\\s+(?:county|counties|cnty|co\\.?)(?=[\\s.,)/]|$)`,
    'i',
  ),
}));

const KENTUCKY_OR_KY_RE = /\bkentucky\b|\bky\b/i;
const CLASSIFICATION_LEAD_CHARS = 2200;

type RelevanceTier = 'title' | 'body' | 'national';

export interface RelevanceClassification {
  category: 'kentucky' | 'national';
  tier: RelevanceTier;
  mentionCount: number;
}

interface ClassifierInput {
  url: string;
  title: string;
  content: string;
  rssTitle?: string;
  rssDescription?: string;
}

/**
 * Known source domains whose site-name branding contains "Kentucky" and would
 * otherwise inflate the Kentucky mention count for national articles.
 * Articles from these sources have their brand phrase stripped before classification.
 */
const KY_BRANDED_SOURCES: Array<{ hosts: string[]; stripPattern: RegExp }> = [
  {
    hosts: ['kentuckylantern.com'],
    stripPattern: /\bkentucky\s+lantern\b/gi,
  },
  {
    hosts: ['kentuckytoday.com'],
    stripPattern: /\bkentucky\s+today\b/gi,
  },
  {
    hosts: ['kentuckysportsradio.com', 'ksr.com'],
    stripPattern: /\bkentucky\s+sports\s+radio\b|\bksr\b/gi,
  },
  {
    hosts: ['wbko.com'],
    stripPattern: /\bwbko\b|\bbg\s+news\b/gi,
  },
  {
    hosts: ['wnky.com'],
    stripPattern: /\bwnky\b/gi,
  },
  {
    hosts: ['lanereport.com'],
    stripPattern: /\blane\s+report\b/gi,
  },
  {
    hosts: ['wkyt.com'],
    stripPattern: /\bwkyt\b/gi,
  },
  {
    hosts: ['wymt.com'],
    stripPattern: /\bwymt\b/gi,
  },
  {
    hosts: ['lex18.com'],
    stripPattern: /\blex\s*18\b/gi,
  },
  {
    hosts: ['linknky.com'],
    stripPattern: /\blink\s+nky\b/gi,
  },
  {
    // WTVQ (ABC 36) syndicates national content; strip trailing "- WTVQ" / "- ABC 36" from titles
    hosts: ['wtvq.com'],
    stripPattern: /\bwtvq\b|\babc\s*36\b/gi,
  },
  {
    hosts: ['kentucky.com'],
    // Kentucky.com (Herald-Leader) — strip standalone brand references but not
    // legitimate "Kentucky" usage in article text. We strip only the byline/footer form.
    stripPattern: /\bkentucky\.com\b/gi,
  },
];

/**
 * Domains that are always treated as national news regardless of any
 * Kentucky signals in the text.  These sources should never receive a
 * default county and we ignore KY/location hints unless both the AI and
 * article text provide very strong evidence that the story is actually
 * set in Kentucky (e.g. county mentioned twice plus the word "Kentucky"/"KY").
 */
const ALWAYS_NATIONAL_SOURCES = new Set<string>([
  // foxnews.com — major national conservative news network; content is
  // syndicated nationwide and rarely focused on local Kentucky issues.
  'foxnews.com',

  // cnn.com — global news outlet; treat all articles as national.
  'cnn.com',

  // nbcnews.com — national broadcaster's website, not a local KY source.
  'nbcnews.com',

  // abcnews.go.com — ABC network news, national coverage.
  'abcnews.go.com',

  // cbsnews.com — national news network site.
  'cbsnews.com',

  // apnews.com — Associated Press wire service; stories are by definition
  // national/international rather than local.
  'apnews.com',

  // reuters.com — international wire service.
  'reuters.com',

  // politico.com — national political news.
  'politico.com',

  // thehill.com — national political news site.
  'thehill.com',

  // washingtonpost.com — national newspaper based in DC.
  'washingtonpost.com',

  // nytimes.com — national newspaper with global scope.
  'nytimes.com',

  // wsj.com — Wall Street Journal, national business/newspaper.
  'wsj.com',

  // usatoday.com — national news publication.
  'usatoday.com',

  // newsfromthestates.com — aggregates state-level wire stories; always
  // national in our context.
  'newsfromthestates.com',

  // thoroughbreddailynews.com — horse racing trade publication with national
  // readership; mentions of Kentucky are about the sport, not local news.
  'thoroughbreddailynews.com',

  // cbssports.com — national sports website.
  'cbssports.com',

  // espn.com — major sports network; national coverage.
  'espn.com',

  // bleacherreport.com — national sports news/blog.
  'bleacherreport.com',

  // si.com — Sports Illustrated; national sports coverage.
  'si.com',

  // theathletic.com — subscription sports network covering national leagues.
  'theathletic.com',

  // nbcsports.com — NBC's sports site; national scope.
  'nbcsports.com',


  // wlwt.com — Cincinnati NBC affiliate.  Covers Ohio/NKY border but is not a
  // Kentucky-focused homepage; content is largely Ohio/national.
  'wlwt.com',

  // whas11.com — Louisville ABC affiliate; syndicates AP wire and Indiana
  // stories.  Treat as national since local content is rare.
  'whas11.com',

  // stateline.org — States Newsroom / Stateline; national policy wire covering
  // all 50 states.
  'stateline.org',

  // wtvq.com — Lexington ABC affiliate; heavily syndicates national wire
  // (AP/ABC); genuine KY stories are infrequent.
  // (moved to COUNTY_REQUIRES_EXPLICIT_EVIDENCE so we only assign a county when
  // it is explicitly mentioned in the article text.)

  // wlky.com — Louisville CBS affiliate; heavily syndicates AP wire content.
  // AP datelines (e.g. "LOS ANGELES —") sometimes appear after the scraped
  // lead, so the wire-override regex does not catch them. Adding here ensures
  // national wire stories are not tagged Kentucky due to site-chrome mentions
  // of "Louisville, KY". Genuine Louisville / KY stories are duplicated via
  // other Louisville outlets (WDRB, Courier Journal, Wave3).
  'wlky.com',

  // aginguntold.com — national aging/health news service; stories are set
  // across the US (Charlotte, Atlanta, etc.) and never Kentucky-specific.
  'aginguntold.com',

  // popularmechanics.com — national science and technology magazine;
  // never Kentucky-specific. Sidebar/nav leakage was triggering false KY tags.
  'popularmechanics.com',

  // pbs.org — PBS NewsHour; primarily AP/national wire coverage.
  // Genuine KY-focused PBS stories still pass the strong-text-evidence guard
  // (requires 2+ KY mentions in lead + AI confirmation).
  'pbs.org',
]);

// Wire/national sources where county should only be assigned when
// explicitly evidenced in the article — never from sidebar/nav bleed.
const COUNTY_REQUIRES_EXPLICIT_EVIDENCE = new Set<string>([  // note: pbs.org moved to ALWAYS_NATIONAL_SOURCES
  'publicnewsservice.org',
  'wkms.org',
  'weku.org',
  'wfpl.org',
  // lex18.com syndicates heavy AP/national wire content; county only when
  // explicitly named in the article text (e.g. "Fayette County" or "Lexington, Ky.")
  // This prevents AP wire stories published on lex18 from being tagged Fayette.
  'lex18.com',
  // wtvq.com publishes local KY stories but also injects national wire content.
  // Only assign a county when the article explicitly mentions a county.
  'wtvq.com',
]);


/**
 * Source domain → default Kentucky county.
 * When an article from a hyperlocal KY source has no county detected in the text,
 * this provides a fallback so the county field is never null for known local outlets.
 * Add entries as new sources are ingested. County values must match KY_COUNTIES exactly.
 */
const SOURCE_DEFAULT_COUNTY: Record<string, string | null> = {
  // Eastern Kentucky
  'pikevilledaily.com': 'Pike',
  'dailyindependent.com': 'Greenup',      // Ashland / Greenup area
  'harlanenterprise.com': 'Harlan',
  'harlanenterprise.net': 'Harlan',  // added NET variant

  'thetimestribune.com': 'Floyd',         // Paintsville
  'bdmountaineer.com': 'Breathitt',       // Jackson / Breathitt
  'hazardherald.com': 'Perry',
  'messagenewspaper.com': 'Leslie',       // Hyden
  'newsexpressky.com': 'Letcher',         // Whitesburg area
  'letnews.com': 'Letcher',
  'lccourier.com': 'Lee',
  'kentuckyexplorer.com': 'Knott',
  'jacksontimes.com': 'Breathitt',
  // Central Kentucky
  'kentucky.com': 'Fayette',             // Lexington Herald-Leader
  'kykernel.com': 'Fayette',              // UK student newspaper
  'lex18.com': 'Fayette',   // Lexington ABC affiliate; Fayette when Lexington is in the text (HIGH_AMBIGUITY_CITIES blocks geo detection without a source default)
  'wkyt.com': 'Fayette',
  'wymt.com': 'Perry',
  'jessaminejournalonline.com': 'Jessamine',
  'richmondregister.com': 'Madison',
  'bgdailynews.com': 'Warren',           // Bowling Green
  'wkuherald.com': 'Warren',
  // Lexington ABC affiliate — now in ALWAYS_NATIONAL_SOURCES; wire content dominates
  'wtvq.com': null,
  // Northern Kentucky (multi-county coverage)
  'linknky.com': null,   // NKY multi-county; county only when explicit in text (Florence → Boone, Newport → Campbell, etc.)

  'nkytribune.com': null,   // NKY Tribune covers all of NKY; only assign county when explicitly in text
  'webn.com': 'Kenton',
  'wcpo.com': null,
  // Central Kentucky
  'wbko.com': 'Warren',           // Bowling Green market
  'wnky.com': 'Warren',
  'lanereport.com': null,
  'kentuckyliving.com': null,
  // Eastern Kentucky additions
  'z979.com': 'Floyd',
  'wkicradio.com': 'Harlan',
  'wmdj.com': 'Floyd',
  'wmmt.com': 'Letcher',
  // Western Kentucky
  'paducahsun.com': 'McCracken',
  'murrayledger.com': 'Calloway',
  'mayfield-messenger.com': 'Graves',
  // Louisville Metro
  'wdrb.com': 'Jefferson',
  'wave3.com': 'Jefferson',
  'whas11.com': null, // now in ALWAYS_NATIONAL_SOURCES; wire content only
  'courier-journal.com': 'Jefferson',
  // Northern Kentucky
  'nky.com': 'Kenton',
  // Cincinnati/NKY broadcaster – no single KY county (see FIX 5)
  'wlwt.com': null,  // Cincinnati/NKY broadcaster – no single KY county (see FIX 5)
  'wlky.com': null,   // Louisville CBS affiliate – no single county (covers full Louisville metro)
  'themountaineagle.com': 'Letcher', // Whitesburg newspaper
  'mountain-topmedia.com': 'Perry',   // Mountain Top Media — Hazard/Perry County area

  // State-level sources (no default county — they cover all of KY)
  'kentuckylantern.com': null,
  'kyweathercenter.com': null, // weather site with no county default
  'kentuckytoday.com': null,
  'kentuckysportsradio.com': null,
  'kentuckystatepolice.ky.gov': null, // KSP covers all of KY — no single county default
  'k105.com': 'Pulaski',  // K-105 radio, Somerset / Pulaski County area
  'stateline.org': null,  // national wire — no county default
  'state-journal.com': 'Franklin',  // The State Journal — Frankfort / Franklin County paper
};

/**
 * Brand phrases that should NOT count as "Kentucky" location signals.
 * These are national brand names that contain the word "Kentucky" but refer
 * to a company or product, not the Commonwealth.
 * Each entry is tested as a case-insensitive substring after normalization.
 */
const SOURCE_DEFAULT_IMAGE: Record<string, string> = {
  'kentuckystatepolice.ky.gov': 'https://www.kentuckystatepolice.ky.gov/images/KSP-logo.png',
  'wp.kentuckystatepolice.ky.gov': 'https://www.kentuckystatepolice.ky.gov/images/KSP-logo.png',
};

const KY_HARD_NEGATIVES: RegExp[] = [
  /\bkentucky\s+fried\s+chicken\b/i,
  /\bkfc\b/i,
  /\bkentucky\s+derby\s+industries\b/i,    // unrelated brand (rare)
  /\bkentucky\s+windage\b/i,               // shooting/gun term, not geographic
  /\bwestern\s+kentucky\s+university\b/i,  // WKU in national rankings not KY news
  /\beastern\s+kentucky\s+university\b/i,  // EKU in national context
  /\bnorthern\s+kentucky\s+university\b/i, // NKU in national context
  // KY General Assembly legislator district suffixes: "R-Mount Vernon",
  // "D-Lexington". Blanking these prevents the city from being picked
  // up as a geographic signal. The comma and party letter are preserved
  // so the sentence still reads naturally.
  /,\s*[RD]-[A-Z][a-zA-Z\s-]{2,30}(?=[,;\.\s]|$)/g,
  // Historical event references: "in Louisville, Kentucky, killing" or
  // "in Louisville in 1855" – not a current location signal.
  /\bin\s+(?:louisville|lexington)[,\s]+kentucky[,\s]+(?:killing|in\s+\d{4}|during|when|where\s+a\s+mob)/gi,
];

/**
 * Patterns that strongly indicate a national wire story regardless
 * of source. When these appear in the title or lead content, the
 * source default county is suppressed and the article is treated
 * as national unless it has genuine Kentucky geo signals in the text.
 */
// wire override removed - replaced below
// including a generic out-of-state dateline pattern that catches
// any CITY, ST — or CITY, State — where the state is not "KY"/"Kentucky".
// This prevents local outlets from tagging such wire stories with their
// home county.  Example: "GILBERT, Ariz. —" or "TULSA, Okla. (AP) —".
export const NATIONAL_WIRE_OVERRIDE_RE =
  /(?:\b(?:washington|new\s+york|austin|memphis|louisville(?!\s*,?\s*ky)|jacksonville|columbus(?!\s*,?\s*ohio)|fort\s+worth|el\s+paso|san\s+antonio|san\s+jose|baltimore|milwaukee|albuquerque|tucson|fresno|omaha|richmond,?\s+va|richmond,?\s+virginia|virginia\s+beach|colorado\s+springs|atlanta|charlotte|nashville|chicago|los\s+angeles|houston|dallas|miami|denver|phoenix|seattle|boston|detroit|minneapolis|st\.\s*louis|kansas\s+city|las\s+vegas|san\s+francisco|san\s+diego|portland|sacramento|salt\s+lake\s+city|indianapolis|cleveland|pittsburgh|raleigh|jackson,?\s+miss|montgomery,?\s+ala|tallahassee|little\s+rock|oklahoma\s+city|baton\s+rouge|new\s+orleans)\s*(?:,\s*[a-z]{2,6}\.?\s*)?(?:\([^)]{1,30}\)\s*)?[-—–]\s*|\b(?:ap|reuters|afp)\s*[-—–]\s*|\bthe\s+associated\s+press\s*[-—–]|\bnbc\s+news\s*[-—–]|\bcnn\s*[-—–]|\babc\s+news\s*[-—–]|\bcbs\s+news\s*[-—–]|\bfox\s+news\s*[-—–]|\bdubai\s*[-—–]\s*united\s+arab|\bfrom\s+(?:new\s+york|washington|london|dubai|tel\s+aviv|jerusalem|paris|berlin|beijing|moscow|tokyo)|\bthe\s+associated\s+press\s+(?:reported|contributed|report)\b|\btold\s+the\s+associated\s+press\b|\baccording\s+to\s+the\s+associated\s+press\b|\bwire\s+service\b|\(anf(?:\/gray\s+news)?\)\s*[-—–]?\s*|\([^)]*gray\s+news[^)]*\)\s*[-—–]?\s*|\(investigatetv\)\s*[-—–]?\s*|\(gray\s+television\)\s*[-—–]?\s*|\(nexstar\s+media\s+wire\)\s*[-—–]?\s*|\(cnn\s+newsource\)\s*[-—–]?\s*|(?:^|\n|\.\s+)[A-Z][A-Za-z\s]{1,25},\s*(?!ky\b|kentucky\b)[a-z]{2,}\.?\s*(?:\([^)]{1,30}\)\s*)?[-—–]\s*|(?:^|\n|\.\s+)[A-Z][A-Z\s]{1,25},\s*(?:United Arab Emirates|Afghanistan|Albania|Algeria|Argentina|Australia|Austria|Azerbaijan|Bahrain|Bangladesh|Belarus|Belgium|Bolivia|Bosnia|Brazil|Cambodia|Canada|Chile|China|Colombia|Croatia|Cuba|Cyprus|Denmark|Ecuador|Egypt|Ethiopia|Finland|France|Germany|Ghana|Greece|Guatemala|Haiti|Honduras|Hungary|India|Indonesia|Iran|Iraq|Ireland|Israel|Italy|Jamaica|Japan|Jordan|Kazakhstan|Kenya|Kuwait|Lebanon|Libya|Malaysia|Mali|Mexico|Moldova|Morocco|Myanmar|Nepal|Netherlands|New Zealand|Nicaragua|Nigeria|North Korea|Norway|Oman|Pakistan|Palestine|Panama|Paraguay|Peru|Philippines|Poland|Portugal|Qatar|Romania|Russia|Saudi Arabia|Senegal|Serbia|Somalia|South Africa|South Korea|Spain|Sri Lanka|Sudan|Sweden|Switzerland|Syria|Taiwan|Tanzania|Thailand|Tunisia|Turkey|Uganda|Ukraine|United Kingdom|Uruguay|Venezuela|Vietnam|Yemen|Zimbabwe)\s*)/i;


/**
 * Patterns indicating Kentucky is mentioned only as a politician's
 * home state, not as the geographic subject of the article.
 * "Rep. X, R-Ky." or "Sen. X, D-Ky." — the state abbreviation
 * follows a congressional title and party affiliation.
 */
const KY_POLITICIAN_MENTION_RE =
  /\b(?:rep(?:resentative)?|sen(?:ator)?)\b[^.]{1,60}\bR(?:ep)?\.?-Ky\b|\bKentucky\s+(?:Republican|Democrat|lawmaker|congressman|congresswoman|senator|representative)\b/i;

/**
 * Keywords that signal betting/odds/gambling content. These articles are
 * non‑summarizable and should be treated as national regardless of any
 * team names or source defaults.
 */
export const BETTING_CONTENT_RE =
  /\b(?:spread|over\/under|money\s*line|sportsbook|promo\s*code|SportsLine|DraftKings|FanDuel|BetMGM|betting\s+(?:line|odds|pick|advice))\b/i;

/**
 * Returns true when the article is a statewide Kentucky political
 * roundup covering multiple legislators from different districts.
 * In this case the source default county should not be applied —
 * the story belongs to all of Kentucky, not just the outlet's home.
 */
export function isStatewideKyPoliticalStory(text: string): boolean {
  // Multi-city event listings spanning multiple KY regions are statewide.
  // Detect when 4+ distinct KY cities from different counties appear — this
  // is a roundup article covering all of Kentucky, not a single-county story.
  // Example: Women's History Month events in Lexington, Covington, Florence,
  // Dayton, Fort Thomas, Maysville, Williamstown etc.
  const kyMultiCityRe = /\b(?:lexington|louisville|covington|newport|florence|fort thomas|dayton|maysville|williamstown|erlanger|independence|richmond|frankfort|owensboro|paducah|bowling green|somerset|london|hazard|pikeville|ashland|morehead|corbin|glasgow|elizabethtown|hopkinsville|murray|berea|winchester|danville|nicholasville|georgetown|shelbyville|bardstown|harrodsburg|versailles|lawrenceburg|campbellsville|mount sterling|prestonsburg|paintsville|corbin|middlesboro)\b/gi;
  const kyMultiCityMatches = new Set((text.match(kyMultiCityRe) ?? []).map(c => c.toLowerCase()));
  if (kyMultiCityMatches.size >= 4) return true;

  // FRANKFORT dateline = statewide KY story ONLY when combined with political/legislative signals.
  // A pure Frankfort dateline on a schools/sports/business story should NOT suppress the county.
  const hasFrankfortDateline = /\bfrankfort,?\s*ky\.?\s*[-—–(]/i.test(text);
  const hasPoliticalSignal = /\b(?:governor|legislature|lawmakers?|legislators?|general\s+assembly|state\s+(?:house|senate|budget|government|agency|department)|house\s+bill|senate\s+bill|rep\.|senator|legislation|policy|bill\s+would|signed\s+into\s+law|executive\s+order|state\s+budget|fiscal\s+year|appropriat|attorney\s+general|court\s+of\s+appeals|circuit\s+court|supreme\s+court|parole\s+board|statewide|across\s+(?:the\s+)?kentucky|across\s+(?:the\s+)?state|all\s+(?:of\s+)?kentucky|kentucky\s+(?:agencies|organizations|counties|communities|residents|families|children)|state\s+(?:funding|grant|award|contract|program|initiative|board|commission|office|law|statute|regulation)|state-?wide|cabinet\s+for|department\s+of)\b/i.test(text);
  if (hasFrankfortDateline && hasPoliticalSignal) return true;
  // Explicit roundup language
  if (/\bwhat\s+kentuckians?\s+said\b|\bkentucky\s+(?:lawmakers?|delegation|legislators?|congressional\s+(?:delegation|members?))\b|\breactions?\s+from\s+kentucky\b/i.test(text)) {
    return true;
  }
  // detect three or more distinct legislative districts
  const districtMatches = text.match(/\b\d+(?:st|nd|rd|th)\s+District\b/gi) || [];
  const uniqueDistricts = new Set(districtMatches.map((m) => m.toLowerCase()));
  if (uniqueDistricts.size >= 3) return true;

  // bills plus Frankfort/statewide context
  if (/\b(?:House|Senate)\s+Bill\b/i.test(text)) {
    if (/\bfrankfort\b|\bstatewide\b|\ball\s+of\s+kentucky\b/i.test(text)) {
      return true;
    }
    // A bill before a committee is statewide legislation regardless of reporter's dateline
    if (/\b(?:Judiciary|Education|Appropriations|Agriculture|Budget|Health|Labor|Revenue|Rules|Veterans|Transportation|Banking|Insurance)\s+Committee\b/i.test(text)) {
      return true;
    }
    // A statewide bill reported from a local market (e.g. WBKO in Bowling Green)
    if (/\b(?:louisville|lexington)\s+lawmaker\b|\brep\.\s+\w+\s+\w+,?\s+(?:D|R)-\d+\b/i.test(text) &&
        /\bkentucky\s+(?:averages?|families|children|residents|landlord|evict|housing)\b/i.test(text)) {
      return true;
    }
  }

  // Detect when both a KY senator AND a KY representative are named — statewide political coverage.
  // Allow either order: "U.S. Rep. X" near "Kentucky" OR "Kentucky ... U.S. Rep. X"
  const hasKySenator =
    /\b(?:kentucky\s+sen(?:ator)?|u\.s\.\s+sen\.\s+[A-Z][^.]{0,60}(?:kentucky|ky\b)|(?:kentucky|ky)[^.]{0,60}u\.s\.\s+sen\.|sen\.\s+\w+\s+\w+[^.]{0,20}(?:r|d)-ky|retiring\s+u\.s\.\s+sen\.|u\.s\.\s+sen\.)\b/i.test(text);
  const hasKyRep =
    /\b(?:kentucky\s+rep(?:resentative)?|u\.s\.\s+rep\.\s+[A-Z][^.]{0,60}(?:kentucky|ky\b)|(?:kentucky|ky)[^.]{0,60}u\.s\.\s+rep\.|rep\.\s+\w+\s+\w+[^.]{0,20}(?:r|d)-ky|u\.s\.\s+rep\.)\b/i.test(text);
  if (hasKySenator && hasKyRep) return true;

  // Detect KY Congressional district race coverage — any article naming a specific
  // Congressional district race with an endorsement or candidate mention is statewide.
  if (/\b(?:congressional\s+district|u\.s\.\s+(?:house|senate)\s+(?:race|seat|primary|candidate)|congress(?:ional)?\s+(?:race|seat|primary)|senate\s+race|house\s+seat)\b/i.test(text) &&
      /\b(?:kentucky|ky\.?)\b/i.test(text)) {
    return true;
  }

  return false;
}

/**
 * AI-powered classification using GLM-4.7-Flash.
 * Reads the article title and content to determine category, Kentucky presence,
 * and county. Falls back to keyword-based classifyArticle if AI fails.
 */
export async function classifyArticleWithAi(
  env: Env,
  input: ClassifierInput,
): Promise<ClassificationResult> {
  const title = normalizeTitleForSource((input.title || '').trim(), input.url);
  const content = normalizeContentForSource((input.content || '').trim(), input.url);

  // Strip hard-negative brand phrases from the classification text so they don't
  // inflate the Kentucky mention count. We blank them rather than delete so
  // surrounding context words are preserved.
  const cleanTitle = stripHardNegatives(title);
  const cleanContent = stripHardNegatives(content);

  const relevance = classifyArticle(cleanTitle, cleanContent);

  const semanticText = `${cleanTitle}\n${cleanContent}`;
  const semanticLeadText = `${cleanTitle}\n${cleanContent.slice(0, CLASSIFICATION_LEAD_CHARS)}`;
  const semanticCategory = detectSemanticCategory(semanticLeadText);

  const hasKhsaa = /\bkhsaa\b/i.test(semanticLeadText);
  const isKySchoolsSource = isKySchoolsDomain(input.url);

  // detect obvious national cues (word "national", "federal", US, etc.) so we
  // can apply a separate flag independent of Kentucky relevance.
  const nationalSignal = /\bnational\b|\bfederal\b|\bunited states\b|\bu\.s\.\s+(?:government|congress|senate|house|military|federal|supreme court|president|department|agency|law|policy|court)\b|\b(?:congress|senate|white house|pentagon|supreme court|federal government|biden|trump|president)\b|\bdepartment\s+of\s+defense\b|\bair\s+force\s+base\b|\bair\s+(?:national\s+guard|refueling\s+wing)\b|\b(?:army|navy|marines?|air\s+force|coast\s+guard|national\s+guard)\s+(?:base|post|installation|station)\b|\b(?:airmen?|soldiers?|sailors?|marines?|service\s+members?)\s+killed\b|\boperation\s+\w+/i.test(semanticLeadText);

  // hostname for source-specific overrides (always national, default county)
  const hostname = (() => {
    try { return new URL(input.url).hostname.replace(/^www\./, ''); }
    catch { return ''; }
  })();
  const isAlwaysNational = ALWAYS_NATIONAL_SOURCES.has(hostname);

  let sourceDefaultCounty = getSourceDefaultCounty(input.url);
  if (isAlwaysNational) {
    // explicit override: ignore any default county for known national outlets
    sourceDefaultCounty = null;
  }

  // Suppress source default county for national wire stories.
  // Local TV stations syndicate AP/NBC/etc content; the dateline
  // or byline pattern reveals these are not local stories.
  const isNationalWireStory =
    NATIONAL_WIRE_OVERRIDE_RE.test(semanticLeadText);


  const isStatewideKyPolitics =
    isStatewideKyPoliticalStory(semanticLeadText);

  const isStatewideKyWeather =
    STATEWIDE_WEATHER_RE.test(semanticLeadText) &&
    (semanticCategory === 'weather' ||
      CATEGORY_PATTERNS.weather.some((p) => p.test(semanticLeadText)));

  const effectiveSourceDefaultCounty =
    isNationalWireStory ||
    isStatewideKyPolitics ||
    (isStatewideKyWeather && semanticCategory === 'weather')
      ? null
      : sourceDefaultCounty;

  // When statewide KY politics is detected we must ignore any source-default
  // county even if the dateline city appears elsewhere in the text.  The
  // reporter's location (e.g. Bowling Green) is irrelevant to the story's
  // geographic subject (Frankfort/seat of government).  effectiveSourceDefaultCounty
  // already becomes null in that case, but downstream merge logic also used
  // this value directly.  Use a separate variable to make intent explicit.
  let allowedSourceDefaultCounty = isStatewideKyPolitics ? null : effectiveSourceDefaultCounty;

  // Detect any explicit KY signals in the text (e.g. "Kentucky", "Ky.",
  // county/city names, etc.). This prevents a source-default county from
  // forcing a Kentucky classification on world-wire stories (e.g. AP/Reuters)
  // that happen to appear on a Kentucky outlet.
  const detectedKyGeo = detectKentuckyGeo(semanticText);

  // Determine whether this article should be treated as Kentucky. We rely on
  // actual KY signals in the text rather than just the source's default county.
  const baseIsKentucky =
    (relevance.category === 'kentucky' || hasKhsaa || detectedKyGeo.isKentucky) &&
    !isAlwaysNational;

  // County/city detection pipeline (issue #6):
  // 1. If the article text contains a county name, detectCounty returns it.
  // 2. If no county, detectCity looks for a KY city and maps it to a county
  //    via the reference data; the returned `city` is stored regardless.
  // 3. If a city maps to multiple counties we'd need additional disambiguation
  //    (not implemented here) or tag all; for now mapping is one-to-one.
  // 4. If a city is not found in the lookup, we keep county=null and do NOT
  //    fall back to a source default — per spec we must not invent a county.
  // 5. Only after steps 1–4 fail AND the article is confirmed Kentucky do we
  //    consider using the source default county.  This prevents misleading
  //    tags when text already contains geo information.
  // derive geography from the text.  If the article is statewide politics
  // we will later discard any city/county detected here, since the dateline
  // simply reflects the reporter's base, not the story subject.
  let baseGeo = baseIsKentucky
    ? detectedKyGeo
    : { isKentucky: false, county: null, counties: [], city: null };

  // Honour explicit "COUNTY NAME, Ky." dateline at the very start of the article.
  // This catches all-caps datelines like "OHIO COUNTY, Ky." that may be missed by
  // the geo detector's word-boundary patterns when the text is fully uppercase.
  const dateline_county_match = semanticLeadText.match(
    /^([A-Z][A-Za-z\s]{2,20})\s+COUNTY\s*,\s*Ky\b/i
  );
  if (dateline_county_match) {
    const datelineCounty = dateline_county_match[1].trim();
    const normalizedDatelineCounty = KY_COUNTIES.find(
      (c) => c.toLowerCase() === datelineCounty.toLowerCase()
    );
    if (normalizedDatelineCounty) {
      // Dateline county is authoritative — it is the story's explicit location.
      // Reset baseGeo counties to ONLY the dateline county so that nav/sidebar
      // bleed counties (picked up from Readability-extracted related-article links)
      // do not survive into effectiveGeoCounties or the AI high-confidence guard.
      // Any genuinely mentioned secondary counties will be re-added by the AI
      // classifier if they pass isCountyEvidenced with explicit "County" evidence.
      baseGeo = {
        ...baseGeo,
        county: normalizedDatelineCounty,
        counties: [normalizedDatelineCounty],
      };
    }
  }

  // FIX 3: When statewide KY political story is detected, clear out any
  // county or city that the geo detector may have inferred (e.g. a
  // "Bowling Green, Ky." dateline on a Frankfort legislative roundup).
  // The county should remain null regardless of dateline evidence.
  if (isStatewideKyPolitics) {
    baseGeo = { ...baseGeo, county: null, counties: [], city: null };
  }

  // If the article is explicitly about an Indiana location, suppress county
  // assignment even if a KY-matching county name appears in the text.  This
  // handles stories where Floyd County, Indiana (bordering Louisville) is
  // mentioned; without the guard the geo detector will accidentally tag the
  // story as Floyd County, KY because the dateline or other nearby text often
  // contains "Louisville, Ky.".
  let isIndianaStory = /\b(?:southern\s+indiana|indiana\s+law\s+enforcement|indiana\s+state\s+police|greenville,?\s*(?:indiana|ind\.?)|new\s+albany,?\s*(?:indiana|ind\.?)|jeffersonville,?\s*(?:indiana|ind\.?)|clarksville,?\s*(?:indiana|ind\.?)|sellersburg,?\s*(?:indiana|ind\.?)|charlestown,?\s*(?:indiana|ind\.?)|\bInd\.?\s*\(WDRB\)|\bInd\.?\s*[-—–]|\bIND\.?\s*[-—–]|,\s*Ind\.?\s*[-—–])\b/i.test(semanticLeadText);
  // additional heuristic checks not covered by the single regex above
  if (!isIndianaStory && /\bfloyd\s+county\s+sheriff\b/i.test(semanticLeadText)) {
    isIndianaStory = true;
  }
  if (!isIndianaStory && /\bgeorgetown[-\s]+greenville\s+road\b/i.test(semanticLeadText)) {
    isIndianaStory = true;
  }
  if (!isIndianaStory && /\bgreenville,\s+indiana\b/i.test(semanticLeadText)) {
    isIndianaStory = true;
  }
  if (isIndianaStory && !isAlwaysNational) {
    if (baseGeo.county && !COUNTY_PATTERNS.some(p =>
      p.county === baseGeo.county &&
      /\bkentucky\b|\bky\b/i.test(semanticText.slice(
        Math.max(0, semanticText.toLowerCase().indexOf(p.county.toLowerCase()) - 100),
        semanticText.toLowerCase().indexOf(p.county.toLowerCase()) + 100
      ))
    )) {
      baseGeo = { ...baseGeo, county: null, counties: [], city: null };
    }
    // Also suppress the source default county so a WDRB/Louisville dateline
    // on an Indiana story can't assign Jefferson County via city evidence.
    // The story is happening in Indiana; the reporter's base is irrelevant.
    sourceDefaultCounty = null;
    // Must also null out allowedSourceDefaultCounty: it was derived before this
    // Indiana check ran, so its value (e.g. 'Jefferson' for wdrb.com) would
    // otherwise leak through to every downstream county-assignment expression.
    allowedSourceDefaultCounty = null;
  }

  let category: Category = semanticCategory ?? (baseIsKentucky ? 'today' : 'national');

  // Betting odds articles are national content regardless of teams mentioned.
  // "Kentucky vs. Vanderbilt odds" is a gambling article, not local sports news.
  if (BETTING_CONTENT_RE.test(semanticLeadText)) {
    category = 'national';
    // Also suppress Kentucky flag — mentioning a KY team in odds context
    // does not make it a Kentucky local story.
    // Do NOT set baseIsKentucky = false here; let the fallback handle it
    // after the AI pass, so the geo detector result is not discarded.
  }

  // For wire/national sources (pbs.org, wkms.org, etc.) where Readability bleed
  // can inject county names from sidebar links into the classification text, filter
  // baseGeo counties to only those with an explicit "X County" mention in the text.
  // This prevents sidebar-sourced counties from becoming the primary geo assignment
  // via the fallback (effectiveGeoCounty) path rather than just the AI path.
  if (COUNTY_REQUIRES_EXPLICIT_EVIDENCE.has(hostname)) {
    const filteredCounties = (baseGeo.counties || []).filter((c) =>
      new RegExp(`\\b${escapeRegExp(c)}\\s+County\\b`, 'i').test(semanticText)
    );
    const filteredPrimary = filteredCounties[0] ?? null;
    baseGeo = { ...baseGeo, county: filteredPrimary, counties: filteredCounties };
  }

  // FIX 5 (continued): evaluate whether the detected county is supported by
  // an explicit mention in the article text.  If not, drop it so that a
  // source default county (if present) can survive.
  const hasExplicitCountyMention = baseGeo.county
    ? COUNTY_PATTERNS.some(
        (p) => p.county === baseGeo.county && p.pattern.test(semanticText)
      )
    : false;

  const effectiveGeoCounty = hasExplicitCountyMention ? baseGeo.county : null;
  const effectiveGeoCounties = hasExplicitCountyMention ? (baseGeo.counties || []) : [];

  // determine how confident we are in the county assignment based on text
  // signals.  This value travels through the AI merge step unchanged so
  // downstream UI components can highlight low-confidence results.
  const geoConfidence: ClassificationResult['geoConfidence'] =
    hasExplicitCountyMention
      ? 'high'
      : baseGeo.city && !HIGH_AMBIGUITY_CITIES.has(baseGeo.city.toLowerCase())
        ? 'medium'
        : baseGeo.city && HIGH_AMBIGUITY_CITIES.has(baseGeo.city.toLowerCase())
          ? 'low'
          : null;

  // District-owned *.kyschools.us domains should generally be treated as
  // school-related stories unless the semantic classifier already identified a
  // more specific category (sports/weather/etc).  Previously we only forced
  // "schools" when the category was national, but expanding baseIsKentucky
  // caused such articles to fall into the "today" bucket instead, bypassing
  // this rule.  Now convert both national and today defaults to schools.
  if (isKySchoolsSource && (category === 'national' || category === 'today')) {
    category = 'schools';
  }

  if (category === 'sports' && !baseIsKentucky && !hasKhsaa && !isKySchoolsSource) {
    category = 'national';
  }

  // Louisville Cardinals / UofL sports: Louisville is in AMBIGUOUS_CITY_TERMS so it
  // doesn't trigger KY by itself. But "Louisville" + any sports keyword is a reliable
  // KY sports signal — UofL is unambiguously a Kentucky institution.
  if (!baseIsKentucky && category === 'sports' && /\b(louisville|uofl|u of l|cardinals)\b/i.test(semanticLeadText)) {
    category = 'sports';
    // Will be corrected to national below if we can't confirm KY — but first
    // treat Louisville sports as a KY signal and let the merge handle it.
  }
  const louisvilleSportsSignal =
    /\b(louisville|uofl|u of l)\b/i.test(semanticLeadText) &&
    detectSemanticCategory(semanticLeadText) === 'sports';

  // build the initial fallback result using keyword heuristics and the
  // earlier baseGeo detection.  Do not apply the source default county if any
  // county or city was already detected — the text-derived geography always
  // takes precedence (issue #1).
  let fallback: ClassificationResult = {
    isKentucky: baseIsKentucky || louisvilleSportsSignal || isKySchoolsSource,
    county:
      effectiveGeoCounty ??
      (
        (
          !baseGeo.city ||
          // A city in HIGH_AMBIGUITY_CITIES never produced a county assignment;
          // allow the source default county to fill in when such a city was detected.
          HIGH_AMBIGUITY_CITIES.has((baseGeo.city || '').toLowerCase())
        ) &&
        (baseIsKentucky || louisvilleSportsSignal || isKySchoolsSource)
          ? allowedSourceDefaultCounty
          : null
      ),
    counties: effectiveGeoCounties ? [...effectiveGeoCounties] : [],
    city: baseGeo.city,
    category: hasKhsaa ? 'sports' : category,
    isNational: false, // will populate after we know isKentucky
    geoConfidence,
  };
  // if we had no counties but have a primary county fallback, ensure array
  if (fallback.county && fallback.counties.length === 0) {
    fallback.counties = [fallback.county];
  }

  // suppress city-derived counties for Greater Cincinnati / Northern
  // Kentucky regional articles unless an explicit "X County" is present.
  const isGreaterCincinnatiArticle = GREATER_CINCINNATI_RE.test(semanticLeadText);
  if (
    isGreaterCincinnatiArticle &&
    fallback.county &&
    fallback.city &&
    // patterns list covers all explicit county name forms, mirroring geo.ts
    !COUNTY_PATTERNS.some((p) => p.pattern.test(semanticText))
  ) {
    fallback.county = null;
    fallback.counties = [];
  }

  // A Kentucky politician mention in a national wire story is not
  // sufficient to override the national wire classification.  Only treat it
  // as a Kentucky signal when there is no national wire dateline present.
  const hasOnlyPoliticianKyMention =
    KY_POLITICIAN_MENTION_RE.test(semanticText) &&
    !baseGeo.county &&
    baseGeo.counties.length === 0 &&
    !baseGeo.city;

  // A story with a non-KY dateline (e.g. "WASHINGTON (Gray DC) —") is national
  // even when the president/official travels to Kentucky or KY places are mentioned
  // in the body.  The dateline city is authoritative for where the story originates.
  // We detect this by checking whether the wire-override match was triggered by a
  // specific non-KY city rather than a wire-service tag (AP, Reuters, Gray News, etc.).
  const NON_KY_DATELINE_RE =
    /(?:^|\n|\.\s+)WASHINGTON\s*(?:\([^)]{1,40}\))?\s*[-—–]|(?:^|\n|\.\s+)[A-Z][A-Za-z\s]{1,25},\s*(?!ky\b|kentucky\b)[a-z]{2,}\.?\s*(?:\([^)]{1,30}\)\s*)?[-—–]/i;
  const hasNonKyDateline = NON_KY_DATELINE_RE.test(semanticLeadText);

  if (isNationalWireStory && (hasOnlyPoliticianKyMention || hasNonKyDateline)) {
    // Override: treat as national despite KY mentions in the body.
    // A presidential trip that stops in KY is still a national story filed from DC.
    fallback.isKentucky = false;
    fallback.county = null;
    fallback.counties = [];
  }

  // attach national flag based on preliminary cues and ky status
  fallback.isNational = nationalSignal || !fallback.isKentucky;

  // Re-apply sports guard now that Louisville signal may have changed isKentucky.
  if (fallback.category === 'sports' && !fallback.isKentucky && !hasKhsaa && !isKySchoolsSource) {
    fallback.category = 'national';
  }
  fallback.category = enforceCategoryEvidence(
    normalizeCategoryForKentuckyScope(fallback.category, fallback.isKentucky),
    cleanTitle,
    semanticLeadText,
    fallback.isKentucky,
    isKySchoolsSource,
  );

  // District-owned *.kyschools.us domains are authoritative for schools context.
  // Avoid slow/unstable AI calls for these sources.
  if (isKySchoolsSource) {
    return fallback;
  }

  if (isNationalWireStory || !shouldUseAiFallback(cleanTitle, cleanContent, fallback)) {
    return fallback;
  }

  try {
    const countyList = KY_COUNTIES.join(', '); // full list — model context is large enough
    const prompt = [
      'You are a news classifier for a Kentucky local news app.',
      'Analyze the article title and first 1200 characters of content below.',
      'Important: Ignore publisher/site branding (e.g. "Kentucky Lantern", "Kentucky Today") when deciding Kentucky relevance.',
      '',
      'Task: Return a JSON object with three fields:',
      '  "category" - one of: "sports", "weather", "schools", "today", "national"',
      '    sports     = article is PRIMARILY about sports games, teams, athletes, or tournaments',
      '    weather    = article is PRIMARILY about weather forecasts, storms, floods, or temperatures',
      '    schools    = article is PRIMARILY about schools, education, school boards, or campus events',
      '    today      = article mentions Kentucky or KY but does not fit sports/weather/schools.  This includes stories about Kentucky legislation or government action (state bills, county government decisions, courts, jails, law enforcement funding, etc.).',
      '    national   = article does NOT primarily concern Kentucky AND does not fit the above categories',
      '  "isKentucky" - true ONLY if the article is primarily about events, people, or places IN Kentucky.',
      '    Return false if:',
      '      - Kentucky is only mentioned once in passing (e.g. in a list of states)',
      '      - The story is primarily set in another state that happens to mention KY',
      '      - The only Kentucky reference is a brand name (KFC, Western Kentucky University rankings, etc.)',
      '      - A county name appears but that county is clearly in another state',
      '    DO NOT count publisher names/branding as location signals.',
      '  "counties" - an array of Kentucky county names that are prominently featured',
      '                in the article AND where the story is set in Kentucky.',
      '                Return the most relevant county first (primary).',
      '                Each county must be one of the official 120 Kentucky counties listed below.',
      '                If no Kentucky county is clearly identified, return an empty array.',
      '                Example: ["Fayette", "Clark"] for an article set in both Lexington and Winchester KY.',
      '                IMPORTANT: Return counties where the story is set. ALSO return the county for',
      '                any Kentucky city explicitly named as a person\'s hometown when that person is',
      '                the central subject of the story (e.g., a Kentucky native killed in a military',
      '                crash overseas, a local resident charged in a federal case).',
      '                Do NOT return a county just because a coach, athlete, or official has a surname',
      '                matching a county name (e.g. "Johnson", "Martin", "Clark" as person surnames).',
      '                Do NOT return a county just because a school\'s full name contains a county name',
      '                unless the story is actually set in or about that county.',
      '                Example: ["Perry"] for an article set only in Hazard.',
      '                Example: [] if no county is identifiable.',
      `  All 120 KY counties: ${countyList}`,      '',
      'Rules:',
      '  - Respond with ONLY valid JSON. No markdown, no code fences, no extra text.',
      '  - Example: {"category":"today","isKentucky":true,"counties":["Fayette"]}',
      '  - Example: "Kentucky House Bill 557 could shift jail reimbursement costs from counties to state" → isKentucky: true, county: "Warren", category: "today"',
      '',
      `Title: ${cleanTitle}`,
      '',
      // Use only the first 800 chars for county classification — nav/sidebar bleed
      // (related-article links with county names) typically starts after the article lede.
      `Content: ${cleanContent.slice(0, 800)}`,
    ].join('\n');

    const aiRaw = (await env.AI.run('@cf/zai-org/glm-4.7-flash' as keyof AiModels, {
      messages: [
        { role: 'system', content: 'You are a precise news article classifier. Always respond with only valid JSON.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0,
      max_completion_tokens: 128,
    })) as AiResultLike;

    const aiText = (
      aiRaw?.response ??
      aiRaw?.result?.response ??
      aiRaw?.output_text ??
      aiRaw?.choices?.[0]?.message?.content ??
      ''
    ).trim().replace(/```json|```/gi, '').trim();

    let parsed: unknown;
    try {
      parsed = JSON.parse(aiText);
    } catch {
      console.warn('[AI CLASSIFY] JSON parse failed, using fallback');
      return fallback;
    }
    if (!validateAiResponse(parsed)) {
      console.warn('[AI CLASSIFY] Response failed schema validation:', aiText.slice(0, 200));
      return fallback;
    }

    // At this point `parsed` conforms to the expected shape
    const safe = parsed;
    const aiCategory = VALID_AI_CATEGORIES.has(safe.category ?? '') ? (safe.category as Category) : null;
    const aiIsKentucky = safe.isKentucky;

    // build normalized list of counties from the AI output (respect either
    // an array or a singular "county" field for backward compatibility)
    const aiCountiesRaw: string[] = Array.isArray(safe.counties)
      ? safe.counties
      : safe.county ? [safe.county] : [];
    let aiCounties = aiCountiesRaw
      .map((c) => normalizeCountyName(c))
      .filter((c): c is string => !!c);

    // Validate AI-suggested counties against actual text evidence.  Any
    // county that isn't present literally in the semantic text and wasn't
    // already found by the geo detector is discarded unless it matches the
    // trusted source default.  If the primary county is rejected we fall
    // back to the geo detector result to avoid leaving a spurious value.
    if (!isCountyEvidenced(aiCounties[0] ?? null, semanticText, baseGeo.counties, allowedSourceDefaultCounty)) {
      // AI hallucinated a primary county
      aiCounties = baseGeo.counties.length > 0 ? [...baseGeo.counties] : [];
    }
    // Filter the rest of the array as well
    aiCounties = aiCounties.filter((c) =>
      isCountyEvidenced(c, semanticText, baseGeo.counties, allowedSourceDefaultCounty),
    );

    // Extra guard: when the geo detector found a county with high confidence
    // (explicit "X County, Ky." dateline or unambiguous county mention), only
    // retain AI-suggested counties that the geo detector ALSO found, OR that
    // have an explicit "County" suffix in the text.  This prevents AI counties
    // sourced from Readability-bleed nav/sidebar links from surviving the filter
    // (e.g. a WYMT article about Perry County that has "Christian County" and
    // "Lewis County" in its sidebar navigation).
    if (geoConfidence === 'high' && baseGeo.counties.length > 0) {
      aiCounties = aiCounties.filter((c) => {
        if (baseGeo.counties.some((g) => g.toLowerCase() === c.toLowerCase())) return true;
        // require explicit "County" suffix in the text for any county not found by geo
        return new RegExp(`\\b${escapeRegExp(c)}\\s+County\\b`, 'i').test(semanticText);
      });
      // ensure the geo-detected primary county is always represented
      if (aiCounties.length === 0 && baseGeo.counties.length > 0) {
        aiCounties = [...baseGeo.counties];
      }
    }

    // For wire/national sources (PBS, WKMS, etc.) where Readability may not fully
    // strip sidebars: require every AI-suggested county to have an explicit
    // "County" mention in the text OR be found by the geo detector.  This stops
    // sidebar-bleed counties (e.g. "Fayette County" from a PBS related-article link)
    // from being assigned to articles whose only KY connection is the story subject.
    if (COUNTY_REQUIRES_EXPLICIT_EVIDENCE.has(hostname)) {
      aiCounties = aiCounties.filter((c) => {
        if (baseGeo.counties.some((g) => g.toLowerCase() === c.toLowerCase())) return true;
        return new RegExp(`\\b${escapeRegExp(c)}\\s+County\\b`, 'i').test(semanticText);
      });
      if (aiCounties.length === 0 && baseGeo.counties.length > 0) {
        aiCounties = [...baseGeo.counties];
      }
    }

    const aiCounty = aiCounties[0] ?? null;

    // Always compute the geo signal from the text. This allows us to
    // prevent AI hallucinations from turning a non-Kentucky wire story into
    // a Kentucky one just because the source is KY-based.
    const aiGeo = detectKentuckyGeo(`${cleanTitle}\n${cleanContent}`);
    const mergedIsKentucky =
      fallback.isKentucky ||
      (aiIsKentucky && aiGeo.isKentucky) ||
      isKySchoolsSource;

    let mergedCategory = fallback.category;
    if (fallback.category === 'national' && aiCategory && aiCategory !== 'national') {
      mergedCategory = aiCategory;
    }

    if (isKySchoolsSource && mergedCategory === 'national') {
      mergedCategory = 'schools';
    }

    if (mergedCategory === 'sports' && !mergedIsKentucky && !hasKhsaa && !isKySchoolsSource) {
      mergedCategory = 'national';
    }

    // If the AI explicitly returns isKentucky: false (i.e. the field was present in the
    // response, not just omitted), discard any county the fallback heuristic may have
    // wrongly assigned — e.g. "Adair" from detecting "columbia" in a UK basketball article
    // set in Columbia, SC.  The ?? chain below is only used when AI did not reject KY.
    // determine whether any geo info has already been inferred (county or city)
    const hadGeo = Boolean(
      fallback.county ||
      fallback.city ||
      aiCounty ||
      aiGeo.county ||
      aiGeo.city,
    );

    // Merge county results, applying several heuristics.
    // For Kentucky schools sources we trust whatever geography we have
    // (fallback/AI/geo/default). For all other stories we must also respect
    // the statewide-KY-politics flag: no county should survive that
    // override regardless of what the geo detector or the AI returned.
    //
    // NOTE: earlier in the pipeline we clear baseGeo when
    // isStatewideKyPolitics is true, but the merge step must still guard
    // against counties inferred later (fallback, AI, or geo) so that a
    // "FRANKFORT, Ky." dateline can never produce Franklin County.
    const mergedCounty = isKySchoolsSource
      ? (fallback.county ?? aiCounty ?? aiGeo.county ?? allowedSourceDefaultCounty)
      : isStatewideKyPolitics
        ? null // statewide political roundup gets no county pin at all
        : (
          // if the AI explicitly rejects Kentucky we normally drop any county
          // the fallback guessed, but we still want default-county sources to
          // retain their county tag only when the article is already KY.  The
          // rainy-day weather heuristic below handles uncategorized cases.
          (!aiIsKentucky && typeof parsed.isKentucky === 'boolean' && allowedSourceDefaultCounty === null)
            ? null
            : (fallback.county ??
               aiCounty ??
               aiGeo.county ??
               (mergedIsKentucky && !hadGeo && !isStatewideKyPolitics ? allowedSourceDefaultCounty : null))
        );

    // determine final counties list using AI output when available, otherwise
    // fall back to the mergedCounty (if any).  We only clear the *primary*
    // county for statewide political stories; secondary counties (which may
    // come from the AI or fallback logic) are still preserved so that the
    // article can be filtered by county even though its URL will not include
    // a county segment.
    const mergedCounties: string[] =
      aiCounties.length > 0
        ? aiCounties
        : mergedCounty
          ? [mergedCounty]
          : [];


    fallback = {
      isKentucky: mergedIsKentucky,
      county: mergedCounty,
      counties: mergedCounties,
      city: fallback.city ?? aiGeo.city,
      category: enforceCategoryEvidence(
        normalizeCategoryForKentuckyScope(hasKhsaa ? 'sports' : mergedCategory, mergedIsKentucky),
        cleanTitle,
        semanticLeadText,
        mergedIsKentucky,
        isKySchoolsSource,
      ),
      isNational: false, // recalc below
      geoConfidence: fallback.geoConfidence,
    };

    // recompute national flag after merges/overrides
    fallback.isNational = nationalSignal || !fallback.isKentucky;

    // Known always-national domains get a final sanity check.  Unless the AI
    // explicitly flagged the story as Kentucky *and* the lead text contains
    // strong KY evidence (>=2 mentions plus the word "Kentucky"/"KY"), strip
    // all Kentucky flags. This prevents site chrome/footer mentions of
    // "Kentucky" (e.g. navigation links, sidebar widgets) from causing a
    // national wire article to be treated as Kentucky.
    if (isAlwaysNational) {
      const strongTextEvidence =
        relevance.mentionCount >= 2 && /\b(?:kentucky|ky)\b/i.test(semanticLeadText);
      if (!strongTextEvidence || !aiIsKentucky) {
        fallback.isKentucky = false;
        fallback.county = null;
        fallback.counties = [];
        fallback.category = 'national';
        fallback.isNational = true;
      }
    }

    // Betting-content articles are national and should lose any KY tags even
    // if a team name or default county nudged the logic earlier.
    if (BETTING_CONTENT_RE.test(semanticLeadText)) {
      fallback.isKentucky = false;
      fallback.isNational = true;
      fallback.county = null;
      fallback.counties = [];
      fallback.category = 'national';
    }

    // for sources that cover multiple counties, we cannot assume every
    // article is Kentucky just because the domain has a default county.  clear
    // any KY tag that may have crept in via AI when the text itself provided no
    // Kentucky signals.
    if (!baseIsKentucky && allowedSourceDefaultCounty) {
      fallback.isKentucky = false;
      fallback.county = null;
    }

    // weather articles *are* safe to tag since our UI only shows them in a
    // dedicated weather feed; use the default county if nothing else was found.
    if (!fallback.isKentucky && allowedSourceDefaultCounty && fallback.category === 'weather') {
      fallback.isKentucky = true;
      fallback.county = allowedSourceDefaultCounty;
    }

    // Sync counties array after the override blocks above.
    // Only collapse to a single county if an override actually changed
    // the primary — otherwise preserve the full multi-county AI result.
    if (!fallback.isKentucky) {
      // article was stripped of its KY tag — clear all counties
      fallback.counties = [];
    } else if (fallback.county && fallback.counties.length === 0) {
      // no counties were set by AI, but we have a primary from an override
      fallback.counties = [fallback.county];
    } else if (fallback.county && fallback.counties[0] !== fallback.county) {
      // primary county changed by an override — put it first, keep the rest
      fallback.counties = [
        fallback.county,
        ...fallback.counties.filter((c) => c !== fallback.county),
      ];
    }
    // else: counties already correct from mergedCounties — leave untouched

    // Final safety net: if we still have a Kentucky story with no county, but
    // the source domain is a known hyperlocal outlet with a default county,
    // apply that county now. This guards against edge cases where earlier
    // category overrides (such as utility/infrastructure articles being forced
    // from weather to today) could accidentally clear the county field.
    // See bug report about harlanenterprise.net losing its county on water
    // infrastructure stories.
    if (fallback.isKentucky && !fallback.county) {
      const finalDefault = getSourceDefaultCounty(input.url);
      if (finalDefault) {
        fallback.county = finalDefault;
        if (fallback.counties.length === 0) {
          fallback.counties = [finalDefault];
        }
      }
    }

    return fallback;
  } catch {
    return fallback;
  }
}

const CATEGORY_PATTERNS: Record<Exclude<Category, 'today' | 'national'>, RegExp[]> = {
  // include empty string key to satisfy Record type narrowing; it is never
  // actually used.
  '': [],
  sports: [
    /\bfootball\b/i,
    /\bbasketball\b/i,
    /\bbaseball\b/i,
    /\bsoccer\b/i,
    /\bsoftball\b/i,
    /\bwildcats\b/i,
    /\bcolonels\b/i,
    /\bscoreboard\b/i,
    /\bgame score\b/i,
    /\bsports?\s+(news|update|score|game|team)\b/i,
    /\bseason record\b/i,
    /\bplayoff\b/i,
    /\btournament\b/i,
    /\bswim\s+(meet|team|coach)\b/i,
    /\bdiving?\s+(meet|team|coach)\b/i,
    /\bwrestling\s+(match|team|coach|tournament|season)\b/i,
    /\btrack\s+and\s+field\b/i,
    /\bcross\s+country\s+(team|meet|race|runner)\b/i,
    /\bkhsaa\b/i,
    /\bncaa\s+(tournament|game|team|championship)\b/i,
    /\bsec\s+(champion|play|game|title)\b/i,
    /\bathletic\s+(director|program|scholarship)\b/i,
    /\bcoach(es|ed|ing)?\s+of\s+the\s+year\b/i,
    /\bvolleyball\s+(team|match|game|season|tournament)\b/i,
    /\bgolf\s+(tournament|course|player|team|match)\b/i,
    /\btennis\s+(match|game|player|team|coach|tournament)\b/i,
    /\bgymnastics\s+(team|meet|competition|season)\b/i,
  ],
  weather: [
    // title-based cues (added for WBKO-style headlines and similar)
    /\b(?:first\s+alert|weather\s+(?:day|alert|update|watch))\b/i,
    /\b(?:active|quiet|unsettled|stormy|rainy|snowy|cold|warm)\s+(?:start|week|weekend|pattern|stretch|spell)\b/i,
    /\b(?:week(?:end)?\s+)?(?:weather\s+)?forecast\b/i,

    /\bweather\s+(forecast|advisory|warning|alert|service)\b/i,
    /\btornado\s+(warning|watch|siren)\b/i,
    /\bflood\s+(warning|watch|advisory|stage)\b/i,
    /\bwinter storm\b/i,
    /\bsevere\s+weather\b/i,
    /\bsnow\s+(accumulation|total|forecast|storm|inches)\b/i,
    /\bheat\s+(wave|advisory|index|warning)\b/i,
    /\bfreez(ing|e)\s+(rain|warning|temperatures)\b/i,
    /\bhurricane\b/i,
    /\bice\s+storm\b/i,
    /\bnational weather service\b/i,

    // conversational forecast language
    /\b(?:scattered|isolated|chance\s+of)\s+(?:showers?|thunderstorms?|storms?|rain|sprinkles?)\b/i,
    /\b(?:partly|mostly|becoming)\s+(?:cloudy|sunny|clear)\b/i,
    /\b(?:overnight|morning|afternoon|evening)\s+(?:lows?|highs?|temperatures?)\b/i,
    /\bhighs?\s+(?:in\s+the\s+)?(?:upper|lower|mid)?\s*\d{2}s?\b/i,
    /\blows?\s+(?:in\s+the\s+)?(?:upper|lower|mid)?\s*\d{2}s?\b/i,
    /\b(?:rain|snow|ice|sleet)\s+(?:chance|likely|possible|expected|moving|arriving|ending)\b/i,
    /\b(?:chance|likelihood)\s+of\s+(?:rain|snow|storms?|showers?|precipitation)\b/i,
    /\b(?:forecast|outlook)\s+(?:for|through|into|ahead)\b/i,
    /\bfirst\s+alert\b/i,
    /\b(?:flurr(?:y|ies)|wintry\s+mix|freezing\s+drizzle|light\s+snow|snow\s+showers?)\b/i,
    /\b(?:rain|weather)\s+chances?\b/i,
    /\b(?:temperatures?|temps?)\s+(?:will|are|expected|remain|stay|drop|rise|warm|cool)\b/i,
    /\b(?:warm(?:ing)?|cool(?:ing)?|cold(?:er)?)\s+(?:front|air|temperatures?|spell)\b/i,
    /\b(?:storm|rain|snow|weather)\s+(?:system|pattern|chance|moving)\b/i,
    /\bprecipitation\b/i,
  ],
  schools: [
    /\bschool board\b/i,
    /\bboard of education\b/i,
    /\bhigh school\b/i,
    /\belementary school\b/i,
    /\bmiddle school\b/i,
    /\bschool district\b/i,
    /\bschool superintendent\b/i,
    /\bclassroom\b/i,
    /\bschool principal\b/i,
    /\bgrades k[\s-]12\b/i,
    /\bschoolchild(ren)?\b/i,
    /\btuition\b/i,
    /\bcampus lockdown\b/i,
    /\bschool shooting\b/i,
    /\bschool budget\b/i,
  ],
};

export function classifyArticle(title: string, bodyText: string): RelevanceClassification {
  const normalizedTitle = normalizeText(title);
  const normalizedBody = normalizeText(bodyText);
  const wholeArticle = `${normalizedTitle} ${normalizedBody}`.trim();

  const titleHasKentucky = hasKentuckyOrKy(normalizedTitle);
  if (titleHasKentucky || hasStrongLocationTitleMatch(normalizedTitle)) {
    return { category: 'kentucky', tier: 'title', mentionCount: 1 };
  }

  const hasKentuckyContext = hasKentuckyOrKy(wholeArticle);
  const mentionCount = countKentuckyMentions(normalizedBody, hasKentuckyContext);

  // State-enumeration guard: if Kentucky appears but only inside a list of US states
  // (e.g. "…affecting Kentucky, Ohio, Indiana and Tennessee…"), do not treat it as a
  // primary Kentucky story. Require at least one KY mention that is NOT in an enumeration.
  if (mentionCount >= 2 && isKentuckyOnlyInStateList(normalizedBody)) {
    return { category: 'national', tier: 'national', mentionCount };
  }

  if (mentionCount >= 2) {
    return { category: 'kentucky', tier: 'body', mentionCount };
  }

  return { category: 'national', tier: 'national', mentionCount };
}

export function detectSemanticCategory(text: string): Exclude<Category, 'today' | 'national'> | null {
  for (const [category, patterns] of Object.entries(CATEGORY_PATTERNS) as [
    Exclude<Category, 'today' | 'national'>,
    RegExp[],
  ][]) {
    if (patterns.some((pattern) => pattern.test(text))) return category;
  }
  return null;
}

export function isShortContentAllowed(url: string, wordCount: number, minimum = 50): boolean {
  return wordCount >= minimum;
}

function hasStrongLocationTitleMatch(title: string): boolean {
  const titleHasKentuckyContext = hasKentuckyOrKy(title);
  if (detectCounty(normalizeText(title), title)) return true;
  if (/\bkhsaa\b/i.test(title)) return true;

  for (const term of [...KY_CITY_TERMS, ...KY_REGION_TERMS]) {
    if (!containsWordOrPhrase(title, term)) continue;
    if (AMBIGUOUS_CITY_TERMS.has(term) && !titleHasKentuckyContext) continue;
    return true;
  }

  return false;
}

/**
 * Counts distinct Kentucky signals in body text.
 *
 * County and city hits only count when `allowAmbiguousCities` is true
 * (i.e. "Kentucky"/"KY" already appears in the full article). This prevents
 * a county-name-only match from pushing a national story over the KY threshold.
 */
function countKentuckyMentions(text: string, allowAmbiguousCities: boolean): number {
  if (!text) return 0;

  // Filter out obvious navigational/menu scraps where "Kentucky" appears as a
  // standalone menu item or tag (e.g. site nav, related-topic list). These
  // typically appear as very short lines with no sentence punctuation.
  const filtered = text
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      if (!/\b(kentucky|ky)\b/i.test(trimmed)) return true;

      // Ignore simple navigation/tag lines like "Kentucky", "KY", or
      // "Kentucky News" that may appear as part of site nav/related-topic lists.
      if (/^\s*(kentucky|ky)(\s+(news|sports|business|culture|technology|tech|health|travel|opinion|local|national|world))?\s*$/i.test(trimmed)) {
        return false;
      }

      return true;
    })
    .join('\n');

  let count = 0;

  // Unambiguous standalone signals — always count.
  count += countMatches(filtered, /\bkentucky\b/gi);
  count += countMatches(filtered, /\bky\b/gi);
  count += countMatches(filtered, /\bkhsaa\b/gi);
  for (const term of KY_REGION_TERMS) {
    count += countPhraseOccurrences(filtered, term);
  }

  // County and city hits only count when we already have KY context.
  if (allowAmbiguousCities) {
    for (const { pattern } of COUNTY_PATTERNS) {
      count += countMatches(text, new RegExp(pattern.source, 'gi'));
    }

    if (detectCounty(text, text)) count += 1;
    if (detectCity(text)) count += 1;

    for (const city of KY_CITY_TERMS) {
      if (AMBIGUOUS_CITY_TERMS.has(city)) continue;
      count += countPhraseOccurrences(text, city);
    }
  }

  return count;
}

/**
 * Decides whether to invoke the AI classifier.
 *
 * Triggers AI when:
 * - KY story with no county (AI may fill it in)
 * - KY story with county but NO standalone "Kentucky"/"KY" (county-only match,
 *   which is the most error-prone path — e.g. "Christian County, MO")
 * - National story that nonetheless has at least one KY hint (AI double-check)
 */
function shouldUseAiFallback(title: string, content: string, current: ClassificationResult): boolean {
  // Never use AI for national wire stories — the wire dateline heuristic is
  // authoritative and the AI may hallucinate a Kentucky county from the source name.
  // (This guard receives isNationalWireStory via closure; we check it in the caller.)
  const fullText = `${title}\n${content}`;

  if (current.isKentucky && !current.county) return true;

  if (current.isKentucky && current.county && !hasKentuckyOrKy(fullText)) return true;

  // If the county was likely derived from a high-ambiguity city mapping (e.g. "columbia"
  // → "Adair", "auburn" → no county), always ask the AI to verify — the keyword
  // heuristic may have bypassed the out-of-state guard due to strong KY article context.
  if (current.isKentucky && current.county) {
    const detectedCity = detectCity(fullText);
    if (detectedCity && HIGH_AMBIGUITY_CITIES.has(detectedCity)) return true;
  }

  if (!current.isKentucky) {
    if (hasKentuckyOrKy(fullText)) return true;
    if (countKentuckyMentions(normalizeText(content), false) === 1) return true;
  }

  return false;
}

function hasKentuckyOrKy(text: string): boolean {
  return KENTUCKY_OR_KY_RE.test(text);
}

function normalizeCountyName(value: string): string | null {
  const cleaned = normalizeText(value).replace(/\scounty$/i, '').trim().toLowerCase();
  if (!cleaned) return null;
  return KY_COUNTIES.find((county) => county.toLowerCase() === cleaned) ?? null;
}

/**
 * Validate AI-suggested county against actual text evidence.
 * If the AI returns a county name that does not appear in the
 * article text AND is not the source default, reject it.
 * This prevents hallucinated county assignments.
 */

/**
 * For source-default counties, require at least one of these
 * city/place names to appear in the article text before accepting
 * the county assignment. Prevents national stories published by
 * local outlets from being pinned to the outlet's home county.
 */
const SOURCE_DEFAULT_CITY_EVIDENCE = new Map<string, string[]>([
  ['fayette',   ['lexington', 'fayette']],
  ['jefferson', ['louisville', 'jefferson']],
  ['warren',    ['bowling green', 'warren']],
  ['kenton',    ['covington', 'erlanger', 'florence', 'independence', 'edgewood', 'ludlow', 'kenton']],
  ['campbell',  ['newport', 'alexandria', 'highland heights', 'cold spring', 'bellevue', 'dayton', 'campbell']],
  ['boyd',      ['ashland', 'boyd']],
  ['daviess',   ['owensboro', 'daviess']],
  ['mccracken', ['paducah', 'mccracken']],
  ['harlan',    ['harlan', 'harlan county']],
  ['madison',   ['richmond', 'berea', 'madison']],
  ['laurel',    ['london', 'laurel']],
  ['butler',    ['morgantown', 'butler']],
  ['barren',    ['glasgow', 'barren']],
  ['floyd',     ['prestonsburg', 'martin', 'floyd']],
  ['johnson',   ['paintsville', 'johnson']],
  ['perry',     ['hazard', 'perry']],
  ['franklin',  ['frankfort', 'franklin']],
  ['pike',      ['pikeville', 'pike']],
  ['christian', ['hopkinsville', 'christian']],
  ['pulaski',   ['somerset', 'pulaski']],
  ['boone',     ['florence', 'boone', 'walton', 'union']],
]);

function isCountyEvidenced(
  county: string | null,
  semanticText: string,
  geoCounties: string[],
  sourceDefault: string | null,
): boolean {
  if (!county) return true; // null is always valid
  // Reject counties that appear ONLY in conviction history context.
  // "Saltman has convictions in Daviess County" is background, not story location.
  if (/\b(?:convictions?\s+in|convicted\s+in|prior\s+(?:record|conviction|offense)s?\s+in|criminal\s+history\s+in|sentenced\s+in|previously\s+(?:convicted|charged)\s+in)\b/i.test(semanticText)) {
    const convictionCountyRe = new RegExp(
      `\\b(?:convictions?\\s+in|convicted\\s+in|prior\\s+(?:record|conviction|offense)s?\\s+in|criminal\\s+history\\s+in|sentenced\\s+in|previously\\s+(?:convicted|charged)\\s+in)\\s+${escapeRegExp(county)}\\s+County\\b`,
      'i'
    );
    const inConvictionContext = convictionCountyRe.test(semanticText);
    const allMatches = semanticText.match(new RegExp(`\\b${escapeRegExp(county)}\\s+County\\b`, 'gi')) ?? [];
    if (inConvictionContext && allMatches.length <= 2) {
      const nonConvictionText = semanticText.replace(
        /\b(?:convictions?\s+in|convicted\s+in|prior\s+(?:record|conviction|offense)s?\s+in|criminal\s+history\s+in|sentenced\s+in|previously\s+(?:convicted|charged)\s+in)[^.]*\./gi,
        ''
      );
      if (!new RegExp(`\\b${escapeRegExp(county)}\\s+County\\b`, 'i').test(nonConvictionText)) {
        return false;
      }
    }
  }
  // Suppress counties that appear exclusively as person surnames in sports articles.
  // "Davey Johnson said", "coach Reesa Martin", "Eric Clark" — these are people, not places.
  // Only trigger when: county is ambiguous AND no "County" suffix appears in text.
  if (AMBIGUOUS_COUNTY_NAMES.has(county)) {
    const withSuffixRe = new RegExp(`\\b${escapeRegExp(county)}\\s+County\\b`, 'i');
    if (!withSuffixRe.test(semanticText) && !geoCounties.some((c) => c.toLowerCase() === county.toLowerCase())) {
      return false;
    }
  }
  // Accept if geo detector already found it independently
  if (geoCounties.some((c) => c.toLowerCase() === county.toLowerCase())) {
    return true;
  }
  // Accept if county name appears literally in the text (with or without
  // "County" suffix).  Delegate to geo helper for clarity.
  if (textContainsCounty(semanticText, county)) return true;
  // Source default is trusted ONLY if the county's primary city also appears
  // in the text (e.g. "Lexington" for Fayette, "Louisville" for
  // Jefferson, "Bowling Green" for Warren).  This prevents source default
  // from pinning national stories that have no geographic connection to the
  // source's market.
  if (county === sourceDefault) {
    const key = county.toLowerCase();
    if (SOURCE_DEFAULT_CITY_EVIDENCE.has(key)) {
      return SOURCE_DEFAULT_CITY_EVIDENCE.get(key)!
        .some((city) => new RegExp(`\b${escapeRegExp(city)}\b`, 'i').test(semanticText));
    }
    // counties without a mapped city still get trusted
    return true;
  }
  return false;
}

function containsWordOrPhrase(haystack: string, phrase: string): boolean {
  if (phrase.includes(' ')) return haystack.includes(phrase);
  return new RegExp(`\\b${escapeRegExp(phrase)}\\b`, 'i').test(haystack);
}

function countMatches(text: string, regex: RegExp): number {
  return (text.match(regex) ?? []).length;
}

function countPhraseOccurrences(text: string, phrase: string): number {
  if (!phrase) return 0;
  const re = phrase.includes(' ')
    ? new RegExp(escapeRegExp(phrase), 'gi')
    : new RegExp(`\\b${escapeRegExp(phrase)}\\b`, 'gi');
  return countMatches(text, re);
}

function normalizeText(value: string): string {
  return ` ${String(value || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ')} `
    .replace(/\s+/g, ' ')
    .trim();
}


/**
 * Strips site-name branding from titles for sources that embed "Kentucky" in their brand.
 * Prevents brand boilerplate from inflating the Kentucky mention count for national articles.
 */
function normalizeTitleForSource(title: string, sourceUrl: string): string {
  const host = getHostname(sourceUrl);
  if (!host) return title;

  for (const source of KY_BRANDED_SOURCES) {
    if (source.hosts.some((h) => host === h || host.endsWith(`.${h}`))) {
      return title
        .replace(/^\s*[\w\s]+\s*[|•·—–-]\s*/i, (m) =>
          source.stripPattern.test(m) ? '' : m,
        )
        .replace(/\s*[|•·—–-]\s*[\w\s]+\s*$/i, (m) =>
          source.stripPattern.test(m) ? '' : m,
        )
        .replace(source.stripPattern, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }
  }

  return title;
}

/**
 * Strips site-name branding from article content for known KY-branded sources.
 */
function normalizeContentForSource(content: string, sourceUrl: string): string {
  const host = getHostname(sourceUrl);
  if (!host) return content;

  for (const source of KY_BRANDED_SOURCES) {
    if (source.hosts.some((h) => host === h || host.endsWith(`.${h}`))) {
      return content.replace(source.stripPattern, ' ').replace(/\s+/g, ' ').trim();
    }
  }

  return content;
}

function getHostname(sourceUrl: string): string | null {
  try {
    return new URL(sourceUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isKySchoolsDomain(sourceUrl: string): boolean {
  const host = getHostname(sourceUrl);
  if (!host) return false;
  return host === 'kyschools.us' || host.endsWith('.kyschools.us');
}

/**
 * Blanks out hard-negative brand phrases so they don't inflate the Kentucky
 * mention count. Replaces matched text with spaces rather than deleting so
 * surrounding word boundaries are preserved.
 */
function stripHardNegatives(text: string): string {
  let result = text;
  for (const pattern of KY_HARD_NEGATIVES) {
    result = result.replace(pattern, (m) => ' '.repeat(m.length));
  }
  return result;
}

/**
 * Returns the default county for a known hyperlocal Kentucky source domain,
 * or null if the domain is unknown or covers the whole state.
 *
 * Special handling for *.kyschools.us domains: the subdomain IS the county name.
 * e.g. scott.kyschools.us → "Scott", metcalfe.kyschools.us → "Metcalfe"
 */
function getSourceDefaultCounty(sourceUrl: string): string | null {
  const host = getHostname(sourceUrl);
  if (!host) return null;

  // Kentucky school districts use [countyname].kyschools.us
  // Extract county from subdomain and validate against the known KY counties list.
  if (host.endsWith('.kyschools.us')) {
    const subdomain = host.replace(/\.kyschools\.us$/, '').toLowerCase();
    // Subdomains may be multi-part (e.g. www.scott.kyschools.us) — take the
    // last segment before .kyschools.us as the county name.
    const parts = subdomain.split('.');
    const countyCandidate = parts[parts.length - 1];
    if (countyCandidate) {
      const matched = KY_COUNTIES.find(
        (c) => c.toLowerCase() === countyCandidate,
      );
      if (matched) return matched;
    }
  }

  for (const [domain, county] of Object.entries(SOURCE_DEFAULT_COUNTY)) {
    if (host === domain || host.endsWith(`.${domain}`)) return county;
  }

  return null;
}

/**
 * Returns a default image URL for certain known sources when the scraped
 * article provided no usable image. Currently used for Kentucky State Police
 * feeds which lack og:image metadata.
 */
export function getSourceDefaultImage(sourceUrl: string): string | null {
  const host = getHostname(sourceUrl);
  if (!host) return null;
  for (const [domain, img] of Object.entries(SOURCE_DEFAULT_IMAGE)) {
    if (host === domain || host.endsWith(`.${domain}`)) return img;
  }
  return null;
}

/**
 * Returns true when every occurrence of "Kentucky"/"KY" in the text appears
 * inside a multi-state enumeration pattern, suggesting the article is national
 * in scope and merely lists KY alongside other states.
 *
 * Examples that return true:
 *   "…affecting Kentucky, Ohio, Indiana and Tennessee…"
 *   "…states including Kentucky, Virginia, and West Virginia…"
 *
 * A single KY mention that is NOT in an enumeration returns false, allowing
 * the normal mentionCount >= 2 logic to proceed.
 */
function isKentuckyOnlyInStateList(normalizedText: string): boolean {
  // Pattern: "kentucky" or "ky" surrounded by other state names within ~60 chars
  const kyRe = /\b(kentucky|ky)\b/gi;
  // Neighbours that suggest an enumeration context
  const enumerationNeighbourRe =
    /\b(ohio|indiana|tennessee|virginia|west virginia|illinois|missouri|arkansas|georgia|carolina|alabama|mississippi|florida|texas|oklahoma|kansas|nebraska|iowa|michigan|wisconsin|minnesota|pennsylvania|new york|new jersey|maryland|delaware|connecticut|massachusetts|rhode island|vermont|new hampshire|maine|alaska|hawaii|arizona|nevada|utah|colorado|wyoming|montana|idaho|oregon|washington)\b/i;

  let match: RegExpExecArray | null;
  let allInEnumeration = true;
  let foundAny = false;

  while ((match = kyRe.exec(normalizedText)) !== null) {
    foundAny = true;
    const start = Math.max(0, match.index - 80);
    const end = Math.min(normalizedText.length, match.index + match[0].length + 80);
    const window = normalizedText.slice(start, end);

    if (!enumerationNeighbourRe.test(window)) {
      // This KY mention is NOT in a state list — article has standalone KY context.
      allInEnumeration = false;
      break;
    }
  }

  return foundAny && allInEnumeration;
}

function enforceCategoryEvidence(
  category: Category,
  title: string,
  leadText: string,
  isKentucky: boolean,
  isKySchoolsSource: boolean,
): Category {
  if (category === 'today' || category === 'national') {
    return normalizeCategoryForKentuckyScope(category, isKentucky);
  }

  // Guard against AI hallucinating "weather" for sports articles.
  // WYMT and similar TV stations cover both weather and sports; the model
  // sometimes returns "weather" for sports game recaps.
  if (category === 'weather') {
    const hasSportsSignal = CATEGORY_PATTERNS.sports.some(p => p.test(title) || p.test(leadText));
    if (hasSportsSignal) {
      return normalizeCategoryForKentuckyScope('sports', isKentucky);
    }
    // Guard against weather misclassification for infrastructure/utility articles
    // that mention weather only as context (e.g. "severe weather caused outages").
    const hasUtilitySignal = /\b(?:utility|utilities|power\s+(?:grid|outage|company|line|plant)|electric(?:al)?\s+(?:grid|company|cooperative|utility)|municipal\s+utility|water\s+(?:system|treatment|utility)|broadband|fiber\s+(?:internet|network)|rate\s+(?:increase|hike)|ratepayer|kwh|kilowatt|megawatt|infrastructure\s+(?:invest|upgrade|project)|smart\s+grid|recloser|utility\s+pole)\b/i.test(title) ||
      /\b(?:utility|utilities|power\s+(?:grid|company)|electric(?:al)?\s+(?:grid|company|cooperative)|municipal\s+utility|smart\s+grid|recloser)\b/i.test(leadText.slice(0, 400));
    if (hasUtilitySignal) {
      return normalizeCategoryForKentuckyScope('today', isKentucky);
    }
  }

  if (category === 'schools' && isKySchoolsSource) {
    return 'schools';
  }

  const patterns = CATEGORY_PATTERNS[category as keyof typeof CATEGORY_PATTERNS] ?? [];
  if (patterns.length === 0) return normalizeCategoryForKentuckyScope(category, isKentucky);

  const titleSignal = patterns.some((pattern) => pattern.test(title));
  const leadSignals = countCategorySignalHits(patterns, leadText);

  // Weather forecasts use conversational language.  A single strong pattern
  // match (including the new conversational cues) is sufficient when combined
  // with the source context.  Lower the evidence threshold from 2 to 1 for
  // weather to avoid demoting genuine forecast posts into "today".
  if (category === 'weather') {
    const hasEvidence = titleSignal || leadSignals >= 1;
    if (!hasEvidence) {
      return isKentucky ? 'today' : 'national';
    }
    return normalizeCategoryForKentuckyScope(category, isKentucky);
  }

  const hasEvidence = titleSignal || leadSignals >= 2;

  if (!hasEvidence) {
    return isKentucky ? 'today' : 'national';
  }

  return normalizeCategoryForKentuckyScope(category, isKentucky);
}

function countCategorySignalHits(patterns: RegExp[], text: string): number {
  let hits = 0;
  for (const pattern of patterns) {
    if (pattern.test(text)) hits += 1;
  }
  return hits;
}

/**
 * Keep Kentucky-only sections clean: non-Kentucky stories are always "national".
 * This prevents invalid combinations like:
 * - national + sports
 * - national + schools
 * - national + today
 */
function normalizeCategoryForKentuckyScope(category: Category, isKentucky: boolean): Category {
  if (isKentucky) return category;
  if (
    category === 'sports' ||
    category === 'schools' ||
    category === 'today' ||
    category === 'weather'   // weather is Kentucky-scoped; non-KY articles should never be tagged weather
  ) {
    return 'national';
  }
  return category;
}

