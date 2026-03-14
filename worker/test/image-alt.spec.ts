import { describe, it, expect } from 'vitest';
import { generateImageAlt } from '../src/lib/ingest';

describe('generateImageAlt', () => {
  it('uses subjectMap for sports category with a county', () => {
    const result = generateImageAlt('Pikeville Panthers Win District Title', 'Pike', 'sports');
    expect(result).toBe('Athletes competing in Pike County, Kentucky — Pikeville Panthers Win District Title');
  });

  it('falls back to "in Kentucky" when county is null', () => {
    const result = generateImageAlt('State Championship Results', null, 'sports');
    expect(result).toBe('Athletes competing in Kentucky — State Championship Results');
  });

  it('truncates titles longer than 60 characters to 57 chars + ellipsis', () => {
    const longTitle = 'A Very Long Article Title That Exceeds Sixty Characters By Quite A Lot';
    const result = generateImageAlt(longTitle, 'Fayette', 'government');
    const shortTitle = longTitle.slice(0, 57) + '…';
    expect(shortTitle.length).toBe(58);
    expect(result).toBe(`Government officials in Fayette County, Kentucky — ${shortTitle}`);
  });

  it('does not truncate titles exactly 60 characters long', () => {
    const sixtyChars = 'A'.repeat(60);
    const result = generateImageAlt(sixtyChars, null, 'weather');
    expect(result).toBe(`Weather conditions in Kentucky — ${'A'.repeat(60)}`);
  });

  it('uses "News scene" for an unmapped category', () => {
    const result = generateImageAlt('Breaking News Story', 'Harlan', 'business');
    expect(result).toBe('News scene in Harlan County, Kentucky — Breaking News Story');
  });

  it('handles schools category', () => {
    const result = generateImageAlt('New School Opens', 'Breathitt', 'schools');
    expect(result).toBe('Students and educators in Breathitt County, Kentucky — New School Opens');
  });

  it('handles public_safety category', () => {
    const result = generateImageAlt('Fire Destroys Home', null, 'public_safety');
    expect(result).toBe('Emergency responders in Kentucky — Fire Destroys Home');
  });

  it('handles obituaries category', () => {
    const result = generateImageAlt('John Doe, 85, Passes Away', 'Perry', 'obituaries');
    expect(result).toBe('Memorial photo in Perry County, Kentucky — John Doe, 85, Passes Away');
  });
});
