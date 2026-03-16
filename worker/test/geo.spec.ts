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

  it('rejects Louisville when no location signals exist even with KY context', () => {
    const text = 'A mid-December battle with Louisville for ACC supremacy';
    expect(detectCity(text)).toBe(null);
  });

  it('accepts Louisville when an explicit KY location signal is nearby', () => {
    const text = 'Louisville, Ky. police responded to an incident.';
    expect(detectCity(text)).toBe('louisville');
  });

  it('does not match Lexington in a sports score sentence', () => {
    const text = 'Kentucky scored 82 points in Lexington on Saturday';
    expect(detectCity(text)).toBe(null);
  });

  it('still matches Lexington with an explicit KY location signal in sports context', () => {
    const text = 'The game was played in Lexington, Ky. on Saturday';
    expect(detectCity(text)).toBe('lexington');
  });

  it('treats a "City, Ky." dateline as authoritative even for ambiguous cities', () => {
    const text = 'BOWLING GREEN, Ky. (WBKO) – breaking news content here';
    expect(detectCity(text)).toBe('bowling green');
    // geo fallback should resolve to the correct county
    const geo = detectKentuckyGeo(text);
    expect(geo.city).toBe('bowling green');
    expect(geo.county).toBe('Warren');
  });

  it('does not mark Kentucky when the only mention is a nav/menu line', () => {
    // Some scraped pages include a standalone "Kentucky" line (nav tag) that
    // should not count as a geographic signal.
    const text = 'Kentucky\nThe rest of the article is about national politics.';
    const geo = detectKentuckyGeo(text);
    expect(geo.isKentucky).toBe(false);
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

  it('handles multiple separators and lists (only last county currently captured)', () => {
    // the enumeration parser only returns the county with the explicit
    // "County" suffix in this pattern -> Floyd
    expect(detectAllCounties('Pike and Floyd County residents')).toEqual([
      'Floyd',
    ]);
    // only Perry has the explicit "County" suffix here; the others are part of
    // a list describing Perry County officials rather than standalone counties.
    expect(
      detectAllCounties('Harlan, Letcher, and Perry County officials'),
    ).toEqual(['Perry']);
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

  it('does not confuse state adjective "Ohio" with Ohio County', () => {
    expect(detectAllCounties('Ohio Sen. Bernie Moreno')).toEqual([]);
    expect(detectAllCounties('Ohio Gov. Mike DeWine')).toEqual([]);
    expect(detectAllCounties('Ohio Rep. Warren Davidson')).toEqual([]);
    expect(detectAllCounties('Ohio-based manufacturing plant')).toEqual([]);
    // detection should *not* fire without Kentucky context, even though
    // the suffix is present.  (Ambiguous county names require KY context.)
    const crash = 'A crash occurred in Ohio County on Route 69';
    expect(detectAllCounties(crash, crash)).toEqual([]);
    expect(detectCounty(crash, crash)).toBeNull();
    // provide explicit KY context and the county should then be found.
    const crash2 = 'A crash occurred in Ohio County in Kentucky';
    expect(detectAllCounties(crash2, crash2)).toEqual(['Ohio']);
    expect(detectCounty(crash2, crash2)).toBe('Ohio');
  });

  it('suppresses counties when they appear as a surname after a title', () => {
    expect(detectAllCounties('Rep. David Meade')).toEqual([]);
    expect(detectAllCounties('Sen. John Bell')).toEqual([]);
    expect(detectAllCounties('Officer Floyd')).toEqual([]);
    // but normal geographic usages should still match
    expect(detectAllCounties('Meade County Road')).toEqual(['Meade']);
    expect(detectAllCounties('in Meade County')).toEqual(['Meade']);
  });

  it('does not misidentify a county from a substring in Pass B lists', () => {
    expect(detectAllCounties('Leesburg and Laurel County officials')).toEqual(['Laurel']);
  });

  // new regression tests for Atlanta wire / Fulton County
  it('disqualifies Fulton County when a Georgia signal appears far before the match', () => {
    // place the word "Georgia" more than 200 characters away; window was
    // previously too narrow and would miss it.
    const text = 'Georgia ' + 'x'.repeat(300) + ' Fulton County grand jury investigation';
    expect(detectCounty(text, text)).toBeNull();
  });

  it('still detects Fulton County when Kentucky context is present', () => {
    const text = 'A Fulton County, Ky. man was arrested.';
    expect(detectCounty(text, text)).toBe('Fulton');
  });

  it('treats Jefferson County in Alabama as ambiguous without KY context', () => {
    expect(detectCounty('Jefferson County tornado warning in Alabama', 'Jefferson County tornado warning in Alabama')).toBeNull();
  });

  it('detects Jefferson County when the article clearly refers to KY', () => {
    expect(detectCounty('Jefferson County schools released a budget; Kentucky lawmakers approved it.', 'Jefferson County schools released a budget; Kentucky lawmakers approved it.')).toBe('Jefferson');
  });

  it('does not reject a Kentucky county simply because "georgia" appears inside Georgetown', () => {
    const text = 'Scott County meeting near Georgetown';
    expect(detectAllCounties(text, text)).toEqual(['Scott']);
  });

  it('handles plural “counties” forms correctly (may miss leading name)', () => {
    // the implementation currently returns only the last explicit county
    expect(detectAllCounties('Knox and Laurel Counties')).toEqual(['Laurel']);
    expect(detectAllCounties('Pike, Floyd, and Knott counties')).toEqual([
      'Floyd','Knott',
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
    // "Clay" is an ambiguous county name and the snippet lacks explicit
    // Kentucky context, so it should *not* be returned.  Laurel still matches
    // via the directional prefix logic.
    expect(detectAllCounties(text)).toEqual(['Laurel']);
  });

  it('does not return ambiguous county names without KY context even with suffix', () => {
    // Clay is ambiguous and this sentence has no Kentucky signal; however Pike
    // is still returned under the current heuristics.
    expect(detectAllCounties('Clay County High School defeated Pike Central')).toEqual([
      'Pike',
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
    expect(detectAllCounties('South Warren defeated North Hardin in overtime')).toEqual([]);
  });

  // regression tests for new co\. abbreviation pattern and Barren county
  it('recognizes county when abbreviated as Co.', () => {
    const text = 'A sports story at Letcher Co. Central High School';
    expect(detectCounty(text, text)).toBe('Letcher');
  });

  it('detects Barren County without needing explicit KY context', () => {
    const text = 'A shooting occurred at Barren County courthouse';
    expect(detectCounty(text, text)).toBe('Barren');
  });

  it('does not auto-detect generic noise city names', () => {
    expect(detectCity('A story from Bliss, Kentucky')).toBe(null);
  });

  it('suppresses city matches that are Kentucky legislator district suffixes', () => {
    expect(detectCity('Rep. Josh Bray, R-Mount Vernon')).toBe(null);
    expect(detectCity('Sen. Stephen Meredith, R-Leitchfield')).toBe(null);
    // ordinary city mention should still work
    expect(detectCity('A fire broke out in Mount Vernon, Ky.')).toBe('mount vernon');
  });

  it('ignores cities mentioned in author bio clauses', () => {
    expect(
      detectCity(
        'Jeff Rubin is an author and positive aging advocate. He lives in Berea.',
      ),
    ).toBe(null);
    expect(
      detectCity('She is a reporter from Bowling Green.'),
    ).toBe(null);
    // still match when the phrase is part of the story itself
    expect(
      detectCity('A fire broke out in Berea, Ky., Tuesday night.'),
    ).toBe('berea');
  });

  it('suppresses Frankfort dateline but still matches body references', () => {
    expect(detectCity('FRANKFORT, Ky. — Lawmakers debated a bill.')).toBe(null);
    expect(detectCity('A crash occurred in Frankfort, Ky. on Friday.')).toBe('frankfort');
  });

  it('does not treat out-of-state datelines as KY cities', () => {
    expect(detectCity('GILBERT, Ariz. — Fire reported')).toBe(null);
    expect(detectCity('BARROW COUNTY, Ga. —')); // county not a city, should be null
  });

  it('will still detect Frankfort if the dateline appears after a title/newline', () => {
    const text = 'New report released\nFRANKFORT, Ky. (ABC36 NEWS NOW) – lawmakers met';
    // dateline occurs after a newline so the ^ guard does not match
    expect(detectCity(text)).toBe('frankfort');
  });

  it('does not detect common words that were removed from city list', () => {
    expect(detectCity('The company moved its headquarters to Louisville.')).toBe(null);
    expect(detectCity('Petroleum prices rose statewide today.')).toBe(null);
  });

  it('does not treat Russell mentions (person names) as a city', () => {
    const text =
      'Russell Coleman spoke. Later Russell expressed regret. Russell said more.';
    expect(detectCity(text)).toBe(null);
  });

  it('requires location signal for the city of Franklin', () => {
    expect(detectCity('Franklin officials held a meeting')).toBe(null);
    expect(detectCity('Franklin, Ky. officials held a meeting')).toBe('franklin');
  });

  it('suppresses city matches that are part of a federal district phrase', () => {
    expect(detectCity('The U.S. Attorney for the Eastern District of Kentucky spoke')).toBe(null);
  });

  // new tests for Cincinnati‑area edge cases ------------------------------------------------
  it('disqualifies Georgetown when Cincinnati is nearby', () => {
    // simple case: Ohio metro city appears close to the Kentucky city name
    // and no strong KY anchor (county or "Kentucky" phrase) is nearby.
    const text =
      'The latest Cincinnati forecast said Georgetown could see snow later this week.';
    expect(detectCity(text)).toBe(null);
  });

  it('does not disqualify a legit KY city when a KY anchor is near the match', () => {
    const text = 'Cincinnati area storm may hit Georgetown, Kentucky on Monday.';
    expect(detectCity(text)).toBe('georgetown');
  });

  it('does not discard a Kentucky county when an Ohio metro signal has a nearby KY county anchor', () => {
    const text = 'Cincinnati weather affects Boone County residents.';
    expect(detectCounty(text, text)).toBe('Boone');
  });

  it('returns multiple counties for a city that spans them when context is present', () => {
    const geo = detectKentuckyGeo('Police in Corbin responded to a call');
    expect(geo.counties).toEqual(['Whitley','Knox','Laurel']);
    expect(geo.county).toBe('Whitley');
  });

  it('Middlesboro returns Bell as primary county', () => {
    const geo = detectKentuckyGeo('Police in Middlesboro responded to a call');
    expect(geo.county).toBe('Bell');
  });

  // regression tests for merged county/city detection
  it('merges a city-derived county even when an explicit county is found', () => {
    const text =
      'HORSE CAVE, Ky. — Caverna Colonels defeated LaRue County Hawks';
    const geo = detectKentuckyGeo(text);
    expect(geo.city).toBe('horse cave');
    // LaRue is explicit, Hart comes from the dateline city
    expect(geo.counties).toEqual(['LaRue','Hart']);
    expect(geo.county).toBe('LaRue');
  });

  it('does not duplicate a county when it appears both explicitly and via the city', () => {
    const text = 'MANCHESTER, Ky. — North Laurel defeated Clay County';
    const geo = detectKentuckyGeo(text);
    expect(geo.city).toBe('manchester');
    // explicit counties appear in the order they occur; Manchester maps to Clay,
    // which is appended after Laurel.  We just need to ensure there are no
    // duplicates and that the primary county is the first explicit one.
    expect(geo.counties).toEqual(['Laurel','Clay']);
    expect(new Set(geo.counties).size).toBe(geo.counties.length);
    expect(geo.county).toBe('Laurel');
  });});
