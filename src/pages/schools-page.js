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
  React.useEffect(() => {
    document.title = 'Kentucky Schools News — Local KY News';
    let meta = document.querySelector('meta[name="description"]');
    if (!meta) { meta = document.createElement('meta'); meta.name = 'description'; document.head.appendChild(meta); }
    meta.setAttribute('content', 'Education news, school board decisions, district updates, and student events from public schools across all 120 Kentucky counties.');
    return () => {
      document.title = 'Local KY News — Kentucky\'s Local News Aggregator';
      meta?.setAttribute('content', 'Local KY News — AI-assisted news summaries covering all 120 Kentucky counties. Local government, schools, sports, weather, and more.');
    };
  }, []);

  return (
    <CategoryFeedPage
      category="schools"
      title="Kentucky Schools"
      filterPosts={isLikelySchoolsArticle}
    />
  );
}
