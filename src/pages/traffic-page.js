import React from "react";
import TrimarcTrafficHub from "../components/TrimarcTrafficHub";

export default function TrafficPage() {
  React.useEffect(() => {
    document.title = "Road Work & Traffic — Local KY News";
    let meta = document.querySelector('meta[name="description"]');
    if (!meta) {
      meta = document.createElement("meta");
      meta.name = "description";
      document.head.appendChild(meta);
    }
    meta.setAttribute(
      "content",
      "Live road-work and traffic incident alerts for the Louisville metro area from TRIMARC. Construction, lane closures, freeway maintenance, and disabled vehicles."
    );
    return () => {
      document.title = "Local KY News — Kentucky's Local News Aggregator";
      meta?.setAttribute(
        "content",
        "Local KY News — AI-assisted news summaries covering all 120 Kentucky counties. Local government, schools, sports, weather, and more."
      );
    };
  }, []);

  return <TrimarcTrafficHub />;
}
