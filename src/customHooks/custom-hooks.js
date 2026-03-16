import React from "react";

export function usePrevious(value) {
  const ref = React.useRef();
  React.useEffect(() => {
    ref.current = value;
  });
  return ref.current;
}

// use async operation with automatic abortion on unmount
export function useAsync(asyncFn, onSuccess) {
  React.useEffect(() => {
    let isMounted = true;
    asyncFn().then(data => {
      if (isMounted) onSuccess(data);
    });
    return () => {
      isMounted = false;
    };
  }, [asyncFn, onSuccess]);
}

// Map feed names (from Redux notifications state) to API category names
const FEED_TO_CATEGORY = {
  today: "today",
  national: "national",
  sports: "sports",
  weather: "weather",
  schools: "schools",
};

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Polls the articles API for each enabled notification feed and fires a
 * browser Notification when a new article appears (i.e. one with an id
 * newer than what was seen on the previous poll).
 *
 * @param {object} notifications - Redux notifications state, e.g. { today: true, sports: false }
 * @param {string} [baseUrl=""] - API base URL (empty = same origin)
 */
export function useNotificationPoller(notifications, baseUrl = "") {
  // Track the most-recently-seen article id per feed so we don't re-notify
  const seenIds = React.useRef({});

  React.useEffect(() => {
    // Nothing to do if no feeds are enabled or permission is not granted
    const enabledFeeds = Object.entries(notifications || {})
      .filter(([, enabled]) => enabled)
      .map(([feed]) => feed)
      .filter((feed) => FEED_TO_CATEGORY[feed]);

    if (enabledFeeds.length === 0) return;
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;

    let cancelled = false;

    async function poll() {
      for (const feed of enabledFeeds) {
        if (cancelled) return;
        const category = FEED_TO_CATEGORY[feed];
        try {
          const res = await fetch(`${baseUrl}/api/articles/${category}?limit=3`);
          if (!res.ok) continue;
          const data = await res.json();
          const articles = data?.articles ?? data ?? [];
          if (!Array.isArray(articles) || articles.length === 0) continue;

          const latestId = articles[0]?.id;
          const prevId = seenIds.current[feed];

          if (prevId === undefined) {
            // First poll — just record the baseline, don't notify
            seenIds.current[feed] = latestId;
          } else if (latestId && latestId !== prevId) {
            // New article detected!
            seenIds.current[feed] = latestId;
            const article = articles[0];
            const title = article?.title ?? "New article";
            const slug = article?.slug;
            try {
              // Use the SW registration so notifications work when the tab is
              // in the background or the PWA is installed and closed.
              const reg = await navigator.serviceWorker.ready;
              await reg.showNotification(`Kentucky News – ${category}`, {
                body: title,
                icon: "/logo192.png",
                tag: `kynews-${category}`,
                data: { url: slug ? `/news/${category}/${slug}` : "/" },
              });
            } catch (notifErr) {
              console.warn(`[notifications] showNotification failed for ${feed}:`, notifErr);
            }
          }
        } catch (err) {
          // Network errors are common on mobile — fail silently
          console.warn(`[notifications] poll failed for ${feed}:`, err);
        }
      }
    }

    // Poll immediately, then on interval
    poll();
    const timer = setInterval(poll, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [notifications, baseUrl]);
}
