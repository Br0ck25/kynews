export const BASE_URL = 'https://localkynews.com';

export const TODAY_RSS_LIMIT = 100;

export function countyNameToSlug(countyName: string): string {
	let cleaned = countyName.trim();
	if (!/county$/i.test(cleaned)) cleaned += ' County';
	return cleaned.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function buildArticleUrl(
	baseUrl: string,
	slug: string | null,
	county: string | null,
	category: string,
	isNational: boolean,
	id: number,
): string {
	if (!slug) return `${baseUrl}/post?articleId=${id}`;
	if (county) return `${baseUrl}/news/kentucky/${countyNameToSlug(county)}/${slug}`;
	// anything marked national or explicitly category 'national' goes in national path
	if (isNational || category === 'national') return `${baseUrl}/news/national/${slug}`;
	return `${baseUrl}/news/kentucky/${slug}`;
}
