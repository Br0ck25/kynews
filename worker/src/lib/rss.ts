import { cachedTextFetch, toIsoDateOrNull } from './http';

export interface RssItem {
  title: string;
  link: string;
  publishedAt: string | null;
  description?: string;
}

const MAX_SITEMAP_RECURSION_DEPTH = 2;
const MAX_SITEMAP_CHILDREN = 20;
const MAX_ITEMS_PER_SITEMAP = 300;

export async function resolveFeedUrls(env: Env, sourceUrl: string): Promise<string[]> {
  const candidates = new Set<string>();
  candidates.add(sourceUrl);

  for (const suffix of ['/feed', '/rss', '/rss.xml', '/feed.xml', '/index.xml']) {
    try {
      candidates.add(new URL(suffix, sourceUrl).toString());
    } catch {
      // ignore invalid source URL
    }
  }

  const html = await cachedTextFetch(env, sourceUrl).catch(() => null);
  if (html?.body) {
    const matches = html.body.matchAll(/<link[^>]+type=["']application\/(?:rss|atom)\+xml["'][^>]*>/gi);
    for (const match of matches) {
      const href = /href=["']([^"']+)["']/i.exec(match[0])?.[1];
      if (!href) continue;
      try {
        candidates.add(new URL(href, sourceUrl).toString());
      } catch {
        // ignore bad href
      }
    }
  }

  return [...candidates];
}

export async function fetchAndParseFeed(env: Env, feedUrl: string): Promise<RssItem[]> {
  return fetchAndParseFeedInternal(env, feedUrl, new Set<string>(), 0);
}

async function fetchAndParseFeedInternal(
  env: Env,
  feedUrl: string,
  visited: Set<string>,
  depth: number,
): Promise<RssItem[]> {
  if (visited.has(feedUrl)) return [];
  visited.add(feedUrl);

  const fetched = await cachedTextFetch(env, feedUrl, 600);
  if (fetched.status >= 400) return [];

  const xml = fetched.body;
  const items = parseTagBlocks(xml, 'item').map((itemXml) => {
    const link = decodeXmlEntity(firstTagValue(itemXml, 'link') ?? '');
    return {
      title: decodeXmlEntity(firstTagValue(itemXml, 'title') ?? 'Untitled'),
      link,
      publishedAt: toIsoDateOrNull(firstTagValue(itemXml, 'pubDate')),
      description: decodeXmlEntity(firstTagValue(itemXml, 'description') ?? ''),
    } satisfies RssItem;
  });

  if (items.length > 0) {
    return items.filter((it) => Boolean(it.link));
  }

  // Atom fallback
  const atomItems = parseTagBlocks(xml, 'entry')
    .map((entryXml) => {
      const rawLink =
        /<link[^>]+href=["']([^"']+)["'][^>]*\/?>(?:<\/link>)?/i.exec(entryXml)?.[1] ?? '';
      return {
        title: decodeXmlEntity(firstTagValue(entryXml, 'title') ?? 'Untitled'),
        link: decodeXmlEntity(rawLink),
        publishedAt: toIsoDateOrNull(firstTagValue(entryXml, 'updated') ?? firstTagValue(entryXml, 'published')),
        description: decodeXmlEntity(firstTagValue(entryXml, 'summary') ?? ''),
      } satisfies RssItem;
    })
    .filter((it) => Boolean(it.link));

  if (atomItems.length > 0) {
    return atomItems;
  }

  // Sitemap index (common for Arc/Gray TV sites like WYMT)
  if (/<sitemapindex\b/i.test(xml) && depth < MAX_SITEMAP_RECURSION_DEPTH) {
    const sitemapUrls = extractLocValues(xml).slice(0, MAX_SITEMAP_CHILDREN);
    const aggregated: RssItem[] = [];
    const seenLinks = new Set<string>();

    for (const sitemapUrl of sitemapUrls) {
      const childItems = await fetchAndParseFeedInternal(env, sitemapUrl, visited, depth + 1);
      for (const item of childItems) {
        if (!item.link || seenLinks.has(item.link)) continue;
        seenLinks.add(item.link);
        aggregated.push(item);
      }
    }

    return aggregated;
  }

  // Sitemap urlset with <url><loc>...</loc></url>
  if (/<urlset\b/i.test(xml)) {
    const urlBlocks = parseTagBlocks(xml, 'url').slice(0, MAX_ITEMS_PER_SITEMAP);
    return urlBlocks
      .map((urlXml) => {
        const loc = decodeXmlEntity(firstTagValue(urlXml, 'loc') ?? '');
        if (!loc) return null;
        const lastMod =
          firstTagValue(urlXml, 'lastmod') ||
          firstTagValue(urlXml, 'publication_date') ||
          firstTagValue(urlXml, 'updated') ||
          null;

        return {
          title: deriveTitleFromUrl(loc),
          link: loc,
          publishedAt: toIsoDateOrNull(lastMod),
          description: '',
        } satisfies RssItem;
      })
      .filter((item): item is RssItem => Boolean(item?.link));
  }

  return [];
}

function parseTagBlocks(xml: string, tagName: string): string[] {
  const pattern = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'gi');
  const blocks: string[] = [];
  for (const match of xml.matchAll(pattern)) {
    if (match[1]) blocks.push(match[1]);
  }
  return blocks;
}

function firstTagValue(xml: string, tagName: string): string | null {
  const direct = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i').exec(xml)?.[1];
  if (direct) return direct;
  return null;
}

function decodeXmlEntity(input: string): string {
  return input
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .trim();
}

function extractLocValues(xml: string): string[] {
  const locs: string[] = [];
  const blockLocs = parseTagBlocks(xml, 'sitemap')
    .map((block) => decodeXmlEntity(firstTagValue(block, 'loc') ?? ''))
    .filter(Boolean);
  locs.push(...blockLocs);

  if (locs.length > 0) return locs;

  for (const match of xml.matchAll(/<loc[^>]*>([\s\S]*?)<\/loc>/gi)) {
    const value = decodeXmlEntity(match[1] ?? '');
    if (value) locs.push(value);
  }

  return [...new Set(locs)];
}

function deriveTitleFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split('/').filter(Boolean).pop() || parsed.hostname;
    return decodeURIComponent(last).replace(/[-_]+/g, ' ').trim() || 'Untitled';
  } catch {
    return 'Untitled';
  }
}
