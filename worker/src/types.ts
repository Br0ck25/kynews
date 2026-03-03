export const ALLOWED_CATEGORIES = [
  'today',
  'national',
  'sports',
  'weather',
  'schools',
  'obituaries',
] as const;

// NOTE: `'all'` is not included in `ALLOWED_CATEGORIES` because it is
// not a real classification stored on articles; it is a virtual flag used
// by the public API when the caller wants to query every article regardless
// of category.  We widen the `Category` type to keep the compiler happy when
// that value is threaded through request handlers.
export type Category = (typeof ALLOWED_CATEGORIES)[number] | '' | 'all';

export interface ArticleRecord {
  id: number;
  canonicalUrl: string;
  sourceUrl: string;
  urlHash: string;
  title: string;
  author: string | null;
  publishedAt: string;
  category: Category;
  isKentucky: boolean;
  isNational: boolean;
  county: string | null;
  /**
   * All counties associated with the article. The first element is considered
   * the primary county and should always match the `county` field when that is
   * non-null.
   */
  counties: string[];
  city: string | null;
  summary: string;
  seoDescription: string;
  rawWordCount: number;
  summaryWordCount: number;
  contentText: string;
  contentHtml: string;
  imageUrl: string | null;
  rawR2Key: string | null;
  /** SEO-friendly URL slug derived from title + id. Added in migration 0004. */
  slug: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NewArticle {
  canonicalUrl: string;
  sourceUrl: string;
  urlHash: string;
  title: string;
  author: string | null;
  publishedAt: string;
  category: Category;
  isKentucky: boolean;
  isNational: boolean;
  county: string | null;
  /**
   * Optionally provide a list of counties for the new article. If omitted the
   * primary county will be inferred from `county`.
   */
  counties?: string[];
  city: string | null;
  summary: string;
  seoDescription: string;
  rawWordCount: number;
  summaryWordCount: number;
  contentText: string;
  contentHtml: string;
  imageUrl: string | null;
  rawR2Key: string | null;
  /** SEO-friendly URL slug derived from title + id. Optional — added in migration 0004. */
  slug?: string | null;
  /** SHA-256 hex of the article's content text (first 3k words) used for change detection */
  contentHash?: string;
}

export interface IngestSource {
  url: string;
  sourceUrl?: string;
  feedTitle?: string;
  feedPublishedAt?: string;
  providedTitle?: string;
  providedDescription?: string;
  allowShortContent?: boolean;
}

export interface IngestResult {
  status: 'inserted' | 'duplicate' | 'rejected';
  reason?: string;
  id?: number;
  urlHash?: string;
  category?: Category;
}

export interface ExtractedArticle {
  canonicalUrl: string;
  sourceUrl: string;
  title: string;
  author: string | null;
  publishedAt: string;
  contentHtml: string;
  contentText: string;
  classificationText: string;
  imageUrl: string | null;
}

export interface ClassificationResult {
  isKentucky: boolean;
  isNational: boolean;
  category: Category;
  /** primary county for backwards compatibility */
  county: string | null;
  /** all counties including primary; primary is first element when present */
  counties: string[];
  city: string | null;
}

export interface SummaryResult {
  summary: string;
  seoDescription: string;
  summaryWordCount: number;
  /** SHA-256 hex of the source content text at generation time, used for change detection */
  sourceHash?: string;
}

export interface ArticleListResponse {
  items: ArticleRecord[];
  nextCursor: string | null;
}
