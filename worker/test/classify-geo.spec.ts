import { describe, it, expect } from 'vitest';
import { detectKentuckyGeo } from '../src/lib/geo';

// These tests exercise the classification fallback path that relies on
// detectKentuckyGeo.  They exist separately from the large index.spec.ts file
// which has many Cloudflare-specific dependencies that are not available
// during the local worker tests.
// requires Cloudflare-specific test helpers not available in this environment.

describe('classification fallback geo integration', () => {
  it('returns multiple counties for shared-suffix enumerations', () => {
    const text = "Laurel and Knox County's Commonwealth's Attorney was mentioned.";
    const geo = detectKentuckyGeo(text);
    expect(geo.counties).toEqual(['Laurel', 'Knox']);
    expect(geo.county).toBe('Laurel');
  });

  it('still returns single county when enumeration not present', () => {
    const text = 'An event in Fayette County';
    const geo = detectKentuckyGeo(text);
    expect(geo.counties).toEqual(['Fayette']);
    expect(geo.county).toBe('Fayette');
  });
});
