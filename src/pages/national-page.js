import React from "react";
import CategoryFeedPage from "./category-feed-page";

export default function NationalPage() {
  React.useEffect(() => {
    document.title = 'National News for Kentucky Readers — Local KY News';
    let meta = document.querySelector('meta[name="description"]');
    if (!meta) { meta = document.createElement('meta'); meta.name = 'description'; document.head.appendChild(meta); }
    meta.setAttribute('content', 'National headlines and breaking news stories curated for Kentucky readers, alongside the local coverage you rely on.');
    return () => {
      document.title = 'Local KY News — Kentucky\'s Local News Aggregator';
      meta?.setAttribute('content', 'Local KY News — AI-assisted news summaries covering all 120 Kentucky counties. Local government, schools, sports, weather, and more.');
    };
  }, []);

  return <CategoryFeedPage category="national" title="National News" />;
}
