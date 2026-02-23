import { KY_CITY_TO_COUNTY, KY_COUNTIES } from '../data/ky-geo';

const COUNTY_SET = new Set<string>(KY_COUNTIES.map((c) => c.toLowerCase()));
const KY_KEYWORDS = [
  'kentucky',
  'commonwealth of kentucky',
  'ky',
  ...KY_COUNTIES.map((county) => `${county.toLowerCase()} county`),
];

export interface GeoDetection {
  isKentucky: boolean;
  county: string | null;
  city: string | null;
}

export function detectKentuckyGeo(input: string): GeoDetection {
  const haystack = normalizeForSearch(input);
  const county = detectCounty(haystack);
  if (county) {
    return {
      isKentucky: true,
      county,
      city: null,
    };
  }

  const city = detectCity(haystack);
  if (city) {
    return {
      isKentucky: true,
      county: KY_CITY_TO_COUNTY[city] ?? null,
      city,
    };
  }

  const isKentucky = KY_KEYWORDS.some((token) => {
    if (token === 'ky') {
      return /\bky\b/.test(haystack);
    }
    return haystack.includes(token);
  });

  return {
    isKentucky,
    county: null,
    city: null,
  };
}

export function detectCounty(input: string): string | null {
  const normalized = normalizeForSearch(input);

  for (const county of KY_COUNTIES) {
    const token = `${county.toLowerCase()} county`;
    if (normalized.includes(token)) return county;
  }

  return null;
}

export function detectCity(input: string): string | null {
  const normalized = normalizeForSearch(input);
  for (const city of Object.keys(KY_CITY_TO_COUNTY)) {
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

function normalizeForSearch(input: string): string {
  return ` ${input.toLowerCase().replace(/[^a-z0-9\s]/g, ' ')} `.replace(/\s+/g, ' ');
}
