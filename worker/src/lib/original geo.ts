// @ts-nocheck
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
      county: (KY_CITY_TO_COUNTY as any)[city] ?? null,
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
    const escaped = county.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const countyPattern = new RegExp(`\\b${escaped}\\s+(county|co|cnty)\\b`, 'i');
    if (countyPattern.test(normalized)) return county;
  }

  return null;
}

export function detectCity(input: string): string | null {
  const raw = String(input || '');
  const normalized = normalizeForSearch(raw);
  for (const city of Object.keys(KY_CITY_TO_COUNTY)) {
    const likelyCount = countCityMentions(normalized, city);
    if (likelyCount === 0) continue;

    const hasLocationSignals = hasLocationSignalNearby(normalized, city);
    const hasKentuckyContext = /\bkentucky\b|\bky\b/.test(normalized);

    if (!hasLocationSignals && !hasKentuckyContext && likelyCount < 2) {
      continue;
    }

    if (likelyCount === 1 && isLikelyPersonName(raw, city)) {
      continue;
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

function normalizeForSearch(input: string): string {
  return ` ${input.toLowerCase().replace(/[^a-z0-9\s]/g, ' ')} `.replace(/\s+/g, ' ');
}

function countCityMentions(normalizedInput: string, city: string): number {
  const re = city.includes(' ')
    ? new RegExp(city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')
    : new RegExp(`\\b${city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
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
    if (signals.some((signal) => windowText.includes(signal))) {
      return true;
    }
  }

  return false;
}

function isLikelyPersonName(rawInput: string, city: string): boolean {
  if (city.includes(' ')) return false;
  const escaped = city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const personRe = new RegExp(`\\b${escaped}\\s+[A-Z][a-z]{2,}\\b`);
  return personRe.test(rawInput);
}
