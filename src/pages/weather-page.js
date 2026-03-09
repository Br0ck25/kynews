import React from "react";
import CategoryFeedPage from "./category-feed-page";
import KYWeatherHub from "../components/KYWeatherHub";

export default function WeatherPage() {
  return (
    <>
      <KYWeatherHub />
      <CategoryFeedPage
        category="weather"
        title="Kentucky Weather"
        filterPosts={(post) => {
          const text = `${post.title || ""} ${post.shortDesc || ""}`.toLowerCase();
          return /weather|storm|tornado|flood|snow|rain|ice\s|wind|temperature|forecast|freez|cold snap|heat wave|thunder|lightning|blizzard|hail|drought|hurricane|tropical storm|winter advisory|winter watch|severe|nws\b|national weather/i.test(text);
        }}
      />
    </>
  );
}