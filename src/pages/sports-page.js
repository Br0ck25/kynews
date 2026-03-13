import React from "react";
import CategoryFeedPage from "./category-feed-page";

function isLikelySportsArticle(post) {
  const text = `${post?.title || ""} ${post?.shortDesc || ""}`.toLowerCase();
  const strongSignal =
    /\b(khsaa|ncaa|wildcats|cardinals|uofl|football|basketball|baseball|softball|soccer|volleyball|wrestling|tournament|playoff|championship)\b/i.test(text);
  const signals = text.match(/\b(sports?|team|coach|athlete|game|match|season|score|football|basketball|baseball|softball|soccer|volleyball|wrestling|tennis|golf|track|cross country|playoff|tournament|championship)\b/gi) || [];
  return strongSignal || signals.length >= 2;
}

export default function SportsPage() {
  React.useEffect(() => {
    document.title = 'Kentucky Sports News — Local KY News';
    let meta = document.querySelector('meta[name="description"]');
    if (!meta) { meta = document.createElement('meta'); meta.name = 'description'; document.head.appendChild(meta); }
    meta.setAttribute('content', 'High school, college, and local sports coverage across Kentucky — KHSAA, UK Wildcats, Louisville Cardinals, and all 120 counties.');
    return () => {
      document.title = 'Local KY News — Kentucky\'s Local News Aggregator';
      meta?.setAttribute('content', 'Local KY News — AI-assisted news summaries covering all 120 Kentucky counties. Local government, schools, sports, weather, and more.');
    };
  }, []);

  return (
    <CategoryFeedPage
      category="sports"
      title="Kentucky Sports"
      filterPosts={isLikelySportsArticle}
    />
  );
}
