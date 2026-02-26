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

// facebook caption helpers
import {
  cleanHeadline,
  generateHook,
  generateFacebookCaption,
} from './functions';

describe('facebook caption helpers', () => {
  it('cleans trailing branding from headlines', () => {
    expect(cleanHeadline('Story title | Local KY News')).toBe('Story title');
    expect(cleanHeadline('Something – other')).toBe('Something');
    expect(cleanHeadline('No change')).toBe('No change');
  });

  it('generates a hook from summary and honors word limit', () => {
    const summary = 'First sentence. Second sentence here.';
    expect(generateHook(summary)).toBe('First sentence.');

    const long = new Array(50).fill('word').join(' ');
    const hook = generateHook(long);
    expect(hook.split(/\s+/).length).toBeLessThanOrEqual(41); // includes ellipsis
  });

  it('prefixes county if missing from hook', () => {
    const summary = 'A man walked down the street.';
    const hook = generateHook(summary, 'Jefferson');
    expect(hook.toLowerCase()).toContain('jefferson county');
  });

  it('builds full caption for ky articles and returns empty for non-ky', () => {
    const post = {
      title: 'County Event Happening',
      summary: 'Residents gather for a fair.',
      county: 'Fayette',
      slug: 'county-event-happening',
      categories: ['today'],
    };
    const caption = generateFacebookCaption(post);
    expect(caption).toContain('County Event Happening');
    expect(caption).toContain('Residents gather');
    expect(caption).toContain('#FayetteCounty');
    expect(caption).toContain('#KentuckyNews');
    expect(caption).toContain(SITE_URL);

    const national = { title: 'National', summary: 'Info', isKentucky: false };
    expect(generateFacebookCaption(national)).toBe('');
  });
});
