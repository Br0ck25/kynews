import type { Category, ClassificationResult } from '../types';
import { detectKentuckyGeo } from './geo';

const CATEGORY_PATTERNS: Record<Exclude<Category, 'today' | 'national'>, RegExp[]> = {
  sports: [
    /\bfootball\b/i,
    /\bbasketball\b/i,
    /\bbaseball\b/i,
    /\bsoccer\b/i,
    /\bsoftball\b/i,
    /\bwildcats\b/i,
    /\bcolonels\b/i,
    /\bsports?\b/i,
  ],
  weather: [
    /\bforecast\b/i,
    /\bweather\b/i,
    /\bstorm\b/i,
    /\btornado\b/i,
    /\bflood\b/i,
    /\bsnow\b/i,
    /\brain\b/i,
    /\btemperature\b/i,
  ],
  schools: [
    /\bschool\b/i,
    /\bboard of education\b/i,
    /\bclassroom\b/i,
    /\bstudent\b/i,
    /\bprincipal\b/i,
    /\bcollege\b/i,
    /\buniversity\b/i,
    /\bteacher\b/i,
    /\bcampus\b/i,
  ],
  obituaries: [
    /\bobituary\b/i,
    /\bobituaries\b/i,
    /\bfuneral\b/i,
    /\bmemorial service\b/i,
    /\bvisitation\b/i,
    /\bpassed away\b/i,
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
