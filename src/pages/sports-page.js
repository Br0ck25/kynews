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
  return (
    <CategoryFeedPage
      category="sports"
      title="Kentucky Sports"
      filterPosts={isLikelySportsArticle}
    />
  );
}
