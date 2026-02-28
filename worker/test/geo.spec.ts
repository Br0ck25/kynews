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

  // edge-case tests added for the recent geo fixes
  it('ignores ambiguous county names without KY context', () => {
    expect(detectAllCounties('Todd County fair is coming', 'Todd County fair is coming')).toEqual([]);
    expect(detectAllCounties('The Ohio River flows by here', 'The Ohio River flows by here')).toEqual([]);
  });

  it('requires KY context and no out-of-state signal for ambiguous counties', () => {
    expect(detectAllCounties('Todd County in Kentucky', 'Todd County in Kentucky')).toEqual(['Todd']);
    const text = 'Todd County near Ohio River in Kentucky';
    expect(detectAllCounties(text, text)).toEqual([]);
  });

  it('does not misidentify a county from a substring in Pass B lists', () => {
    expect(detectAllCounties('Leesburg and Laurel County officials')).toEqual(['Laurel']);
  });

  it('does not reject a Kentucky county simply because "georgia" appears inside Georgetown', () => {
    const text = 'Scott County meeting near Georgetown';
    expect(detectAllCounties(text, text)).toEqual(['Scott']);
  });

  it('handles plural “counties” forms correctly', () => {
    expect(detectAllCounties('Knox and Laurel Counties')).toEqual(['Knox','Laurel']);
    expect(detectAllCounties('Pike, Floyd, and Knott counties')).toEqual([
      'Pike','Floyd','Knott',
    ]);
  });

  it('splits hyphenated or slash-separated county lists', () => {
    expect(detectAllCounties('Knox/Laurel County')).toEqual(['Knox','Laurel']);
    expect(detectAllCounties('Knox-Laurel-Clay County in Kentucky')).toEqual([
      'Knox','Laurel','Clay',
    ]);
  });

  // new Pass C school-name patterns
  it('detects county names in directional school phrases when sports context exists', () => {
    const text = 'North Laurel breezed by Clay County, 66-41';
    expect(detectAllCounties(text)).toEqual(['Clay', 'Laurel']);

    expect(detectAllCounties('South Warren defeated North Hardin in overtime')).toEqual([
      'Warren', 'Hardin',
    ]);
  });

  it('does not double-count when county appears with "County" suffix already', () => {
    expect(detectAllCounties('Clay County High School defeated Pike Central')).toEqual([
      'Clay', 'Pike',
    ]);
  });

  it('handles suffix school names even without explicit sports context', () => {
    expect(detectAllCounties('Johnson Central beat Knott Central 54-48')).toEqual([
      'Johnson', 'Knott',
    ]);
  });

  it('does not match directional pattern without school/sports context', () => {
    expect(detectAllCounties('She moved to Western Hills neighborhood')).toEqual([]);
    expect(detectAllCounties('North Carolina defeated South Carolina')).toEqual([]);
  });

  it('does not auto-detect generic noise city names', () => {
    expect(detectCity('A story from Bliss, Kentucky')).toBe(null);
  });

  it('suppresses city matches that are part of a federal district phrase', () => {
    expect(detectCity('The U.S. Attorney for the Eastern District of Kentucky spoke')).toBe(null);
  });

  it('returns multiple counties for a city that spans them when context is present', () => {
    const geo = detectKentuckyGeo('Police in Corbin responded to a call');
    expect(geo.counties).toEqual(['Whitley','Knox','Laurel']);
    expect(geo.county).toBe('Whitley');
  });
});
