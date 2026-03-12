import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { classifyArticleWithAi } from '../src/lib/classify';

// Regression test for bug where utility/infrastructure articles from hyperlocal
// sources (e.g. harlanenterprise.net) would lose their county when the
// enforceCategoryEvidence() helper reclassified them from "weather" →
// "today" due to a utility signal.  The classification pipeline now applies a
// final safety net that re-applies the SOURCE_DEFAULT_COUNTY value if the
// resulting county is null but the story is still marked Kentucky.

describe('source default county fallback', () => {
    it('preserves default county on utility-related story from harlanenterprise.net', async () => {
        const classification = await classifyArticleWithAi(env, {
            url: 'https://harlanenterprise.net/story',
            title: 'Weather alert: water treatment infrastructure upgrade near Virginia line',
            content: 'Officials announced a water treatment infrastructure project near the Virginia line. The piece never mentions Harlan County explicitly.',
        });

        expect(classification.category).toBe('today');
        expect(classification.isKentucky).toBe(true);
        expect(classification.county).toBe('Harlan');
    });
});
