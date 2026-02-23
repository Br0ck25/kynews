import type { Category, ClassificationResult } from '../types';
import { detectKentuckyGeo } from './geo';
import { KY_COUNTIES } from '../data/ky-geo';

type AiResultLike = {
  response?: string;
  result?: { response?: string };
  output_text?: string;
  choices?: Array<{ message?: { content?: string | null } }>;
};

const VALID_AI_CATEGORIES = new Set<string>(['sports', 'weather', 'schools', 'obituaries', 'today', 'national']);

/**
 * AI-powered classification using GLM-4.7-Flash.
 * Reads the article title and content to determine category, Kentucky presence,
 * and county. Falls back to keyword-based classifyArticle if AI fails.
 */
export async function classifyArticleWithAi(
  env: Env,
  input: { url: string; title: string; content: string },
): Promise<ClassificationResult> {
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
      `Title: ${input.title}`,
      '',
      `Content: ${input.content.slice(0, 1200)}`,
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

    const category = VALID_AI_CATEGORIES.has(parsed.category ?? '') ? (parsed.category as Category) : null;
    if (!category) throw new Error(`AI returned invalid category: ${parsed.category}`);

    const isKentucky = typeof parsed.isKentucky === 'boolean' ? parsed.isKentucky : false;
    const county = parsed.county && parsed.county !== 'null' && parsed.county.length > 1 ? parsed.county : null;

    return { isKentucky, county, city: null, category };
  } catch {
    // AI unavailable or returned unparseable response — fall back to keyword classification
    return classifyArticle(input);
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

const FACEBOOK_EXEMPT_HOSTS = ['facebook.com', 'fb.watch', 'm.facebook.com'];

export function classifyArticle(input: {
  url: string;
  title: string;
  content: string;
}): ClassificationResult {
  const text = `${input.title}\n${input.content}`;
  const geo = detectKentuckyGeo(text);

  const semanticCategory = detectSemanticCategory(text);

  const category: Category = semanticCategory ?? (geo.isKentucky ? 'today' : 'national');

  return {
    isKentucky: geo.isKentucky,
    county: geo.county,
    city: geo.city,
    category,
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
  if (wordCount >= minimum) return true;

  try {
    const host = new URL(url).hostname.toLowerCase();
    return FACEBOOK_EXEMPT_HOSTS.some((allowedHost) =>
      host === allowedHost || host.endsWith(`.${allowedHost}`),
    );
  } catch {
    return false;
  }
}
