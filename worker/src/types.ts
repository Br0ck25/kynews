export const ALLOWED_CATEGORIES = [
  'today',
  'national',
  'sports',
  'weather',
  'schools',
  'obituaries',
] as const;

export type Category = (typeof ALLOWED_CATEGORIES)[number];

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
  county: string | null;
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
  county: string | null;
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
  category: Category;
  county: string | null;
  city: string | null;
}

export interface SummaryResult {
  summary: string;
  seoDescription: string;
  summaryWordCount: number;
}

export interface ArticleListResponse {
  items: ArticleRecord[];
  nextCursor: string | null;
}
