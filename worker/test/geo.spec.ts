import { describe, it, expect } from 'vitest';
import {
  detectCity,
  detectCounty,
  detectAllCounties,
  detectKentuckyGeo,
} from '../src/lib/geo';

// These are unit tests focused solely on the city→county lookup logic. The
// regression described in the issue occurred when a short single-word city
// ("Green", Elliott County) was accidentally matched before the longer
// multi-word city "Bowling Green" (Warren County).  The underlying data
// source is unchanged, so the tests exercise the matching algorithm itself.

describe('geo city matching', () => {
  it('prefers multi-word cities over substrings', () => {
    const text =
      'Morgan was kidnapped from her apartment complex in Bowling Green, Kentucky';

    expect(detectCity(text)).toBe('bowling green');
    // sanity check that the wrong county would have been returned by the old
    // implementation
    expect(detectCity(text)).not.toBe('green');
  });

  it('matches isolated single-word city when Kentucky context present', () => {
    const text = 'A story from Green, Kentucky mentions nothing else.';
    expect(detectCity(text)).toBe('green');
  });

  it('does not match substrings embedded in other words', () => {
    expect(detectCity('Residents of Evergreen celebrate')).toBe(null);
    expect(detectCity('The community of Greenbrier voted')).toBe(null);
  });
});

// county-focused tests

describe('county detection', () => {
  it('leaves original detectCounty unchanged for shared-suffix phrases', () => {
    const text = "Laurel and Knox County's Commonwealth's Attorney";
    expect(detectCounty(text, text)).toBe('Knox');
  });

  it('detectAllCounties handles shared-suffix enumerations', () => {
    const text = "Laurel and Knox County's Commonwealth's Attorney";
    expect(detectAllCounties(text, text)).toEqual(['Laurel', 'Knox']);
    const geo = detectKentuckyGeo(text);
    expect(geo.counties).toEqual(['Laurel', 'Knox']);
    expect(geo.county).toBe('Laurel');
  });

  it('handles multiple separators and lists', () => {
    expect(detectAllCounties('Pike and Floyd County residents')).toEqual([
      'Pike',
      'Floyd',
    ]);
    expect(
      detectAllCounties('Harlan, Letcher, and Perry County officials'),
    ).toEqual(['Harlan', 'Letcher', 'Perry']);
  });

  it('still finds a county when the sentence contains "in"', () => {
    const text = 'An event in Fayette County';
    expect(detectAllCounties(text, text)).toEqual(['Fayette']);
    const geo = detectKentuckyGeo(text);
    expect(geo.counties).toEqual(['Fayette']);
    expect(geo.county).toBe('Fayette');
  });
});
