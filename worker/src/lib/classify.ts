// See TAGGING_SYSTEM.md in the repository root for the full set of
// editorial tagging guidelines (Kentucky/National rules, county
// assignment logic, weather/sports/school tags, etc.).  The algorithms in
// this file attempt to implement those rules automatically during article
// ingestion.
import type { Category, ClassificationResult } from '../types';
import { detectCounty, detectCity, detectKentuckyGeo, HIGH_AMBIGUITY_CITIES, escapeRegExp, textContainsCounty } from './geo';
import { KY_COUNTIES } from '../data/ky-geo';

type AiResultLike = {
  response?: string;
  result?: { response?: string };
  output_text?: string;
  choices?: Array<{ message?: { content?: string | null } }>;
};

const VALID_AI_CATEGORIES = new Set<string>(['sports', 'weather', 'schools', 'obituaries', 'today', 'national']);

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
    `\\b${escapeRegExp(county)}\\s+(?:county|counties|cnty|co(?=[\\s]|$))\\b`,
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
    hosts: ['kentucky.com'],
    // Kentucky.com (Herald-Leader) — strip standalone brand references but not
    // legitimate "Kentucky" usage in article text. We strip only the byline/footer form.
    stripPattern: /\bkentucky\.com\b/gi,
  },
];

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
  'lex18.com': 'Fayette',
  'wkyt.com': 'Fayette',
  'wymt.com': 'Perry',
  'jessaminejournalonline.com': 'Jessamine',
  'richmondregister.com': 'Madison',
  'bgdailynews.com': 'Warren',           // Bowling Green
  'wkuherald.com': 'Warren',
  // Northern Kentucky (multi-county coverage)
  'linknky.com': null,
  'nkytribune.com': 'Kenton',
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
  'whas11.com': 'Jefferson',
  'courier-journal.com': 'Jefferson',
  // Northern Kentucky
  'nky.com': 'Kenton',
  // State-level sources (no default county — they cover all of KY)
  'kentuckylantern.com': null,
  'kentuckytoday.com': null,
  'kentuckysportsradio.com': null,
};

/**
 * Brand phrases that should NOT count as "Kentucky" location signals.
 * These are national brand names that contain the word "Kentucky" but refer
 * to a company or product, not the Commonwealth.
 * Each entry is tested as a case-insensitive substring after normalization.
 */
const KY_HARD_NEGATIVES: RegExp[] = [
  /\bkentucky\s+fried\s+chicken\b/i,
  /\bkfc\b/i,
  /\bkentucky\s+derby\s+industries\b/i,    // unrelated brand (rare)
  /\bkentucky\s+windage\b/i,               // shooting/gun term, not geographic
  /\bwestern\s+kentucky\s+university\b/i,  // WKU in national rankings not KY news
  /\beastern\s+kentucky\s+university\b/i,  // EKU in national context
  /\bnorthern\s+kentucky\s+university\b/i, // NKU in national context
];

/**
 * Patterns that strongly indicate a national wire story regardless
 * of source. When these appear in the title or lead content, the
 * source default county is suppressed and the article is treated
 * as national unless it has genuine Kentucky geo signals in the text.
 */
const NATIONAL_WIRE_OVERRIDE_RE =
  /\b(?:washington\s*[—-]\s*|new\s+york\s*[—-]\s*|(?:ap|reuters|afp)\s*[—-]\s*|the\s+associated\s+press\s*[—-]|nbc\s+news\s*[—-]|cnn\s*[—-]|abc\s+news\s*[—-]|cbs\s+news\s*[—-]|fox\s+news\s*[—-]|dubai\s*[—-]\s*united\s+arab|from\s+(?:new\s+york|washington|london|dubai|tel\s+aviv|jerusalem|paris|berlin|beijing|moscow|tokyo))/i;

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
const BETTING_CONTENT_RE =
  /\b(?:spread|over\/under|money\s*line|sportsbook|promo\s*code|SportsLine|DraftKings|FanDuel|BetMGM|betting\s+(?:line|odds|pick|advice))\b/i;

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
  const nationalSignal = /\bnational\b|\bfederal\b|\bunited states\b|\bu\.s\.\s+(?:government|congress|senate|house|military|federal|supreme court|president|department|agency|law|policy|court)\b|\b(?:congress|senate|white house|pentagon|supreme court|federal government|biden|trump|president)\b/i.test(semanticLeadText);
  const sourceDefaultCounty = getSourceDefaultCounty(input.url);

  // Suppress source default county for national wire stories.
  // Local TV stations syndicate AP/NBC/etc content; the dateline
  // or byline pattern reveals these are not local stories.
  const isNationalWireStory =
    NATIONAL_WIRE_OVERRIDE_RE.test(semanticLeadText);

  const effectiveSourceDefaultCounty =
    isNationalWireStory ? null : sourceDefaultCounty;

  // treat articles from a known local source as KY, even if the text lacks an
  // explicit Kentucky mention. This flag influences both the initial fallback
  // and later merging logic.
  const baseIsKentucky =
    relevance.category === 'kentucky' || hasKhsaa || effectiveSourceDefaultCounty !== null;

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
  const baseGeo = baseIsKentucky
    ? detectKentuckyGeo(semanticText)
    : { isKentucky: false, county: null, counties: [], city: null };

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
      baseGeo.county ??
      (!baseGeo.city && (baseIsKentucky || louisvilleSportsSignal || isKySchoolsSource)
        ? effectiveSourceDefaultCounty
        : null),
    counties: baseGeo.counties ? [...baseGeo.counties] : [],
    city: baseGeo.city,
    category: hasKhsaa ? 'sports' : category,
    isNational: false, // will populate after we know isKentucky
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

  if (isNationalWireStory && hasOnlyPoliticianKyMention) {
    // Override: treat as national despite KY mention
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

  if (!shouldUseAiFallback(cleanTitle, cleanContent, fallback)) {
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
      '  "category" - one of: "sports", "weather", "schools", "obituaries", "today", "national"',
      '    sports     = article is PRIMARILY about sports games, teams, athletes, or tournaments',
      '    weather    = article is PRIMARILY about weather forecasts, storms, floods, or temperatures',
      '    schools    = article is PRIMARILY about schools, education, school boards, or campus events',
      '    obituaries = article is an obituary, funeral notice, or memorial service announcement',
      '    today      = article mentions Kentucky or KY but does not fit sports/weather/schools/obituaries',
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
      '                Example: ["Fayette", "Clark"] for an article set in both ',
      '                Lexington and Winchester, Kentucky.',
      '                Example: ["Perry"] for an article set only in Hazard.',
      '                Example: [] if no county is identifiable.',
      `  All 120 KY counties: ${countyList}`,      '',
      'Rules:',
      '  - Respond with ONLY valid JSON. No markdown, no code fences, no extra text.',
      '  - Example: {"category":"today","isKentucky":true,"counties":["Fayette"]}',
      '',
      `Title: ${cleanTitle}`,
      '',
      `Content: ${cleanContent.slice(0, 1200)}`,
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

    const parsed = JSON.parse(aiText) as {
      category?: string;
      isKentucky?: boolean;
      county?: string | null;
      counties?: string[];
    };

    const aiCategory = VALID_AI_CATEGORIES.has(parsed.category ?? '') ? (parsed.category as Category) : null;
    const aiIsKentucky = typeof parsed.isKentucky === 'boolean' ? parsed.isKentucky : false;

    // build normalized list of counties from the AI output
    const aiCountiesRaw: string[] = Array.isArray(parsed.counties)
      ? parsed.counties
      : parsed.county ? [parsed.county] : [];
    let aiCounties = aiCountiesRaw
      .map((c) => normalizeCountyName(c))
      .filter((c): c is string => !!c);

    // Validate AI-suggested counties against actual text evidence.  Any
    // county that isn't present literally in the semantic text and wasn't
    // already found by the geo detector is discarded unless it matches the
    // trusted source default.  If the primary county is rejected we fall
    // back to the geo detector result to avoid leaving a spurious value.
    if (!isCountyEvidenced(aiCounties[0] ?? null, semanticText, baseGeo.counties, effectiveSourceDefaultCounty)) {
      // AI hallucinated a primary county
      aiCounties = baseGeo.counties.length > 0 ? [...baseGeo.counties] : [];
    }
    // Filter the rest of the array as well
    aiCounties = aiCounties.filter((c) =>
      isCountyEvidenced(c, semanticText, baseGeo.counties, effectiveSourceDefaultCounty),
    );

    const aiCounty = aiCounties[0] ?? null;

    const aiGeo = aiIsKentucky
      ? detectKentuckyGeo(`${cleanTitle}\n${cleanContent}`)
      : { isKentucky: false, county: null, counties: [], city: null };
    const mergedIsKentucky =
      fallback.isKentucky || aiIsKentucky || isKySchoolsSource;

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

    const mergedCounty = isKySchoolsSource
      ? (fallback.county ?? aiCounty ?? aiGeo.county ?? effectiveSourceDefaultCounty)
      : (
        // if the AI explicitly rejects Kentucky we normally drop any county
        // the fallback guessed, but we still want default-county sources to
        // retain their county tag only when the article is already KY.  The
        // rainy-day weather heuristic below handles uncategorized cases.
        (!aiIsKentucky && typeof parsed.isKentucky === 'boolean' && effectiveSourceDefaultCounty === null)
          ? null
          : (fallback.county ??
             aiCounty ??
             aiGeo.county ??
             (mergedIsKentucky && !hadGeo ? effectiveSourceDefaultCounty : null))
      );

    // determine final counties list using AI output when available, otherwise
    // fall back to the mergedCounty (if any)
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
    };

    // recompute national flag after merges/overrides
    fallback.isNational = nationalSignal || !fallback.isKentucky;

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
    if (!baseIsKentucky && effectiveSourceDefaultCounty) {
      fallback.isKentucky = false;
      fallback.county = null;
    }

    // weather articles *are* safe to tag since our UI only shows them in a
    // dedicated weather feed; use the default county if nothing else was found.
    if (!fallback.isKentucky && effectiveSourceDefaultCounty && fallback.category === 'weather') {
      fallback.isKentucky = true;
      fallback.county = effectiveSourceDefaultCounty;
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

    return fallback;
  } catch {
    return fallback;
  }
}

const CATEGORY_PATTERNS: Record<Exclude<Category, 'today' | 'national'>, RegExp[]> = {
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
  obituaries: [
    /\bobituar(y|ies)\b/i,
    /\bfuneral home\b/i,
    /\bmemorial service\b/i,
    /\bpassed away\b/i,
    /\bvisitation\s+(hours?|will be)\b/i,
    /\bsurvived by\b/i,
    /\binterment\b/i,
    /\bin lieu of flowers\b/i,
    /\bservices will be held\b/i,
    /\bwas born.*died\b/i,
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

  let count = 0;

  // Unambiguous standalone signals — always count.
  count += countMatches(text, /\bkentucky\b/gi);
  count += countMatches(text, /\bky\b/gi);
  count += countMatches(text, /\bkhsaa\b/gi);
  for (const term of KY_REGION_TERMS) {
    count += countPhraseOccurrences(text, term);
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
function isCountyEvidenced(
  county: string | null,
  semanticText: string,
  geoCounties: string[],
  sourceDefault: string | null,
): boolean {
  if (!county) return true; // null is always valid
  if (county === sourceDefault) return true; // source default is trusted
  // Accept if geo detector already found it independently
  if (geoCounties.some((c) => c.toLowerCase() === county.toLowerCase())) {
    return true;
  }
  // Accept only if the county name appears literally in the text
  // (with or without "County" suffix).  Delegate to geo helper for clarity.
  return textContainsCounty(semanticText, county);
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
  if (category === 'sports' || category === 'schools' || category === 'today') {
    return 'national';
  }
  return category;
}
