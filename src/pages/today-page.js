import React from "react";
import CategoryFeedPage from "./category-feed-page";

export default function TodayPage() {
  React.useEffect(() => {
    document.title = 'Kentucky News Today — Local KY News';
    let meta = document.querySelector('meta[name="description"]');
    if (!meta) { meta = document.createElement('meta'); meta.name = 'description'; document.head.appendChild(meta); }
    meta.setAttribute('content', 'The latest local news from all 120 Kentucky counties — government, schools, sports, weather, and community stories updated throughout the day.');
    return () => {
      document.title = 'Local KY News — Kentucky\'s Local News Aggregator';
      meta?.setAttribute('content', 'Local KY News — AI-assisted news summaries covering all 120 Kentucky counties. Local government, schools, sports, weather, and more.');
    };
  }, []);

  return (
    <CategoryFeedPage
      category="today"
      title="Kentucky Today"
    />
  );
}
