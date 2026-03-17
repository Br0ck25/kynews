import { describe, it, expect } from 'vitest';
import { detectKentuckyGeo } from '../src/lib/geo';
import { classifyArticle } from '../src/lib/classify';

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

  it('maps Fleming-Neon to Letcher county', () => {
    const geo = detectKentuckyGeo('The story took place in Fleming-Neon.');
    expect(geo.counties).toEqual(['Letcher']);
    expect(geo.county).toBe('Letcher');
  });

  it('does not assign a county for bare "Fleming" without signal', () => {
    const geo = detectKentuckyGeo('Fleming is mentioned here but no context.');
    expect(geo.counties).toEqual([]);
    expect(geo.county).toBeNull();
  });

  it('does not classify a multi-state storm story as Kentucky', () => {
    const title = "Police search for Hardin County family's pet emu after strong storms";
    const body = "The Hardin County Sheriff's Office is asking for the public's assistance in locating a pet emu named Mystery that went missing after severe storms hit Kentucky and southern Indiana.";
    const result = classifyArticle(title, body);
    expect(result.category).toBe('national');
  });

  it('does not classify national stories as Kentucky when they reference R-Ky/D-Ky', () => {
    const title = 'Zelenskyy will discuss the matter with NATO';
    const body = "KYIV, Ukraine — President Volodymyr Zelenskyy spoke with NATO leaders. " +
      "Sen. Mitch McConnell, R-Ky., and Rep. John Yarmuth, D-Ky., also commented.";
    const result = classifyArticle(title, body);
    expect(result.category).toBe('national');
    expect(result.mentionCount).toBeLessThan(2);
  });
});
