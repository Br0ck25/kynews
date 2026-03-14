export const ALLOWED_CATEGORIES = [
  'today',
  'national',
  'sports',
  'weather',
  'schools',
  'obituaries',
] as const;

export type Category = (typeof ALLOWED_CATEGORIES)[number] | '';

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
  imageAlt: string | null;
  /** Pixel width of the og:image. Null when dimensions could not be determined. */
  imageWidth: number | null;
  /** Pixel height of the og:image. Null when dimensions could not be determined. */
  imageHeight: number | null;
  rawR2Key: string | null;
  /** SHA256 hash of scraped content used for update detection (nullable). */
  contentHash: string | null;
  /** SEO-friendly URL slug derived from title + id. Added in migration 0004. */
  slug: string | null;
  /** GeoJSON string of the NWS alert polygon geometry. Null for non-alert articles. */
  alertGeojson: string | null;
  /**
   * AI-generated Kentucky-focused context paragraph (150-250 words).
   * Null until the ingest AI pipeline populates it.
   * When non-empty, the article's canonical URL resolves to localkynews.com.
   */
  localIntro: string | null;
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
  imageAlt: string | null;
  /** Pixel width of the og:image. Null or omitted when dimensions could not be determined. */
  imageWidth?: number | null;
  /** Pixel height of the og:image. Null or omitted when dimensions could not be determined. */
  imageHeight?: number | null;
  rawR2Key: string | null;
  /** SEO-friendly URL slug derived from title + id. Optional — added in migration 0004. */
  slug?: string | null;
  /** SHA-256 hex of the article's content text (first 3k words) used for change detection */
  contentHash?: string;
  /** GeoJSON string of the NWS alert polygon geometry. Null or omitted for non-alert articles. */
  alertGeojson?: string | null;
  /**
   * AI-generated Kentucky-focused context paragraph (150-250 words).
   * When non-empty the stored canonical_url is overridden to
   * https://localkynews.com/news/[slug] at read time.
   */
  localIntro?: string | null;
}

export interface IngestSource {
  url: string;
  sourceUrl?: string;
  feedTitle?: string;
  feedPublishedAt?: string;
  providedTitle?: string;
  providedDescription?: string;
  allowShortContent?: boolean;
  /**
   * When true the caller only wants a preview of what would happen if the
   * URL were ingested.  The normal dedupe/classify/summarize pipeline runs,
   * but nothing is written to the database or R2.  The returned result will
   * still use the same `status` codes as a full insert.
   */
  preview?: boolean;
}

export interface IngestResult {
  status: 'inserted' | 'duplicate' | 'rejected';
  reason?: string;
  id?: number;
  urlHash?: string;
  category?: Category;
  /** SEO-friendly slug generated for the article (preview/insert only) */
  slug?: string | null;

  // preview-only fields.  These are populated on the new admin preview
  // endpoint so the UI can show the inferred title/summary/etc before the
  // article is actually stored.  They are all optional so existing callers
  // of `ingestSingleUrl` that ignore the extra properties continue to work.
  title?: string;
  summary?: string;
  seoDescription?: string;
  imageUrl?: string | null;
  publishedAt?: string;
  isKentucky?: boolean;
  isNational?: boolean;
  county?: string | null;
  counties?: string[];
  city?: string | null;
  contentText?: string;
  canonicalUrl?: string;
  sourceUrl?: string;
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
  /** How confident the system is in the county assignment.
   *  'low' = derived from a HIGH_AMBIGUITY_CITIES city with no explicit county mention.
   *  'medium' = derived from city with explicit KY signal nearby.
   *  'high' = explicit "X County" text found in article. */
  geoConfidence: 'high' | 'medium' | 'low' | null;
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
  /** non-breaking error indicator sent when the backend query failed */
  searchError?: string;
}

/** response from the admin image upload endpoint */
export interface ImageUploadResult {
  /** public path that will proxy the object from R2 */
  url: string;
  /** raw key stored in the R2 bucket (useful for debugging) */
  key: string;
}
