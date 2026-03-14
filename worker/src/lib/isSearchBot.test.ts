import { describe, it, expect } from 'vitest';
import { isSearchBot } from './isSearchBot';

describe('isSearchBot', () => {
	it('returns true for Googlebot', () => {
		expect(
			isSearchBot(
				'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
			),
		).toBe(true);
	});

	it('returns true for bingbot', () => {
		expect(
			isSearchBot(
				'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
			),
		).toBe(true);
	});

	it('returns true for LinkedInBot', () => {
		expect(
			isSearchBot(
				'LinkedInBot/1.0 (compatible; Mozilla/5.0; Jakarta Commons-HttpClient/3.1 +http://www.linkedin.com)',
			),
		).toBe(true);
	});

	it('returns true for Applebot', () => {
		expect(
			isSearchBot(
				'Mozilla/5.0 (compatible; Applebot/0.1; +http://www.apple.com/go/applebot)',
			),
		).toBe(true);
	});

	it('returns false for a normal Chrome user-agent', () => {
		expect(
			isSearchBot(
				'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
			),
		).toBe(false);
	});

	it('returns false for an empty string', () => {
		expect(isSearchBot('')).toBe(false);
	});
});
