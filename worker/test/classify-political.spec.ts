import { describe, it, expect } from 'vitest';
import { isStatewideKyPoliticalStory } from '../src/lib/classify';

describe('isStatewideKyPoliticalStory', () => {
  it('returns true for frankfort dateline', () => {
    expect(isStatewideKyPoliticalStory('Frankfort, Ky. — State capitol news')).toBe(true);
  });

  it('returns true when more than three distinct districts are mentioned', () => {
    const t = '94th District, 84th District and 92nd District representatives spoke today.';
    expect(isStatewideKyPoliticalStory(t)).toBe(true);
  });

  it('returns true for house bill mention with statewide context', () => {
    const t = 'House Bill 2 was filed in Frankfort amid debate statewide.';
    expect(isStatewideKyPoliticalStory(t)).toBe(true);
  });

  it('returns false for a single district mention', () => {
    expect(isStatewideKyPoliticalStory('94th District representative commented')).toBe(false);
  });

  it('returns true for multi-city event listings', () => {
    const t = 'Events in Lexington, Covington, Florence, and Dayton were announced today.';
    expect(isStatewideKyPoliticalStory(t)).toBe(true);
  });

  it('detects statewide when both a KY senator and KY representative are named in any order', () => {
    const t1 = 'Northern Kentucky is represented by U.S. Rep. Jane Doe and U.S. Sen. John Smith';
    const t2 = 'U.S. Sen. John Smith and U.S. Rep. Jane Doe spoke about policy in Kentucky';
    expect(isStatewideKyPoliticalStory(t1)).toBe(true);
    expect(isStatewideKyPoliticalStory(t2)).toBe(true);
  });

  it('flags Congressional district race coverage as statewide', () => {
    const t = 'The 4th Congressional district race in Kentucky drew national attention';
    expect(isStatewideKyPoliticalStory(t)).toBe(true);
  });
});
