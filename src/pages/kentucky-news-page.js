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
  const { countySlug, infoType } = useParams();
  const county = slugToCounty(countySlug || "");

  if (!county) {
    // not a county, treat as article slug
    return <ArticleSlugPage />;
  }

  // we have a county; decide what second segment means
  if (!infoType) {
    return <CountyPage countySlugProp={countySlug} />;
  }

  const infoPages = new Set(["government-offices", "utilities"]);
  if (infoPages.has(infoType)) {
    return <CountyPage countySlugProp={countySlug} infoType={infoType} />;
  }

  // anything else under county is interpreted as article slug
  return <ArticleSlugPage />;
}
