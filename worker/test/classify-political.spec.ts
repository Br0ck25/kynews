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
});
