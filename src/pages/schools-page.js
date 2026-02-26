import React from "react";
import CategoryFeedPage from "./category-feed-page";

function isLikelySchoolsArticle(post) {
  const text = `${post?.title || ""} ${post?.shortDesc || ""}`.toLowerCase();
  const strongSignal =
    /\b(school board|board of education|school district|superintendent|high school|middle school|elementary school|public schools?)\b/i.test(text);
  const signals = text.match(/\b(school|schools|district|education|student|students|teacher|teachers|classroom|principal|superintendent|board|campus|bus routes?)\b/gi) || [];
  return strongSignal || signals.length >= 3;
}

export default function SchoolsPage() {
  return (
    <CategoryFeedPage
      category="schools"
      title="Kentucky Schools"
      filterPosts={isLikelySchoolsArticle}
    />
  );
}
