import { cachedTextFetch, toIsoDate } from './http';

export interface RssItem {
  title: string;
  link: string;
  publishedAt: string;
  description?: string;
}

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
  const fetched = await cachedTextFetch(env, feedUrl, 600);
  if (fetched.status >= 400) return [];

  const xml = fetched.body;
  const items = parseTagBlocks(xml, 'item').map((itemXml) => {
    const link = decodeXmlEntity(firstTagValue(itemXml, 'link') ?? '');
    return {
      title: decodeXmlEntity(firstTagValue(itemXml, 'title') ?? 'Untitled'),
      link,
      publishedAt: toIsoDate(firstTagValue(itemXml, 'pubDate')),
      description: decodeXmlEntity(firstTagValue(itemXml, 'description') ?? ''),
    } satisfies RssItem;
  });

  if (items.length > 0) {
    return items.filter((it) => Boolean(it.link));
  }

  // Atom fallback
  return parseTagBlocks(xml, 'entry')
    .map((entryXml) => {
      const rawLink =
        /<link[^>]+href=["']([^"']+)["'][^>]*\/?>(?:<\/link>)?/i.exec(entryXml)?.[1] ?? '';
      return {
        title: decodeXmlEntity(firstTagValue(entryXml, 'title') ?? 'Untitled'),
        link: decodeXmlEntity(rawLink),
        publishedAt: toIsoDate(firstTagValue(entryXml, 'updated') ?? firstTagValue(entryXml, 'published')),
        description: decodeXmlEntity(firstTagValue(entryXml, 'summary') ?? ''),
      } satisfies RssItem;
    })
    .filter((it) => Boolean(it.link));
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
