import type { Category, ClassificationResult } from '../types';
import { detectCounty, detectCity, detectKentuckyGeo } from './geo';
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

const AMBIGUOUS_CITY_TERMS = new Set<string>([
  'lexington',
  'louisville',
  'georgetown',
  'franklin',
  'winchester',
]);

const COUNTY_PATTERNS = KY_COUNTIES.map((county) => ({
  county,
  pattern: new RegExp(`\\b${escapeRegExp(county)}\\s+county\\b`, 'i'),
}));

const KENTUCKY_OR_KY_RE = /\bkentucky\b|\bky\b/i;

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
 * AI-powered classification using GLM-4.7-Flash.
 * Reads the article title and content to determine category, Kentucky presence,
 * and county. Falls back to keyword-based classifyArticle if AI fails.
 */
export async function classifyArticleWithAi(
  env: Env,
  input: ClassifierInput,
): Promise<ClassificationResult> {
  const title = (input.title || '').trim();
  const content = (input.content || '').trim();
  const relevance = classifyArticle(title, content);

  const semanticText = `${title}\n${content}`;
  const semanticCategory = detectSemanticCategory(semanticText);

  const hasKhsaa = /\bkhsaa\b/i.test(semanticText);
  const baseIsKentucky = relevance.category === 'kentucky' || hasKhsaa;
  const baseGeo = baseIsKentucky ? detectKentuckyGeo(semanticText) : { county: null, city: null };

  let category: Category = semanticCategory ?? (baseIsKentucky ? 'today' : 'national');
  if (category === 'sports' && !baseIsKentucky && !hasKhsaa) {
    // Kentucky Sports page should only include Kentucky sports.
    category = 'national';
  }

  let fallback: ClassificationResult = {
    isKentucky: baseIsKentucky,
    county: baseGeo.county,
    city: baseGeo.city,
    category: hasKhsaa ? 'sports' : category,
  };

  // Fallback AI mode: only when deterministic result is ambiguous or missing county for Kentucky stories.
  if (!shouldUseAiFallback(title, content, fallback)) {
    return fallback;
  }

  try {
    const countyList = KY_COUNTIES.slice(0, 50).join(', '); // first 50 for prompt brevity
    const prompt = [
      'You are a news classifier for a Kentucky local news app.',
      'Analyze the article title and first 1200 characters of content below.',
      '',
      'Task: Return a JSON object with three fields:',
      '  "category" - one of: "sports", "weather", "schools", "obituaries", "today", "national"',
      '    sports     = article is PRIMARILY about sports games, teams, athletes, or tournaments',
      '    weather    = article is PRIMARILY about weather forecasts, storms, floods, or temperatures',
      '    schools    = article is PRIMARILY about schools, education, school boards, or campus events',
      '    obituaries = article is an obituary, funeral notice, or memorial service announcement',
      '    today      = article mentions Kentucky or KY but does not fit sports/weather/schools/obituaries',
      '    national   = article does NOT primarily concern Kentucky AND does not fit the above categories',
      '  "isKentucky" - true if the article contains the word "Kentucky" or abbreviation "KY" (standalone), false otherwise',
      '  "county" - if a specific Kentucky county is prominently mentioned (e.g., "Pike County", "Fayette County"),',
      '             return just the county name WITHOUT the word County (e.g., "Pike"). Otherwise return null.',
      `  Known KY counties include: ${countyList}, ...`,
      '',
      'Rules:',
      '  - Respond with ONLY valid JSON. No markdown, no code fences, no extra text.',
      '  - Example: {"category":"today","isKentucky":true,"county":"Fayette"}',
      '',
      `Title: ${title}`,
      '',
      `Content: ${content.slice(0, 1200)}`,
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
    };

    const aiCategory = VALID_AI_CATEGORIES.has(parsed.category ?? '') ? (parsed.category as Category) : null;

    const aiIsKentucky = typeof parsed.isKentucky === 'boolean' ? parsed.isKentucky : false;
    const aiCounty = parsed.county && parsed.county !== 'null' && parsed.county.length > 1
      ? normalizeCountyName(parsed.county)
      : null;

    const aiGeo = aiIsKentucky ? detectKentuckyGeo(`${title}\n${content}`) : { county: null, city: null };

    const mergedIsKentucky = fallback.isKentucky || aiIsKentucky;

    // Keep deterministic section category unless deterministic was national and AI found a valid semantic category.
    let mergedCategory = fallback.category;
    if (fallback.category === 'national' && aiCategory && aiCategory !== 'national') {
      mergedCategory = aiCategory;
    }

    if (mergedCategory === 'sports' && !mergedIsKentucky && !hasKhsaa) {
      mergedCategory = 'national';
    }

    fallback = {
      isKentucky: mergedIsKentucky,
      county: fallback.county ?? aiCounty ?? aiGeo.county,
      city: fallback.city ?? aiGeo.city,
      category: hasKhsaa ? 'sports' : mergedCategory,
    };

    return fallback;
  } catch {
    // AI unavailable or returned unparseable response — deterministic result stands.
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
    /\bkhsaa\b/i,         // Kentucky High School Athletic Association
    /\bncaa\s+(tournament|game|team|championship)\b/i,
    /\bsec\s+(champion|play|game|title)\b/i,  // SEC sports
    /\bathletic\s+(director|program|scholarship)\b/i,
    /\bcoach(es|ed|ing)?\s+of\s+the\s+year\b/i,
    /\bvolleyball\s+(team|match|game|season|tournament)\b/i,
    /\bgolf\s+(tournament|course|player|team|match)\b/i,
    /\btennis\s+(match|game|player|team|coach|tournament)\b/i,
    /\bgymnastics\s+(team|meet|competition|season)\b/i,
  ],
  weather: [
    // Require *specific* weather phrases, not generic words like "rain" or "temperature"
    // to avoid mis-classifying political/housing/crime articles that happen to mention weather
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
  ],
  schools: [
    // Require compound phrases to avoid matching "student" or "college" in unrelated articles
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
    return {
      category: 'kentucky',
      tier: 'title',
      mentionCount: 1,
    };
  }

  const hasKentuckyContext = hasKentuckyOrKy(wholeArticle);
  const mentionCount = countKentuckyMentions(normalizedBody, hasKentuckyContext);
  if (mentionCount >= 2) {
    return {
      category: 'kentucky',
      tier: 'body',
      mentionCount,
    };
  }

  return {
    category: 'national',
    tier: 'national',
    mentionCount,
  };
}

export function detectSemanticCategory(text: string): Exclude<Category, 'today' | 'national'> | null {
  for (const [category, patterns] of Object.entries(CATEGORY_PATTERNS) as [
    Exclude<Category, 'today' | 'national'>,
    RegExp[],
  ][]) {
    if (patterns.some((pattern) => pattern.test(text))) {
      return category;
    }
  }
  return null;
}

export function isShortContentAllowed(url: string, wordCount: number, minimum = 50): boolean {
  return wordCount >= minimum;
}

function hasStrongLocationTitleMatch(title: string): boolean {
  const titleHasKentuckyContext = hasKentuckyOrKy(title);

  if (COUNTY_PATTERNS.some(({ pattern }) => pattern.test(title))) return true;
  if (/\bkhsaa\b/i.test(title)) return true;

  for (const term of [...KY_CITY_TERMS, ...KY_REGION_TERMS]) {
    if (!containsWordOrPhrase(title, term)) continue;
    if (AMBIGUOUS_CITY_TERMS.has(term) && !titleHasKentuckyContext) {
      continue;
    }
    return true;
  }

  return false;
}

function countKentuckyMentions(text: string, allowAmbiguousCities: boolean): number {
  if (!text) return 0;

  let count = 0;
  count += countMatches(text, /\bkentucky\b/gi);
  count += countMatches(text, /\bky\b/gi);
  count += countMatches(text, /\bkhsaa\b/gi);

  for (const { pattern } of COUNTY_PATTERNS) {
    count += countMatches(text, new RegExp(pattern.source, 'gi'));
  }

  for (const term of KY_REGION_TERMS) {
    count += countPhraseOccurrences(text, term);
  }

  for (const city of KY_CITY_TERMS) {
    if (AMBIGUOUS_CITY_TERMS.has(city) && !allowAmbiguousCities) continue;
    count += countPhraseOccurrences(text, city);
  }

  // Also allow existing city/county detector to contribute one mention when it can find a canonical hit.
  if (detectCounty(text)) count += 1;
  if (allowAmbiguousCities && detectCity(text)) count += 1;

  return count;
}

function shouldUseAiFallback(title: string, content: string, current: ClassificationResult): boolean {
  if (current.isKentucky && !current.county) return true;

  // Deterministic national but with weak Kentucky hints: let AI double-check.
  if (!current.isKentucky) {
    const text = `${title}\n${content}`;
    if (hasKentuckyOrKy(text)) return true;
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

function containsWordOrPhrase(haystack: string, phrase: string): boolean {
  if (phrase.includes(' ')) {
    return haystack.includes(phrase);
  }
  const re = new RegExp(`\\b${escapeRegExp(phrase)}\\b`, 'i');
  return re.test(haystack);
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
