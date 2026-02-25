import React from "react";
import { useParams } from "react-router-dom";
import { slugToCounty } from "../utils/functions";
import CountyPage from "./county-page";
import ArticleSlugPage from "./article-slug-page";

/**
 * Dispatcher for /news/kentucky/:countySlug
 *
 * - If the URL segment ends with -county and maps to a known KY county
 *   (e.g. fayette-county) → render the CountyPage.
 * - Otherwise, treat the segment as an article slug
 *   (e.g. school-board-meeting-ab12cd34) → render ArticleSlugPage.
 */
export default function KentuckyNewsPage() {
  const { countySlug } = useParams();
  const county = slugToCounty(countySlug || "");

  if (county) {
    // Valid county slug → show county page
    return <CountyPage />;
  }

  // Not a county slug → treat as an article slug
  return <ArticleSlugPage />;
}
