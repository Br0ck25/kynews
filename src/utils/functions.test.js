import { countyToSlug, slugToCounty } from './functions';
import { KENTUCKY_COUNTIES } from '../constants/counties';

describe('county slug helpers', () => {
  it('converts names to kebab-case slugs and always appends -county', () => {
    expect(countyToSlug('Jefferson')).toBe('jefferson-county');
    expect(countyToSlug('Jefferson County')).toBe('jefferson-county');
    expect(countyToSlug(' McCracken  County ')).toBe('mccracken-county');
    expect(countyToSlug('LaRue')).toBe('larue-county');
    expect(countyToSlug('LaRue County')).toBe('larue-county');
    expect(countyToSlug('')).toBe('');
    expect(countyToSlug(null)).toBe('');
  });

  it('converts slugs back into county names', () => {
    const examples = [
      'jefferson-county',
      'mccracken-county',
      'larue-county',
    ];

    examples.forEach((slug) => {
      const name = slugToCounty(slug);
      expect(name).toBeTruthy();
      // roundtrip
      expect(countyToSlug(name)).toBe(slug);
    });
  });

  it('returns empty string for unknown slugs', () => {
    expect(slugToCounty('not-a-county')).toBe('');
  });
});

// additional tests for the tag helper
import { getPostTags } from './functions';

describe('post tag helper', () => {
  it('builds appropriate tags for Kentucky articles', () => {
    const post = { isKentucky: true, county: 'Boone', tags: ['special'] };
    expect(getPostTags(post)).toEqual(['Kentucky', 'Boone', 'special']);
  });

  it('defaults to National for non-KY articles and handles multiple counties', () => {
    const post = { isKentucky: false, county: 'Campbell, Kenton' };
    // county present overrides national; still labelled "Kentucky"
    expect(getPostTags(post)).toEqual(['Kentucky', 'Campbell', 'Kenton']);
  });

  it('treats posts with county as Kentucky even if isKentucky=false', () => {
    const post = { isKentucky: false, county: 'Boone' };
    expect(getPostTags(post)).toEqual(['Kentucky', 'Boone']);
  });
  
  it('returns National only when no county and not Kentucky', () => {
    const post = { isKentucky: false, county: '' };
    expect(getPostTags(post)).toEqual(['National']);
  });

  it('deduplicates tags and ignores invalid entries', () => {
    const post = { isKentucky: true, county: 'Boone', tags: ['Boone', '', null] };
    expect(getPostTags(post)).toEqual(['Kentucky', 'Boone']);
  });
});
