import React from "react";
import CategoryFeedPage from "./category-feed-page";
import KYWeatherHub from "../components/KYWeatherHub";

export default function WeatherPage() {
  React.useEffect(() => {
    document.title = 'Kentucky Weather — Local KY News';
    let meta = document.querySelector('meta[name="description"]');
    if (!meta) { meta = document.createElement('meta'); meta.name = 'description'; document.head.appendChild(meta); }
    meta.setAttribute('content', 'Weather alerts, NWS forecasts, and severe weather updates for all regions of Kentucky. Stay informed on storms, flooding, and road conditions.');
    return () => {
      document.title = 'Local KY News — Kentucky\'s Local News Aggregator';
      meta?.setAttribute('content', 'Local KY News — AI-assisted news summaries covering all 120 Kentucky counties. Local government, schools, sports, weather, and more.');
    };
  }, []);

  return (
    <>
      <KYWeatherHub />
      <CategoryFeedPage
        category="weather"
        title=""
        filterPosts={(post) => {
          const text = `${post.title || ""} ${post.shortDesc || ""}`.toLowerCase();
          return /weather|storm|tornado|flood|snow|rain|ice\s|wind|temperature|forecast|freez|cold snap|heat wave|thunder|lightning|blizzard|hail|drought|hurricane|tropical storm|winter advisory|winter watch|severe|nws\b|national weather/i.test(text);
        }}
      />
    </>
  );
}