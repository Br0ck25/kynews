/**
 * Known search-engine and social-media crawler user-agent substrings.
 * The regex is compiled once at module load so repeated calls are fast.
 */
const SEARCH_BOT_PATTERN =
	/Googlebot|Googlebot-Image|Googlebot-Video|Googlebot-News|AdsBot-Google|Google-InspectionTool|Google-Read-Aloud|bingbot|BingPreview|msnbot|DuckDuckBot|DuckDuckGo-Favicons-Bot|Applebot|Applebot-Extended|LinkedInBot|Pinterestbot|Twitterbot|facebookexternalhit|FacebookBot|Slackbot-LinkExpanding|Discordbot|WhatsApp|Telegrambot|ia_archiver|Sogou|Bytespider|Yandex|Baiduspider|YahooSeeker|Slurp/i;

/**
 * Returns true when the supplied User-Agent string belongs to a recognised
 * search-engine or social-media crawler.  Returns false for normal browsers
 * and for empty / undefined values.
 */
export function isSearchBot(userAgent: string): boolean {
	if (!userAgent) return false;
	return SEARCH_BOT_PATTERN.test(userAgent);
}
