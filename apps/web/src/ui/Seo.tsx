import React from "react";
import { Helmet } from "react-helmet-async";

const DEFAULT_SITE_URL = String(import.meta.env.VITE_SITE_URL || "https://localky.news").replace(/\/+$/g, "");

export type SeoJsonLd = Record<string, unknown>;

export type SeoMetaProps = {
  title: string;
  description: string;
  path?: string;
  url?: string;
  type?: "website" | "article";
  image?: string;
  publishedTime?: string;
  robots?: string;
  jsonLd?: SeoJsonLd | SeoJsonLd[];
};

export function getSiteUrl() {
  return DEFAULT_SITE_URL;
}

export function absoluteUrl(pathOrUrl?: string): string {
  if (pathOrUrl && /^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;

  const fallbackPath = pathOrUrl || "/";
  if (typeof window !== "undefined") {
    const base = window.location.origin;
    try {
      return new URL(fallbackPath || `${window.location.pathname}${window.location.search}`, base).toString();
    } catch {
      return new URL("/", base).toString();
    }
  }

  try {
    return new URL(fallbackPath, DEFAULT_SITE_URL).toString();
  } catch {
    return `${DEFAULT_SITE_URL}/`;
  }
}

export function stripHtml(input?: string | null) {
  if (!input) return "";
  return String(input)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function metaDescription(input?: string | null, maxLength = 155) {
  const text = stripHtml(input || "");
  if (!text) return "";
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function StructuredData({ jsonLd }: { jsonLd: SeoJsonLd | SeoJsonLd[] }) {
  const entries = Array.isArray(jsonLd) ? jsonLd : [jsonLd];
  return (
    <Helmet>
      {entries.map((entry, idx) => (
        <script key={`ld-json-${idx}`} type="application/ld+json">
          {JSON.stringify(entry)}
        </script>
      ))}
    </Helmet>
  );
}

export function SeoMeta({
  title,
  description,
  path,
  url,
  type = "website",
  image,
  publishedTime,
  robots = "index, follow",
  jsonLd
}: SeoMetaProps) {
  const canonical = absoluteUrl(url || path);
  const ogImage = image ? absoluteUrl(image) : undefined;
  const entries = jsonLd ? (Array.isArray(jsonLd) ? jsonLd : [jsonLd]) : [];

  return (
    <Helmet>
      <title>{title}</title>
      <meta name="description" content={description} />
      <meta name="robots" content={robots} />
      <link rel="canonical" href={canonical} />
      <meta property="og:title" content={title} />
      <meta property="og:description" content={description} />
      <meta property="og:url" content={canonical} />
      <meta property="og:type" content={type} />
      {ogImage ? <meta property="og:image" content={ogImage} /> : null}
      {type === "article" && publishedTime ? <meta property="article:published_time" content={publishedTime} /> : null}
      {entries.map((entry, idx) => (
        <script key={`seo-ld-json-${idx}`} type="application/ld+json">
          {JSON.stringify(entry)}
        </script>
      ))}
    </Helmet>
  );
}
