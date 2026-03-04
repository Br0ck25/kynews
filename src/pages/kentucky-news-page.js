import React from "react";
import { useParams } from "react-router-dom";
import { slugToCounty } from "../utils/functions";
import CountyPage from "./county-page";
import ArticleSlugPage from "./article-slug-page";

/**
 * Dispatcher for /news/kentucky/:countySlug
 *
 * Routing is a little tricky because the site supports four different
 * patterns:
 *   /news/kentucky/:countySlug                (county homepage)
 *   /news/kentucky/:countySlug/:infoType      (info pages under a county)
 *   /news/kentucky/:countySlug/:articleSlug   (county-specific story)
 *   /news/kentucky/:articleSlug               (statewide story)
 *
 * The first two patterns are handled here.  The latter two are now defined
 * explicitly in <App /> so React Router will mount <ArticleSlugPage />, but
 * we still render that component for any other unexpected second segment.
 * The article page itself figures out the slug by peeking at the last path
 * segment rather than trusting a particular param name.
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
