import { describe, expect, it, vi } from 'vitest';
import { summarizeArticle, isScheduleOrScoresArticle } from '../src/lib/ai';

function makeEnv(aiResponse: string): Env {
  return {
    AI: {
      run: vi.fn().mockResolvedValue({ response: aiResponse }),
    },
    CACHE: undefined,
  } as unknown as Env;
}

describe('summary sanitization', () => {
  it('removes published/photo boilerplate and decodes HTML entities', async () => {
    const env = makeEnv(
      [
        'Published 8:31 pm Wednesday, February 25, 2026',
        'Photo by Kim Henson',
        'Carolyn taught in the Daviess&#160; County School System and later moved to Louisville where she continued teaching.',
        '"We had a great turnout.',
        'She later worked in real estate and finished at National City Bank while maintaining friendships from earlier roles.',
      ].join('\n'),
    );

    const source = [
      'Carolyn taught in the Daviess County School System before moving to Louisville.',
      'After teaching, she worked in real estate and later at National City Bank.',
      'She stayed connected with colleagues and friends throughout retirement.',
    ].join(' ');

    const result = await summarizeArticle(
      env,
      'unit-sanitize-1',
      'Carolyn Head Hood passed away peacefully',
      source,
      new Date().toISOString(),
    );

    expect(result.summary).not.toMatch(/Published/i);
    expect(result.summary).not.toMatch(/Photo by/i);
    expect(result.summary).not.toContain('&#160;');
    expect(result.summary).toContain('Daviess County');
  });

  it('merges paragraph breaks that split a sentence after abbreviations', async () => {
    const env = makeEnv(
      [
        'Former ambassador to China and former Gov.',
        '',
        'S. Rep. Greg Ganske spoke during the update to the board.',
        'Regent Christine Hensley said the model is unique within Iowa and the country.',
      ].join('\n'),
    );

    const source = [
      'The Center for Intellectual Freedom presented an update to the board.',
      'Former ambassador to China and former Gov. Terry Branstad and former U.S. Rep. Greg Ganske were mentioned.',
      'Regent Christine Hensley discussed policy development and leadership recruitment for the center.',
    ].join(' ');

    const result = await summarizeArticle(
      env,
      'unit-sanitize-2',
      'Center update presented to board',
      source,
      new Date().toISOString(),
    );

    expect(result.summary).not.toMatch(/\n\nS\. Rep\./);
    expect(result.summary).toMatch(/Gov\. S\. Rep\./);
  });

  it('never starts a paragraph with a comma', async () => {
    const env = makeEnv(
      [
        'The board adopted a revised transportation policy after public feedback.',
        '',
        ', district leaders said the change will reduce delays during peak routes.',
        'Families will receive updated schedules before the next grading period.',
      ].join('\n'),
    );

    const source = [
      'The district reviewed bus arrival data and heard feedback from parents.',
      'Leaders approved route changes intended to improve consistency and reduce delays.',
      'Updated schedules will be distributed ahead of the next grading period.',
    ].join(' ');

    const result = await summarizeArticle(
      env,
      'unit-sanitize-3',
      'District updates transportation policy',
      source,
      new Date().toISOString(),
    );

    const paragraphs = result.summary.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    expect(paragraphs.every((p) => !/^[,;:)\]]/.test(p))).toBe(true);
  });

  it('does not truncate at abbreviation boundaries like U.S. or D.C.', async () => {
    const env = makeEnv(
      'In 2023, 11 percent of the 17.6 million U.S. veterans were women and the number has grown over time',
    );

    const source = [
      'In 2023, 11 percent of the 17.6 million U.S. veterans were women.',
      'State officials said the trend reflects growing service participation by women.',
    ].join(' ');

    const result = await summarizeArticle(
      env,
      'unit-sanitize-4',
      'Veteran population update',
      source,
      new Date().toISOString(),
    );

    expect(result.summary).toContain('U.S. veterans were women');
    expect(result.summary).toMatch(/women and the number has grown over time\.$/);
  });

  it('flags betting/odds content as unsummarizable via schedule detector', () => {
    const base = 'Kentucky vs Vanderbilt odds; spread, money line, sportsbook promo code';
    expect(isScheduleOrScoresArticle(base)).toBe(true);
  });
});
