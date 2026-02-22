import React, { useEffect, useMemo, useRef, useState } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import {
  getFeeds,
  getItems,
  getCounties,
  getOpenProxy,
  searchItems,
  getWeatherForecast,
  getWeatherAlerts,
  listLostFound,
  listLostFoundComments,
  submitLostFound,
  submitLostFoundComment,
  getLostFoundUploadUrl,
  uploadLostFoundImage,
  markLostFoundAsFound,
  listAdminLostFound,
  deleteAdminLostFound,
  approveAdminLostFound,
  rejectAdminLostFound,
  getAdminIngestionLogs,
  getAdminFeedHealth,
  runAdminFeedReload,
  type AdminFeedHealth,
  type AdminIngestionLog,
  type Feed,
  type Item,
  type LostFoundPost,
  type LostFoundComment,
  type LostFoundType,
  type WeatherAlert,
  type WeatherForecast
} from "../data/api";
import { bulkIsRead, isSaved, listSavedItems, markRead, toggleSaved } from "../data/localDb";
import Reader from "./Reader";
import { IconHeart, IconMapPin, IconMenu, IconSearch, IconSettings, IconShare, IconToday } from "./icons";
import kyCounties from "../data/ky-counties.json";

function sourceFromUrl(url: string) {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function formatPublishedDate(iso?: string | null) {
  if (!iso) return "Published date unavailable";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Published date unavailable";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

function stripHtml(input?: string | null) {
  if (!input) return "";
  return input.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function summarySnippet(item: Item, maxWords = 24) {
  const clean = stripHtml(item.summary || item.content || "");
  if (!clean) return "Tap to open the full story.";
  const words = clean.split(" ");
  if (words.length <= maxWords) return clean;
  return words.slice(0, maxWords).join(" ") + "...";
}

function formatFromNow(iso?: string | null) {
  if (!iso) return "Unknown time";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Unknown time";

  const diffMs = Date.now() - d.getTime();
  const diffMinutes = Math.max(1, Math.floor(diffMs / 60000));
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return formatPublishedDate(iso);
}

function truncateText(value: string, maxChars = 420): string {
  const text = stripHtml(value).trim();
  if (!text) return "";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}...`;
}

const SPORTS_CONTENT_RE =
  /\b(sports?|football|basketball|baseball|soccer|volleyball|wrestling|athletic(?:s)?|nfl|nba|mlb|nhl|ncaa)\b/i;

function isLikelySportsItem(item: Item): boolean {
  const haystack = `${item.title || ""} ${item.summary || ""} ${item.content || ""}`;
  return SPORTS_CONTENT_RE.test(haystack);
}

const COVERAGE_TABS = [
  { id: "today", label: "TODAY", path: "/today" },
  { id: "national", label: "NATIONAL", path: "/national" },
  { id: "sports", label: "SPORTS", path: "/sports" },
  { id: "weather", label: "WEATHER", path: "/weather" },
  { id: "schools", label: "SCHOOLS", path: "/schools" },
  { id: "obituaries", label: "OBITUARIES", path: "/obituaries" },
  { id: "lost-found", label: "LOST & FOUND", path: "/lost-found" }
];

const LOCAL_PREF_KEY = "my_local_county";
const SELECTED_COUNTIES_PREF_KEY = "selected_counties";
const THEME_PREF_KEY = "ui_theme";
const OWNER_ADMIN_TOKEN_KEY = "owner_admin_token";
const OWNER_ADMIN_ROUTE = "/owner-panel-ky-news";
const TODAY_LOOKBACK_HOURS = 72;
const SPORTS_LOOKBACK_HOURS = 24 * 14;
const OBITUARY_LOOKBACK_HOURS = 24 * 365;
const OBITUARY_FALLBACK_QUERY = "\"obituary\" OR \"obituaries\" OR \"funeral\" OR \"visitation\" OR \"memorial service\" OR \"passed away\"";
const SPORTS_QUERY =
  "\"sports\" OR \"sport\" OR \"football\" OR \"basketball\" OR \"baseball\" OR \"soccer\" OR \"volleyball\" OR \"wrestling\" OR \"athletics\"";
type ThemeMode = "light" | "dark";

function getMyLocalCounty(): string {
  try {
    return (localStorage.getItem(LOCAL_PREF_KEY) || "").trim();
  } catch {
    return "";
  }
}

function setMyLocalCounty(county: string) {
  try {
    localStorage.setItem(LOCAL_PREF_KEY, county);
  } catch {
    // ignore
  }
}

function getSelectedCounties(): string[] {
  try {
    const raw = localStorage.getItem(SELECTED_COUNTIES_PREF_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const all = new Set((kyCounties as { name: string }[]).map((c) => c.name));
    return parsed
      .map((x) => String(x || "").trim())
      .filter((x) => all.has(x));
  } catch {
    return [];
  }
}

function setSelectedCounties(counties: string[]) {
  try {
    localStorage.setItem(SELECTED_COUNTIES_PREF_KEY, JSON.stringify(counties));
  } catch {
    // ignore
  }
}

function getThemeMode(): ThemeMode {
  try {
    return localStorage.getItem(THEME_PREF_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

function setThemeMode(mode: ThemeMode) {
  try {
    localStorage.setItem(THEME_PREF_KEY, mode);
  } catch {
    // ignore
  }
}

function getOwnerAdminToken(): string {
  try {
    return (localStorage.getItem(OWNER_ADMIN_TOKEN_KEY) || "").trim();
  } catch {
    return "";
  }
}

function setOwnerAdminToken(token: string) {
  try {
    const normalized = token.trim();
    if (normalized) {
      localStorage.setItem(OWNER_ADMIN_TOKEN_KEY, normalized);
    } else {
      localStorage.removeItem(OWNER_ADMIN_TOKEN_KEY);
    }
  } catch {
    // ignore
  }
}

function applyThemeMode(mode: ThemeMode) {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme", mode);
}

export default function App() {
  const [themeMode, setThemeModeState] = useState<ThemeMode>(() => getThemeMode());

  useEffect(() => {
    applyThemeMode(themeMode);
    setThemeMode(themeMode);
  }, [themeMode]);

  return (
    <Routes>
      <Route path="/" element={<Navigate to="/today" replace />} />
      <Route path="/today" element={<TodayScreen />} />
      <Route path="/national" element={<NationalScreen />} />
      <Route path="/sports" element={<SportsScreen />} />
      <Route path="/open" element={<ExternalWebViewScreen />} />
      <Route path="/weather" element={<WeatherScreen />} />
      <Route path="/schools" element={<SchoolsScreen />} />
      <Route path="/obituaries" element={<ObituariesScreen />} />
      <Route path="/lost-found" element={<LostFoundScreen />} />
      <Route path="/my-local" element={<MyLocalScreen />} />
      <Route path="/read-later" element={<ReadLaterScreen />} />
      <Route path="/search" element={<SearchScreen />} />
      <Route path="/preferences" element={<Navigate to="/settings" replace />} />
      <Route path={OWNER_ADMIN_ROUTE} element={<OwnerAdminScreen />} />
      <Route
        path="/settings"
        element={
          <SettingsScreen
            themeMode={themeMode}
            onToggleDarkTheme={(enabled) => setThemeModeState(enabled ? "dark" : "light")}
          />
        }
      />
      <Route path="/local-settings" element={<Navigate to="/my-local" replace />} />
      <Route path="/feed/:feedId" element={<FeedScreen />} />
      <Route path="/item/:id" element={<Reader />} />
      <Route path="*" element={<Navigate to="/today" replace />} />
    </Routes>
  );
}

/** Shell: topbar + drawer + bottom nav */
function AppShell({
  title,
  children
}: {
  title: string;
  children: React.ReactNode;
}) {
  const nav = useNavigate();
  const loc = useLocation();

  const [drawerOpen, setDrawerOpen] = useState(false);
  const contentRef = useRef<HTMLElement | null>(null);

  const active = (path: string) => loc.pathname === path || loc.pathname.startsWith(path + "/");
  const onTodayView = loc.pathname === "/today";

  useEffect(() => {
    setDrawerOpen(false);
  }, [loc.pathname, loc.search]);

  useEffect(() => {
    const node = contentRef.current;
    if (node) node.scrollTop = 0;
  }, [loc.pathname, loc.search]);

  function open(path: string) {
    setDrawerOpen(false);
    nav(path);
  }

  return (
    <div className="app">
      <header className="topbar">
        <button className="iconBtn topMenuBtn" aria-label="Menu" onClick={() => setDrawerOpen(true)}>
          <IconMenu className="navIcon" />
        </button>

        <div className="title brandTitle">
          <img className="brandLogo" src="/logo.png" alt="Local KY News" />
          <span>{title}</span>
        </div>
        <div className="topbarSpacer" />
      </header>

      {drawerOpen ? (
        <>
          <div className="drawerOverlay" onClick={() => setDrawerOpen(false)} />
          <div className="drawer" role="dialog" aria-label="Navigation">
            <div className="drawerHeader">
              Kentucky News
              <div style={{ marginLeft: "auto" }}>
                <button className="iconBtn closeBtn" onClick={() => setDrawerOpen(false)} aria-label="Close">
                  ✕
                </button>
              </div>
            </div>

            <div className="drawerList drawerNav">
              <div
                className={"drawerItem " + (onTodayView ? "active" : "")}
                onClick={() => open("/today")}
              >
                <div className="drawerLabel">Home</div>
              </div>

              <div
                className={"drawerItem " + (active("/search") ? "active" : "")}
                onClick={() => open("/search")}
              >
                <div className="drawerLabel">Search</div>
              </div>

              <div
                className={"drawerItem " + (active("/my-local") ? "active" : "")}
                onClick={() => open("/my-local")}
              >
                <div className="drawerLabel">Local News</div>
              </div>

              <div
                className={"drawerItem " + (active("/read-later") ? "active" : "")}
                onClick={() => open("/read-later")}
              >
                <div className="drawerLabel">Saved</div>
              </div>

              <div
                className={"drawerItem " + (active("/settings") ? "active" : "")}
                onClick={() => open("/settings")}
              >
                <div className="drawerLabel">Settings</div>
              </div>
            </div>
          </div>
        </>
      ) : null}

      <div className="appFrame">
        <main className="content" ref={contentRef}>{children}</main>
      </div>

      <div className="bottomNav">
        <button
          className={"navBtn " + (onTodayView ? "active" : "")}
          onClick={() => nav("/today")}
          aria-label="Home"
        >
          <IconToday className="navIcon" />
          <span className="navLabel">Home</span>
        </button>
        <button
          className={"navBtn " + (active("/search") ? "active" : "")}
          onClick={() => nav("/search")}
          aria-label="Search"
        >
          <IconSearch className="navIcon" />
          <span className="navLabel">Search</span>
        </button>
        <button
          className={"navBtn " + (active("/my-local") ? "active" : "")}
          onClick={() => nav("/my-local")}
          aria-label="Local News"
        >
          <IconMapPin className="navIcon" />
          <span className="navLabel">Local</span>
        </button>
        <button
          className={"navBtn " + (active("/read-later") ? "active" : "")}
          onClick={() => nav("/read-later")}
          aria-label="Saved"
        >
          <IconHeart className="navIcon" />
          <span className="navLabel">Saved</span>
        </button>
        <button className={"navBtn " + (active("/settings") ? "active" : "")} onClick={() => nav("/settings")} aria-label="Settings">
          <IconSettings className="navIcon" />
          <span className="navLabel">Settings</span>
        </button>
      </div>
    </div>
  );
}

function CoverageTabs() {
  const nav = useNavigate();
  const loc = useLocation();
  const isActive = (path: string) => loc.pathname === path;

  return (
    <div className="tabs">
      {COVERAGE_TABS.map((tab) => (
        <button
          key={tab.id}
          className={"tab " + (isActive(tab.path) ? "active" : "")}
          onClick={() => nav(tab.path)}
          type="button"
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

function ItemCard({ item, onOpen }: { item: Item; onOpen: () => void }) {
  const [readMap, setReadMap] = useState<Map<string, boolean>>(new Map());
  const [saved, setSaved] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    let mounted = true;
    (async () => {
      const map = await bulkIsRead([item.id]);
      const s = await isSaved(item.id);
      if (!mounted) return;
      setReadMap(map);
      setSaved(s);
    })();
    return () => {
      mounted = false;
    };
  }, [item.id]);
  useEffect(() => {
    setImageFailed(false);
  }, [item.id, item.image_url]);

  const unread = !readMap.get(item.id);
  const src = sourceFromUrl(item.url);
  const regionChip = item.region_scope === "national" ? "National" : "Kentucky";
  const stateChips = Array.from(new Set((item.states || []).map((s) => s.toUpperCase()))).filter(
    (s) => !(item.region_scope === "ky" && s === "KY")
  );

  async function openAndMark() {
    await markRead(item.id);
    setReadMap(new Map([[item.id, true]]));
    onOpen();
  }

  async function save(e: React.MouseEvent) {
    e.stopPropagation();
    const next = await toggleSaved({
      id: item.id,
      title: item.title,
      url: item.url,
      author: item.author ?? null,
      published_at: item.published_at ?? null,
      summary: item.summary ?? null,
      content: item.content ?? null,
      image_url: item.image_url ?? null,
      source: src
    });
    setSaved(next);
  }

  return (
    <div
      className={"card postCard " + (unread ? "unread" : "")}
      onClick={openAndMark}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          void openAndMark();
        }
      }}
      role="button"
      tabIndex={0}
    >
      {item.image_url && !imageFailed ? (
        <img
          className="postImage"
          src={item.image_url}
          alt=""
          loading="lazy"
          onError={() => setImageFailed(true)}
        />
      ) : (
        <div className="postImage postImageFallback">
          <div className="postImageFallbackText">{(src || "Local News").toUpperCase()}</div>
        </div>
      )}
      <div className="postBody">
        <div className="source">{src || "Source"}</div>
        <div className="chips">
          {item.region_scope ? <span className="chip">{regionChip}</span> : null}
          {stateChips.map((s) => (
            <span key={s} className="chip">{s}</span>
          ))}
          {(item.counties || []).slice(0, 3).map((c) => (
            <span key={c} className="chip">{c}</span>
          ))}
          {item.counties && item.counties.length > 3 ? <span className="chip">+{item.counties.length - 3}</span> : null}
        </div>
        <h3 className="postTitle">{item.title}</h3>
        <p className="postSummary">{summarySnippet(item)}</p>
        <div className="postFooter">
          <span className="postTime" title={item.published_at || ""}>{formatFromNow(item.published_at)}</span>
          <div className="postActions">
            <button className={"iconAction " + (saved ? "active" : "")} onClick={save} aria-label={saved ? "Saved" : "Save article"}>
              <IconHeart className="postActionIcon" />
            </button>
            <button
              className="iconAction"
              onClick={(e) => {
                e.stopPropagation();
                window.open(item.url, "_blank", "noopener,noreferrer");
              }}
              aria-label="Open source"
            >
              <IconShare className="postActionIcon" />
            </button>
          </div>
        </div>
        <div className="meta">
          <span>{formatPublishedDate(item.published_at)}</span>
        </div>
      </div>
    </div>
  );
}

function FeaturedItemCard({ item, onOpen }: { item: Item; onOpen: () => void }) {
  const [readMap, setReadMap] = useState<Map<string, boolean>>(new Map());
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    let mounted = true;
    (async () => {
      const map = await bulkIsRead([item.id]);
      if (!mounted) return;
      setReadMap(map);
    })();
    return () => {
      mounted = false;
    };
  }, [item.id]);
  useEffect(() => {
    setImageFailed(false);
  }, [item.id, item.image_url]);

  const unread = !readMap.get(item.id);
  const source = sourceFromUrl(item.url) || "Top story";

  async function openAndMark() {
    await markRead(item.id);
    setReadMap(new Map([[item.id, true]]));
    onOpen();
  }

  return (
    <div
      className={"featuredCard " + (unread ? "unread" : "")}
      onClick={openAndMark}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          void openAndMark();
        }
      }}
      role="button"
      tabIndex={0}
    >
      {item.image_url && !imageFailed ? (
        <img
          className="featuredImage"
          src={item.image_url}
          alt=""
          loading="lazy"
          onError={() => setImageFailed(true)}
        />
      ) : (
        <div className="featuredImage featuredFallback" />
      )}
      <div className="featuredOverlay" />
      <div className="featuredContent">
        <div className="featuredSource">{source}</div>
        <h2 className="featuredTitle">{item.title}</h2>
        <p className="featuredSummary">{summarySnippet(item, 28)}</p>
        <div className="featuredReadMore">Continue reading...</div>
      </div>
    </div>
  );
}

function StoryDeck({
  items,
  onOpen,
  emptyMessage = "No stories yet."
}: {
  items: Item[];
  onOpen: (id: string) => void;
  emptyMessage?: string;
}) {
  if (!items.length) {
    return <div className="card emptyState">{emptyMessage}</div>;
  }

  const [featured, ...rest] = items;
  return (
    <>
      <FeaturedItemCard item={featured} onOpen={() => onOpen(featured.id)} />
      {rest.length ? (
        <div className="postGrid">
          {rest.map((it) => (
            <ItemCard key={it.id} item={it} onOpen={() => onOpen(it.id)} />
          ))}
        </div>
      ) : null}
    </>
  );
}

function InfinitePager({
  hasMore,
  loading,
  onLoadMore
}: {
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => void | Promise<void>;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const onLoadRef = useRef(onLoadMore);

  useEffect(() => {
    onLoadRef.current = onLoadMore;
  }, [onLoadMore]);

  useEffect(() => {
    if (!hasMore || loading) return;
    const node = ref.current;
    if (!node) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          void onLoadRef.current();
        }
      },
      { rootMargin: "480px 0px" }
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, loading]);

  if (!hasMore) {
    return <div className="listStatus">No more stories</div>;
  }

  return (
    <div ref={ref} className="listStatus">
      {loading ? "Loading more..." : "Scroll for more"}
    </div>
  );
}

function TodayScreen() {
  const nav = useNavigate();
  const loc = useLocation();
  const q = new URLSearchParams(loc.search);
  const state = (q.get("state") || "").toUpperCase();
  const county = q.get("county") || "";
  const selectedCounties = useMemo(
    () => (state || county ? [] : getSelectedCounties()),
    [state, county]
  );
  const countyFilter = county ? [county] : selectedCounties;

  const [items, setItems] = useState<Item[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [statewideFallback, setStatewideFallback] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const primary = await getItems({
          state: state || undefined,
          county: county || undefined,
          counties: !county ? selectedCounties : undefined,
          hours: TODAY_LOOKBACK_HOURS,
          limit: 30
        });

        if (cancelled) return;
        const shouldFallback = !state && !county && selectedCounties.length > 0 && !primary.items.length;

        if (shouldFallback) {
          const fallback = await getItems({
            scope: "ky",
            hours: TODAY_LOOKBACK_HOURS,
            limit: 30
          });
          if (cancelled) return;
          setItems(fallback.items);
          setCursor(fallback.nextCursor);
          setStatewideFallback(true);
        } else {
          setItems(primary.items);
          setCursor(primary.nextCursor);
          setStatewideFallback(false);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [state, county, selectedCounties]);

  async function loadMore() {
    if (!cursor || loading) return;
    setLoading(true);
    try {
      const res = statewideFallback
        ? await getItems({
            scope: "ky",
            hours: TODAY_LOOKBACK_HOURS,
            cursor,
            limit: 30
          })
        : await getItems({
            state: state || undefined,
            county: county || undefined,
            counties: !county ? selectedCounties : undefined,
            hours: TODAY_LOOKBACK_HOURS,
            cursor,
            limit: 30
          });
      setItems((prev) => [...prev, ...res.items]);
      setCursor(res.nextCursor);
    } finally {
      setLoading(false);
    }
  }

  const locationLabel = county
    ? `${county}, KY`
    : state === "KY"
      ? "Kentucky"
      : countyFilter.length
        ? `My Counties (${countyFilter.length})`
        : "";

  return (
    <AppShell title="Kentucky News">
      <CoverageTabs />

      <div className="section">
        {statewideFallback ? (
          <div className="locationBanner">No recent stories in your selected counties. Showing statewide coverage.</div>
        ) : null}
        {locationLabel ? <div className="locationBanner">Coverage: {locationLabel}</div> : null}

        {loading && !items.length ? (
          <div className="card emptyState">Loading stories...</div>
        ) : (
          <>
            <StoryDeck
              items={items}
              onOpen={(id) => nav(`/item/${id}`)}
              emptyMessage="No stories right now."
            />
            {items.length ? <InfinitePager hasMore={Boolean(cursor)} loading={loading} onLoadMore={loadMore} /> : null}
          </>
        )}
      </div>
    </AppShell>
  );
}

function NationalScreen() {
  const nav = useNavigate();
  const [items, setItems] = useState<Item[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const res = await getItems({ scope: "national", limit: 30 });
        if (cancelled) return;
        setItems(res.items.filter((item) => !isLikelySportsItem(item)));
        setCursor(res.nextCursor);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function loadMore() {
    if (!cursor || loading) return;
    setLoading(true);
    try {
      const res = await getItems({ scope: "national", cursor, limit: 30 });
      setItems((prev) => [...prev, ...res.items.filter((item) => !isLikelySportsItem(item))]);
      setCursor(res.nextCursor);
    } finally {
      setLoading(false);
    }
  }

  return (
    <AppShell title="National">
      <CoverageTabs />
      <div className="section">
        {loading && !items.length ? (
          <div className="card emptyState">Loading stories...</div>
        ) : (
          <>
            <StoryDeck items={items} onOpen={(id) => nav(`/item/${id}`)} />
            {items.length ? <InfinitePager hasMore={Boolean(cursor)} loading={loading} onLoadMore={loadMore} /> : null}
          </>
        )}
      </div>
    </AppShell>
  );
}

function SportsScreen() {
  const nav = useNavigate();
  const [items, setItems] = useState<Item[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const res = await searchItems(SPORTS_QUERY, {
          scope: "all",
          hours: SPORTS_LOOKBACK_HOURS,
          limit: 30
        });
        if (cancelled) return;
        setItems(res.items);
        setCursor(res.nextCursor);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function loadMore() {
    if (!cursor || loading) return;
    setLoading(true);
    try {
      const res = await searchItems(SPORTS_QUERY, {
        scope: "all",
        hours: SPORTS_LOOKBACK_HOURS,
        cursor,
        limit: 30
      });
      setItems((prev) => [...prev, ...res.items]);
      setCursor(res.nextCursor);
    } finally {
      setLoading(false);
    }
  }

  return (
    <AppShell title="Sports">
      <CoverageTabs />
      <div className="section">
        {loading && !items.length ? (
          <div className="card emptyState">Loading sports stories...</div>
        ) : (
          <>
            <StoryDeck items={items} onOpen={(id) => nav(`/item/${id}`)} emptyMessage="No sports stories right now." />
            {items.length ? <InfinitePager hasMore={Boolean(cursor)} loading={loading} onLoadMore={loadMore} /> : null}
          </>
        )}
      </div>
    </AppShell>
  );
}

function FeedScreen() {
  const nav = useNavigate();
  const { feedId } = useParams();
  const [feed, setFeed] = useState<Feed | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const feeds = await getFeeds().catch(() => []);
      const f = feeds.find((x) => x.id === feedId) || null;
      if (!cancelled) setFeed(f);

      try {
        const res = await getItems({ feedId: feedId || undefined, limit: 30 });
        if (cancelled) return;
        setItems(res.items);
        setCursor(res.nextCursor);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [feedId]);

  async function loadMore() {
    if (!cursor || loading) return;
    setLoading(true);
    try {
      const res = await getItems({ feedId: feedId || undefined, cursor, limit: 30 });
      setItems((prev) => [...prev, ...res.items]);
      setCursor(res.nextCursor);
    } finally {
      setLoading(false);
    }
  }

  return (
    <AppShell title={feed?.name || "Feed"}>
      <div className="section">
        {loading && !items.length ? (
          <div className="card emptyState">Loading stories...</div>
        ) : (
          <>
            <StoryDeck items={items} onOpen={(id) => nav(`/item/${id}`)} />
            {items.length ? <InfinitePager hasMore={Boolean(cursor)} loading={loading} onLoadMore={loadMore} /> : null}
          </>
        )}
      </div>
    </AppShell>
  );
}

function ExternalWebViewScreen() {
  const nav = useNavigate();
  const loc = useLocation();
  const q = new URLSearchParams(loc.search);
  const rawUrl = (q.get("url") || "").trim();
  const [loading, setLoading] = useState(false);
  const [proxyHtml, setProxyHtml] = useState("");
  const [proxyTitle, setProxyTitle] = useState("");
  const [proxyError, setProxyError] = useState("");

  let frameUrl = "";
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      frameUrl = parsed.toString();
    }
  } catch {
    frameUrl = "";
  }

  useEffect(() => {
    let cancelled = false;
    if (!frameUrl) return;
    (async () => {
      setLoading(true);
      setProxyError("");
      setProxyHtml("");
      try {
        const res = await getOpenProxy(frameUrl);
        if (cancelled) return;
        setProxyHtml(res.html || "");
        setProxyTitle(res.title || "");
      } catch (err: any) {
        if (!cancelled) setProxyError(String(err?.message || err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [frameUrl]);

  return (
    <AppShell title="Original">
      <div className="section">
        {!frameUrl ? (
          <div className="card" style={{ padding: 14 }}>
            <div style={{ fontWeight: 900, marginBottom: 8 }}>Invalid article URL</div>
            <button className="btn" onClick={() => nav(-1)}>
              Back
            </button>
          </div>
        ) : (
          <div className="card webviewCard">
            <div className="webviewTop">
              <div className="webviewActions">
                <button className="btn" onClick={() => nav(-1)}>
                  Back
                </button>
                <a className="btn" href={frameUrl} target="_blank" rel="noreferrer">
                  Open external
                </a>
              </div>
            </div>
            {loading ? <div className="card emptyState">Loading article in app...</div> : null}
            {!loading && proxyHtml ? (
              <>
                {proxyTitle ? <div className="webviewHint">In-app view: {proxyTitle}</div> : null}
                <iframe
                  title="Original article"
                  srcDoc={proxyHtml}
                  className="webviewFrame"
                  referrerPolicy="no-referrer"
                />
              </>
            ) : null}

            {!loading && !proxyHtml ? (
              <>
                <iframe title="Original article" src={frameUrl} className="webviewFrame" referrerPolicy="no-referrer" />
                <div className="webviewHint">
                  {proxyError
                    ? `Proxy view unavailable: ${proxyError}. Showing direct frame when possible.`
                    : 'Some publishers block embedded viewing. Use "Open external" if this page does not load.'}
                </div>
              </>
            ) : null}
          </div>
        )}
      </div>
    </AppShell>
  );
}

function ReadLaterScreen() {
  const nav = useNavigate();
  const [saved, setSaved] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [reviewedCount, setReviewedCount] = useState(0);

  async function refresh() {
    setLoading(true);
    try {
      const rows = await listSavedItems(200);
      // Convert to Item shape
      const items: Item[] = rows.map((r) => ({
        id: r.id,
        title: r.title,
        url: r.url,
        author: r.author ?? null,
        published_at: r.published_at ?? null,
        summary: r.summary ?? null,
        content: r.content ?? null,
        image_url: r.image_url ?? null
      }));
      setSaved(items);
      const readMap = await bulkIsRead(items.map((x) => x.id));
      let reviewed = 0;
      for (const x of items) {
        if (readMap.get(x.id)) reviewed++;
      }
      setReviewedCount(reviewed);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function markAllRead() {
    await Promise.all(saved.map((it) => markRead(it.id)));
    await refresh();
  }

  return (
    <AppShell title="Read Later">
      <div className="section">
        <div style={{ textAlign: "center", color: "var(--muted)", margin: "14px 0" }}>
          {loading ? "Loading…" : `You've reviewed ${reviewedCount} article${reviewedCount === 1 ? "" : "s"}`}
        </div>

        {loading ? (
          <div className="card emptyState">Loading saved stories...</div>
        ) : (
          <StoryDeck items={saved} onOpen={(id) => nav(`/item/${id}`)} emptyMessage="No saved articles yet." />
        )}

        <button className="btn block" onClick={markAllRead} disabled={!saved.length}>
          Mark All as Read
        </button>
      </div>
    </AppShell>
  );
}

function SettingsScreen({
  themeMode,
  onToggleDarkTheme
}: {
  themeMode: ThemeMode;
  onToggleDarkTheme: (enabled: boolean) => void;
}) {
  const nav = useNavigate();
  const [selectedCounties, setSelectedCountiesState] = useState<string[]>(() => getSelectedCounties());
  const allCounties = useMemo(() => (kyCounties as { name: string }[]).map((c) => c.name), []);

  function toggleCounty(name: string) {
    setSelectedCountiesState((prev) => {
      const next = prev.includes(name) ? prev.filter((c) => c !== name) : [...prev, name];
      setSelectedCounties(next);
      return next;
    });
  }

  function clearCountyPrefs() {
    setSelectedCountiesState([]);
    setSelectedCounties([]);
  }

  return (
    <AppShell title="Settings">
      <div className="section">
        <div className="card prefCard">
          <div className="prefHeading">Appearance</div>
          <div className="prefRow themeRow">
            <div className="prefRowMeta">
              <div className="drawerLabel">Dark Mode</div>
              <div className="prefHint">Enable dark appearance</div>
            </div>
            <label className="themeSwitch" aria-label="Dark mode toggle">
              <input
                className="themeInput"
                type="checkbox"
                checked={themeMode === "dark"}
                onChange={(e) => onToggleDarkTheme(e.target.checked)}
              />
              <span className="themeSlider" />
            </label>
          </div>
        </div>

        <div className="card prefCard">
          <div className="prefHeading">Shortcuts</div>
          <div className="prefRow" onClick={() => nav("/my-local")}>
            <div className="prefRowMeta">
              <div className="drawerLabel">Local News</div>
              <div className="prefHint">Set your local county</div>
            </div>
          </div>
          <div className="prefRow" onClick={() => nav("/today")}>
            <div className="prefRowMeta">
              <div className="drawerLabel">Home Feed</div>
              <div className="prefHint">View Today with current filters</div>
            </div>
          </div>
          <div className="prefRow" onClick={() => nav("/read-later")}>
            <div className="drawerLabel">Saved Articles</div>
          </div>
        </div>

        <div className="card prefCard">
          <div className="prefHeading">County Feed Filters</div>
          <div className="prefHint" style={{ marginBottom: 10 }}>
            Select one or more counties. Home feed will show only matching county stories.
          </div>
          <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
            <button className="btn" onClick={clearCountyPrefs} disabled={!selectedCounties.length}>
              Clear Selection
            </button>
            <button className="btn" onClick={() => nav("/today")}>
              View Home Feed
            </button>
          </div>
          <div className="countyPills">
            {allCounties.map((name) => {
              const active = selectedCounties.includes(name);
              return (
                <button
                  key={name}
                  type="button"
                  className={"countyPill " + (active ? "active" : "")}
                  onClick={() => toggleCounty(name)}
                >
                  {name}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </AppShell>
  );
}

function MyLocalScreen() {
  const nav = useNavigate();
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loadingCounties, setLoadingCounties] = useState(true);
  const [selected, setSelected] = useState(() => getMyLocalCounty());
  const [items, setItems] = useState<Item[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingFeed, setLoadingFeed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadingCounties(true);
      try {
        const res = await getCounties({ state: "KY", hours: 24 * 14 });
        const map: Record<string, number> = {};
        for (const row of res.counties) map[row.county] = row.count;
        if (!cancelled) setCounts(map);
      } catch {
        if (!cancelled) setCounts({});
      } finally {
        if (!cancelled) setLoadingCounties(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!selected) {
      setItems([]);
      setCursor(null);
      return;
    }

    (async () => {
      setLoadingFeed(true);
      setItems([]);
      setCursor(null);
      try {
        const res = await getItems({ state: "KY", county: selected, hours: 24 * 14, limit: 30 });
        if (cancelled) return;
        setItems(res.items);
        setCursor(res.nextCursor);
      } finally {
        if (!cancelled) setLoadingFeed(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [selected]);

  const all = (kyCounties as { name: string }[]).map((c) => c.name);

  function choose(name: string) {
    setSelected(name);
    setMyLocalCounty(name);
  }

  async function loadMoreLocal() {
    if (!selected || !cursor || loadingFeed) return;
    setLoadingFeed(true);
    try {
      const res = await getItems({ state: "KY", county: selected, hours: 24 * 14, cursor, limit: 30 });
      setItems((prev) => [...prev, ...res.items]);
      setCursor(res.nextCursor);
    } finally {
      setLoadingFeed(false);
    }
  }

  return (
    <AppShell title="Local News">
      <CoverageTabs />
      <div className="section">
        <div className="card" style={{ padding: 12 }}>
          <div style={{ fontSize: 13, opacity: 0.75, marginBottom: 8 }}>Select Local County</div>
          <select
            className="searchInput"
            value={selected}
            onChange={(e) => choose(e.target.value)}
          >
            <option value="">Select county...</option>
            {all.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          {selected ? (
            <div style={{ marginTop: 8, fontSize: 12, color: "var(--muted)" }}>
              {loadingCounties ? "Loading count..." : `${counts[selected] ?? 0} local article(s) in the last 14 days`}
            </div>
          ) : null}
        </div>

        <div style={{ marginTop: 12 }}>
          {!selected ? <div className="card emptyState">Choose a county to load your local feed.</div> : null}
          {selected && loadingFeed && !items.length ? <div className="card emptyState">Loading local stories...</div> : null}
          {selected ? (
            <>
              <StoryDeck items={items} onOpen={(id) => nav(`/item/${id}`)} emptyMessage="No local stories right now." />
              {items.length ? (
                <InfinitePager hasMore={Boolean(cursor)} loading={loadingFeed} onLoadMore={loadMoreLocal} />
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </AppShell>
  );
}

function weatherGlyph(text: string) {
  const s = String(text || "").toLowerCase();
  if (s.includes("thunder")) return "⛈";
  if (s.includes("snow") || s.includes("sleet")) return "❄";
  if (s.includes("rain") || s.includes("shower")) return "🌧";
  if (s.includes("cloud")) return "☁";
  if (s.includes("fog") || s.includes("mist")) return "🌫";
  return "☀";
}

function WeatherScreen() {
  const nav = useNavigate();
  const [county, setCounty] = useState(() => getMyLocalCounty());
  const [forecast, setForecast] = useState<WeatherForecast | null>(null);
  const [alerts, setAlerts] = useState<WeatherAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const allCounties = useMemo(() => (kyCounties as { name: string }[]).map((c) => c.name), []);

  useEffect(() => {
    let cancelled = false;
    if (!county) {
      setLoading(false);
      return;
    }

    (async () => {
      setLoading(true);
      setError("");
      try {
        const [forecastRes, alertRes] = await Promise.all([
          getWeatherForecast(county, "KY"),
          getWeatherAlerts({ state: "KY", county })
        ]);
        if (cancelled) return;
        setForecast(forecastRes);
        setAlerts(alertRes.alerts || []);
      } catch (err: any) {
        if (!cancelled) setError(String(err?.message || err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [county]);

  return (
    <AppShell title="Weather">
      <CoverageTabs />
      <div className="section">
        {!county ? (
          <div className="card" style={{ padding: 14 }}>
            <div style={{ fontWeight: 800, marginBottom: 10 }}>Choose your county first</div>
            <select
              className="searchInput"
              value={county}
              onChange={(e) => {
                const next = e.target.value;
                setCounty(next);
                if (next) setMyLocalCounty(next);
              }}
              style={{ marginBottom: 8 }}
            >
              <option value="">Select county...</option>
              {allCounties.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            <div style={{ color: "var(--muted)", fontSize: 12 }}>
              Weather updates stay on this page. Selecting a county does not redirect you.
            </div>
          </div>
        ) : null}

        {county ? (
          <div className="card weatherWidget" style={{ marginBottom: 12 }}>
            <div className="weatherTop">
              <div>
                <div className="weatherCounty">{county} County, KY</div>
                <div className="weatherSub">
                  {forecast?.periods?.[0]?.name || "Current"} {forecast?.periods?.[0]?.temperature ?? "--"}°
                  {forecast?.periods?.[0]?.temperatureUnit || "F"}
                </div>
              </div>
              <div className="weatherGlyph">{weatherGlyph(forecast?.periods?.[0]?.shortForecast || "")}</div>
            </div>
            <div className="weatherSummary">{forecast?.periods?.[0]?.shortForecast || "Forecast loading..."}</div>
            <div className="weatherActions">
              <select
                className="searchInput"
                value={county}
                onChange={(e) => {
                  const next = e.target.value;
                  setCounty(next);
                  if (next) setMyLocalCounty(next);
                }}
                style={{ maxWidth: 200 }}
              >
                {allCounties.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
              <button className="btn" onClick={() => setCounty(getMyLocalCounty())}>
                Refresh
              </button>
            </div>
          </div>
        ) : null}

        {loading ? (
          <div className="card" style={{ padding: 14, color: "var(--muted)" }}>
            Loading weather...
          </div>
        ) : null}

        {error ? (
          <div className="card" style={{ padding: 14, color: "#b91c1c", marginBottom: 12 }}>
            {error}
          </div>
        ) : null}

        {alerts.length ? (
          <div className="card" style={{ padding: 14, marginBottom: 12, borderColor: "#f59e0b" }}>
            <div style={{ fontWeight: 900, marginBottom: 10 }}>Active Alerts</div>
            {alerts.map((a) => (
              <div key={a.id} style={{ marginBottom: 12 }}>
                <div style={{ fontWeight: 800 }}>{a.headline}</div>
                <div style={{ fontSize: 13, color: "var(--muted)", marginBottom: 6 }}>
                  {a.event} • {a.severity}
                  {a.starts_at || a.ends_at ? (
                    <>
                      {" "}
                      •{" "}
                      {a.starts_at ? `Starts ${formatPublishedDate(a.starts_at)}` : "In effect now"}
                      {a.ends_at ? ` | Ends ${formatPublishedDate(a.ends_at)}` : ""}
                    </>
                  ) : null}
                </div>
                <div style={{ fontSize: 13, lineHeight: 1.45, marginBottom: a.instruction ? 6 : 0 }}>
                  {truncateText(
                    a.description ||
                      a.instruction ||
                      "The National Weather Service has not published additional narrative text for this alert yet. Stay weather-aware and monitor updates.",
                    500
                  )}
                </div>
                {a.instruction ? (
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#92400e" }}>
                    Action: {truncateText(a.instruction, 320)}
                  </div>
                ) : null}
                {a.url ? (
                  <a
                    href={a.url}
                    target="_blank"
                    rel="noreferrer"
                    style={{ display: "inline-block", marginTop: 6, fontSize: 12, color: "#92400e", fontWeight: 700 }}
                  >
                    Read full NWS alert
                  </a>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}

        {forecast ? (
          <div className="card" style={{ padding: 14 }}>
            <div style={{ fontWeight: 900, marginBottom: 10 }}>Forecast</div>
            <div className="weatherPeriodGrid">
              {forecast.periods.slice(0, 14).map((p) => (
                <div key={p.name + p.startTime} className="weatherPeriodCard">
                  <div className="weatherPeriodHead">{p.name}</div>
                  <div className="weatherPeriodTemp">{p.temperature}°{p.temperatureUnit}</div>
                  <div className="weatherPeriodText">{p.shortForecast}</div>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </AppShell>
  );
}

function ObituariesScreen() {
  const nav = useNavigate();
  const [items, setItems] = useState<Item[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [fallbackSearch, setFallbackSearch] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const categoryFeed = await getItems({
          scope: "ky",
          category: "Kentucky - Obituaries",
          hours: OBITUARY_LOOKBACK_HOURS,
          limit: 30
        });
        if (cancelled) return;

        if (categoryFeed.items.length) {
          setItems(categoryFeed.items);
          setCursor(categoryFeed.nextCursor);
          setFallbackSearch(false);
          return;
        }

        const fallback = await searchItems(OBITUARY_FALLBACK_QUERY, {
          scope: "ky",
          hours: OBITUARY_LOOKBACK_HOURS,
          limit: 30
        });
        if (cancelled) return;

        setItems(fallback.items);
        setCursor(fallback.nextCursor);
        setFallbackSearch(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function loadMore() {
    if (!cursor || loading) return;
    setLoading(true);
    try {
      const res = fallbackSearch
        ? await searchItems(OBITUARY_FALLBACK_QUERY, {
            scope: "ky",
            hours: OBITUARY_LOOKBACK_HOURS,
            cursor,
            limit: 30
          })
        : await getItems({
            scope: "ky",
            category: "Kentucky - Obituaries",
            hours: OBITUARY_LOOKBACK_HOURS,
            cursor,
            limit: 30
          });
      setItems((prev) => [...prev, ...res.items]);
      setCursor(res.nextCursor);
    } finally {
      setLoading(false);
    }
  }

  return (
    <AppShell title="Obituaries">
      <CoverageTabs />
      <div className="section">
        {fallbackSearch ? (
          <div className="locationBanner">Showing obituary keyword matches from Kentucky sources.</div>
        ) : null}
        {loading && !items.length ? (
          <div className="card emptyState">Loading obituary stories...</div>
        ) : (
          <>
            <StoryDeck items={items} onOpen={(id) => nav(`/item/${id}`)} emptyMessage="No obituary stories right now." />
            {items.length ? <InfinitePager hasMore={Boolean(cursor)} loading={loading} onLoadMore={loadMore} /> : null}
          </>
        )}
      </div>
    </AppShell>
  );
}

function SchoolsScreen() {
  const nav = useNavigate();
  const selectedCounties = useMemo(() => getSelectedCounties(), []);
  const [items, setItems] = useState<Item[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const schoolQuery = "\"school\" OR \"schools\" OR \"district\" OR \"classroom\" OR \"student\" OR \"teacher\" OR \"university\" OR \"college\"";

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const res = await searchItems(schoolQuery, {
          scope: "ky",
          counties: selectedCounties.length ? selectedCounties : undefined,
          hours: 24 * 14,
          limit: 30
        });
        if (cancelled) return;
        setItems(res.items);
        setCursor(res.nextCursor);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedCounties]);

  async function loadMore() {
    if (!cursor || loading) return;
    setLoading(true);
    try {
      const res = await searchItems(schoolQuery, {
        scope: "ky",
        counties: selectedCounties.length ? selectedCounties : undefined,
        hours: 24 * 14,
        cursor,
        limit: 30
      });
      setItems((prev) => [...prev, ...res.items]);
      setCursor(res.nextCursor);
    } finally {
      setLoading(false);
    }
  }

  return (
    <AppShell title="Schools">
      <CoverageTabs />
      <div className="section">
        {loading && !items.length ? (
          <div className="card emptyState">Loading school stories...</div>
        ) : (
          <>
            <StoryDeck items={items} onOpen={(id) => nav(`/item/${id}`)} emptyMessage="No school stories right now." />
            {items.length ? <InfinitePager hasMore={Boolean(cursor)} loading={loading} onLoadMore={loadMore} /> : null}
          </>
        )}
      </div>
    </AppShell>
  );
}

function LostFoundScreen() {
  const [posts, setPosts] = useState<LostFoundPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [type, setType] = useState<LostFoundType>("lost");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [formCounty, setFormCounty] = useState(() => getMyLocalCounty());
  const [listCounty, setListCounty] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [showContact, setShowContact] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [message, setMessage] = useState("");
  const [markingId, setMarkingId] = useState<string | null>(null);
  const [markEmail, setMarkEmail] = useState("");
  const [markNote, setMarkNote] = useState("");
  const [markSubmitting, setMarkSubmitting] = useState(false);
  const [markMessage, setMarkMessage] = useState("");
  const [commentOpenByPost, setCommentOpenByPost] = useState<Record<string, boolean>>({});
  const [commentLoadingByPost, setCommentLoadingByPost] = useState<Record<string, boolean>>({});
  const [commentSubmittingByPost, setCommentSubmittingByPost] = useState<Record<string, boolean>>({});
  const [commentMessagesByPost, setCommentMessagesByPost] = useState<Record<string, string>>({});
  const [commentListByPost, setCommentListByPost] = useState<Record<string, LostFoundComment[]>>({});
  const [commentDraftByPost, setCommentDraftByPost] = useState<
    Record<string, { name: string; email: string; comment: string; acceptTerms: boolean }>
  >({});

  async function refresh() {
    setLoading(true);
    try {
      const res = await listLostFound({ status: "published", county: listCounty || undefined, limit: 80 });
      setPosts(res.posts);
    } catch {
      setPosts([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, [listCounty]);

  function getCommentDraft(postId: string) {
    return (
      commentDraftByPost[postId] || {
        name: "",
        email: "",
        comment: "",
        acceptTerms: false
      }
    );
  }

  function updateCommentDraft(
    postId: string,
    patch: Partial<{ name: string; email: string; comment: string; acceptTerms: boolean }>
  ) {
    setCommentDraftByPost((prev) => {
      const current = prev[postId] || {
        name: "",
        email: "",
        comment: "",
        acceptTerms: false
      };
      return {
        ...prev,
        [postId]: { ...current, ...patch }
      };
    });
  }

  async function loadComments(postId: string, force = false) {
    if (commentLoadingByPost[postId]) return;
    if (!force && commentListByPost[postId]) return;
    setCommentLoadingByPost((prev) => ({ ...prev, [postId]: true }));
    setCommentMessagesByPost((prev) => ({ ...prev, [postId]: "" }));
    try {
      const res = await listLostFoundComments(postId, 100);
      setCommentListByPost((prev) => ({ ...prev, [postId]: res.comments || [] }));
    } catch (err: any) {
      setCommentMessagesByPost((prev) => ({ ...prev, [postId]: String(err?.message || err) }));
    } finally {
      setCommentLoadingByPost((prev) => ({ ...prev, [postId]: false }));
    }
  }

  async function toggleComments(postId: string) {
    const opening = !commentOpenByPost[postId];
    setCommentOpenByPost((prev) => ({ ...prev, [postId]: opening }));
    if (opening) {
      await loadComments(postId);
    }
  }

  async function submitComment(postId: string) {
    const draft = getCommentDraft(postId);
    if (!draft.name.trim() || !draft.email.trim() || !draft.comment.trim()) {
      setCommentMessagesByPost((prev) => ({ ...prev, [postId]: "Name, email, and comment are required." }));
      return;
    }
    if (!draft.acceptTerms) {
      setCommentMessagesByPost((prev) => ({
        ...prev,
        [postId]: "You must accept the Terms of Use and Comment Policy."
      }));
      return;
    }

    setCommentSubmittingByPost((prev) => ({ ...prev, [postId]: true }));
    setCommentMessagesByPost((prev) => ({ ...prev, [postId]: "" }));
    try {
      const res = await submitLostFoundComment({
        postId,
        name: draft.name.trim(),
        email: draft.email.trim(),
        comment: draft.comment.trim(),
        acceptTerms: true
      });
      const inserted = res.comment;
      setCommentListByPost((prev) => ({
        ...prev,
        [postId]: [...(prev[postId] || []), inserted]
      }));
      setCommentDraftByPost((prev) => ({
        ...prev,
        [postId]: {
          ...draft,
          comment: "",
          acceptTerms: false
        }
      }));
      setPosts((prev) =>
        prev.map((post) =>
          post.id === postId
            ? {
                ...post,
                comment_count: Number(post.comment_count || 0) + 1
              }
            : post
        )
      );
      setCommentMessagesByPost((prev) => ({ ...prev, [postId]: "Comment posted." }));
    } catch (err: any) {
      setCommentMessagesByPost((prev) => ({ ...prev, [postId]: String(err?.message || err) }));
    } finally {
      setCommentSubmittingByPost((prev) => ({ ...prev, [postId]: false }));
    }
  }

  async function submit() {
    if (!title.trim() || !description.trim() || !formCounty.trim() || !contactEmail.trim()) {
      setMessage("Please complete all required fields.");
      return;
    }

    setSubmitting(true);
    setMessage("");
    try {
      const imageKeys: string[] = [];
      if (file) {
        const upload = await getLostFoundUploadUrl(file.name, file.type || "application/octet-stream");
        await uploadLostFoundImage(upload.uploadUrl, file, upload.headers);
        imageKeys.push(upload.objectKey);
      }

      const submitted = await submitLostFound({
        type,
        title: title.trim(),
        description: description.trim(),
        county: formCounty.trim(),
        contactEmail: contactEmail.trim(),
        showContact,
        imageKeys
      });

      setTitle("");
      setDescription("");
      setContactEmail("");
      setShowContact(false);
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      setMessage(submitted.status === "approved" ? "Listing published." : "Submission received and pending moderation.");
      await refresh();
    } catch (err: any) {
      setMessage(String(err?.message || err));
    } finally {
      setSubmitting(false);
    }
  }

  function startMarkFound(postId: string) {
    setMarkingId(postId);
    setMarkEmail("");
    setMarkNote("");
    setMarkMessage("");
  }

  async function submitMarkFound(postId: string) {
    if (!markEmail.trim()) {
      setMarkMessage("Enter the same contact email used when you created this listing.");
      return;
    }

    setMarkSubmitting(true);
    setMarkMessage("");
    try {
      await markLostFoundAsFound({
        id: postId,
        contactEmail: markEmail.trim(),
        note: markNote.trim() || undefined
      });
      setMarkMessage("Listing marked as found.");
      setMarkingId(null);
      await refresh();
    } catch (err: any) {
      setMarkMessage(String(err?.message || err));
    } finally {
      setMarkSubmitting(false);
    }
  }

  return (
    <AppShell title="Lost & Found">
      <CoverageTabs />
      <div className="section">
        <div className="card" style={{ padding: 14, marginBottom: 12 }}>
          <div style={{ fontWeight: 900, marginBottom: 10 }}>Submit a Listing</div>
          <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
            <button className={"btn " + (type === "lost" ? "primary" : "")} onClick={() => setType("lost")}>
              Lost
            </button>
            <button className={"btn " + (type === "found" ? "primary" : "")} onClick={() => setType("found")}>
              Found
            </button>
          </div>
          <input
            className="searchInput"
            style={{ marginBottom: 8 }}
            placeholder="Title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <textarea
            className="searchInput"
            style={{ marginBottom: 8, minHeight: 90 }}
            placeholder="Description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <input
            className="searchInput"
            style={{ marginBottom: 8 }}
            placeholder="County"
            value={formCounty}
            onChange={(e) => setFormCounty(e.target.value)}
          />
          <input
            className="searchInput"
            style={{ marginBottom: 8 }}
            type="email"
            placeholder="Contact Email"
            value={contactEmail}
            onChange={(e) => setContactEmail(e.target.value)}
          />
          <label style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8, color: "var(--muted)", fontSize: 13 }}>
            <input type="checkbox" checked={showContact} onChange={(e) => setShowContact(e.target.checked)} />
            Show contact email after approval
          </label>
          <input
            ref={fileInputRef}
            className="hiddenFileInput"
            type="file"
            accept="image/*"
            onChange={(e) => setFile(e.target.files?.[0] || null)}
          />
          <div className="filePickerRow">
            <button className="btn" type="button" onClick={() => fileInputRef.current?.click()}>
              Choose Screenshot
            </button>
            <div className="filePickerName">{file ? file.name : "No screenshot selected"}</div>
            {file ? (
              <button
                className="btn"
                type="button"
                onClick={() => {
                  setFile(null);
                  if (fileInputRef.current) fileInputRef.current.value = "";
                }}
              >
                Remove
              </button>
            ) : null}
          </div>
          <button className="btn primary" type="button" onClick={submit} disabled={submitting}>
            {submitting ? "Submitting..." : "Submit"}
          </button>
          {message ? <div style={{ marginTop: 10, color: "var(--muted)" }}>{message}</div> : null}
        </div>

        <div className="card lostFoundPolicyCard">
          <div className="lostFoundPolicyHeading">Terms of Use</div>
          <div className="lostFoundPolicyText">
            By submitting or commenting in Lost &amp; Found, you confirm your post is truthful, lawful, and does not
            violate anyone&apos;s rights.
          </div>
          <div className="lostFoundPolicyHeading" style={{ marginTop: 12 }}>Comment Policy</div>
          <ul className="lostFoundPolicyList">
            <li>No hate speech.</li>
            <li>No defamation.</li>
            <li>No threats.</li>
            <li>Comments may be removed at any time for policy violations or moderation concerns.</li>
            <li>Publishing defamatory comments can create legal liability depending on jurisdiction.</li>
          </ul>
        </div>

        <div className="card" style={{ padding: 14 }}>
          <div style={{ fontWeight: 900, marginBottom: 8 }}>Published Listings</div>
          <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
            <input
              className="searchInput"
              placeholder="Filter listings by county (optional)"
              value={listCounty}
              onChange={(e) => setListCounty(e.target.value)}
            />
            <button className="btn" onClick={() => setListCounty("")} type="button">
              Clear
            </button>
          </div>
          <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 10 }}>
            New submissions may remain hidden until approved.
          </div>
          {markMessage ? <div style={{ marginBottom: 10, color: "var(--muted)" }}>{markMessage}</div> : null}
          {loading ? <div style={{ color: "var(--muted)" }}>Loading...</div> : null}
          {!loading && !posts.length ? <div style={{ color: "var(--muted)" }}>No listings found.</div> : null}
          {posts.map((p) => (
            <div key={p.id} className="lostFoundPostCard">
              <div style={{ fontWeight: 800 }}>
                {p.type === "lost" ? "Lost" : "Found"}: {p.title}
              </div>
              <div style={{ fontSize: 13, color: "var(--muted)", marginBottom: 4 }}>
                {p.county}, {p.state_code}
              </div>
              <div style={{ fontSize: 14 }}>{p.description}</div>
              {p.contact_email ? (
                <div style={{ marginTop: 6, fontSize: 13, color: "var(--muted)" }}>Contact: {p.contact_email}</div>
              ) : null}
              {p.images[0] ? (
                <img
                  src={`/api/uploads/lost-found/${encodeURIComponent(p.images[0])}`}
                  alt=""
                  className="lostFoundImage"
                />
              ) : null}
              {p.type === "lost" && !p.is_resolved ? (
                <div style={{ marginTop: 8 }}>
                  {markingId === p.id ? (
                    <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 10 }}>
                      <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 6 }}>
                        Confirm with the contact email used at submit time.
                      </div>
                      <input
                        className="searchInput"
                        type="email"
                        placeholder="Contact email"
                        value={markEmail}
                        onChange={(e) => setMarkEmail(e.target.value)}
                        style={{ marginBottom: 8 }}
                      />
                      <textarea
                        className="searchInput"
                        placeholder="Optional note"
                        value={markNote}
                        onChange={(e) => setMarkNote(e.target.value)}
                        style={{ marginBottom: 8, minHeight: 72 }}
                      />
                      <div style={{ display: "flex", gap: 8 }}>
                        <button
                          className="btn primary"
                          type="button"
                          disabled={markSubmitting}
                          onClick={() => submitMarkFound(p.id)}
                        >
                          {markSubmitting ? "Updating..." : "Mark Found"}
                        </button>
                        <button
                          className="btn"
                          type="button"
                          disabled={markSubmitting}
                          onClick={() => setMarkingId(null)}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button className="btn" type="button" onClick={() => startMarkFound(p.id)}>
                      I found this item
                    </button>
                  )}
                </div>
              ) : null}
              <div className="lostFoundCommentHeader">
                <div className="lostFoundCommentCount">
                  {Number(commentListByPost[p.id]?.length ?? p.comment_count ?? 0)} comment
                  {Number(commentListByPost[p.id]?.length ?? p.comment_count ?? 0) === 1 ? "" : "s"}
                </div>
                <button className="btn" type="button" onClick={() => void toggleComments(p.id)}>
                  {commentOpenByPost[p.id] ? "Hide Comments" : "Show Comments"}
                </button>
              </div>
              {commentOpenByPost[p.id] ? (
                <div className="lostFoundComments">
                  {commentLoadingByPost[p.id] ? <div className="lostFoundCommentMuted">Loading comments...</div> : null}
                  {!commentLoadingByPost[p.id] && !(commentListByPost[p.id] || []).length ? (
                    <div className="lostFoundCommentMuted">No comments yet.</div>
                  ) : null}
                  {(commentListByPost[p.id] || []).map((comment) => (
                    <div key={comment.id} className="lostFoundCommentItem">
                      <div className="lostFoundCommentMeta">
                        <span className="lostFoundCommentAuthor">{comment.name}</span>
                        <span>{formatFromNow(comment.created_at)}</span>
                      </div>
                      <div className="lostFoundCommentBody">{comment.comment}</div>
                    </div>
                  ))}
                  <div className="lostFoundCommentForm">
                    <input
                      className="searchInput"
                      placeholder="Your name"
                      value={getCommentDraft(p.id).name}
                      onChange={(e) => updateCommentDraft(p.id, { name: e.target.value })}
                    />
                    <input
                      className="searchInput"
                      type="email"
                      placeholder="Your email"
                      value={getCommentDraft(p.id).email}
                      onChange={(e) => updateCommentDraft(p.id, { email: e.target.value })}
                    />
                    <textarea
                      className="searchInput"
                      placeholder="Write your comment"
                      value={getCommentDraft(p.id).comment}
                      onChange={(e) => updateCommentDraft(p.id, { comment: e.target.value })}
                      style={{ minHeight: 80 }}
                    />
                    <label className="lostFoundCommentTerms">
                      <input
                        type="checkbox"
                        checked={getCommentDraft(p.id).acceptTerms}
                        onChange={(e) => updateCommentDraft(p.id, { acceptTerms: e.target.checked })}
                      />
                      I agree to the Terms of Use and Comment Policy.
                    </label>
                    <button
                      className="btn primary"
                      type="button"
                      disabled={Boolean(commentSubmittingByPost[p.id])}
                      onClick={() => void submitComment(p.id)}
                    >
                      {commentSubmittingByPost[p.id] ? "Posting..." : "Post Comment"}
                    </button>
                    {commentMessagesByPost[p.id] ? (
                      <div className="lostFoundCommentMuted">{commentMessagesByPost[p.id]}</div>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </AppShell>
  );
}

function OwnerAdminScreen() {
  const [tokenInput, setTokenInput] = useState(() => getOwnerAdminToken());
  const [token, setToken] = useState(() => getOwnerAdminToken());
  const [loading, setLoading] = useState(false);
  const [runningIngest, setRunningIngest] = useState(false);
  const [statusFilter, setStatusFilter] = useState<"pending" | "approved" | "rejected" | "resolved" | "all">("all");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [logs, setLogs] = useState<AdminIngestionLog[]>([]);
  const [feedHealth, setFeedHealth] = useState<AdminFeedHealth[]>([]);
  const [posts, setPosts] = useState<LostFoundPost[]>([]);

  async function refreshAll(activeToken = token) {
    if (!activeToken.trim()) {
      setError("Enter your admin token.");
      return;
    }

    setLoading(true);
    setError("");
    setNotice("");
    try {
      const [logRes, healthRes, lostRes] = await Promise.all([
        getAdminIngestionLogs({ token: activeToken, limit: 15 }),
        getAdminFeedHealth({ token: activeToken, hours: 48, limit: 200 }),
        listAdminLostFound({ token: activeToken, status: statusFilter, limit: 200 })
      ]);
      setLogs(logRes.logs || []);
      setFeedHealth(healthRes.feeds || []);
      setPosts(lostRes.posts || []);
    } catch (err: any) {
      setError(String(err?.message || err));
      setLogs([]);
      setFeedHealth([]);
      setPosts([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!token.trim()) return;
    void refreshAll(token);
  }, [token, statusFilter]);

  async function saveTokenAndLoad() {
    const normalized = tokenInput.trim();
    setOwnerAdminToken(normalized);
    setToken(normalized);
    if (normalized) {
      await refreshAll(normalized);
    } else {
      setLogs([]);
      setFeedHealth([]);
      setPosts([]);
    }
  }

  async function runIngestNow() {
    if (!token.trim()) {
      setError("Enter your admin token.");
      return;
    }

    setRunningIngest(true);
    setNotice("");
    setError("");
    try {
      const res = await runAdminFeedReload({ token });
      if (!res.ok) {
        setError(res.stderr || "Manual ingestion failed");
      } else {
        setNotice("Manual ingestion triggered successfully.");
      }
      await refreshAll(token);
    } catch (err: any) {
      setError(String(err?.message || err));
    } finally {
      setRunningIngest(false);
    }
  }

  async function deletePost(postId: string) {
    if (!token.trim()) {
      setError("Enter your admin token.");
      return;
    }
    const confirmed = window.confirm("Delete this listing permanently?");
    if (!confirmed) return;

    setNotice("");
    setError("");
    try {
      await deleteAdminLostFound({ token, id: postId });
      setPosts((prev) => prev.filter((post) => post.id !== postId));
      setNotice("Listing deleted.");
    } catch (err: any) {
      setError(String(err?.message || err));
    }
  }

  async function approvePost(postId: string) {
    if (!token.trim()) {
      setError("Enter your admin token.");
      return;
    }
    setNotice("");
    setError("");
    try {
      await approveAdminLostFound({ token, id: postId });
      setNotice("Listing approved.");
      await refreshAll(token);
    } catch (err: any) {
      setError(String(err?.message || err));
    }
  }

  async function rejectPost(postId: string) {
    if (!token.trim()) {
      setError("Enter your admin token.");
      return;
    }
    const reason = window.prompt("Reason for rejection (required):", "Policy violation");
    if (!reason || !reason.trim()) return;

    setNotice("");
    setError("");
    try {
      await rejectAdminLostFound({ token, id: postId, reason: reason.trim() });
      setNotice("Listing rejected.");
      await refreshAll(token);
    } catch (err: any) {
      setError(String(err?.message || err));
    }
  }

  const criticalFeeds = feedHealth.filter((f) => f.health_status === "critical");
  const degradedFeeds = feedHealth.filter((f) => f.health_status === "degraded");

  return (
    <AppShell title="Owner Admin">
      <div className="section">
        <div className="card" style={{ padding: 14, marginBottom: 12 }}>
          <div style={{ fontWeight: 900, marginBottom: 8 }}>Private Owner Panel</div>
          <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 8 }}>
            This route is not linked in the app. Keep the URL and token private.
          </div>
          <input
            className="searchInput"
            type="password"
            placeholder="Admin token"
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
            style={{ marginBottom: 8 }}
          />
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="btn primary" type="button" onClick={saveTokenAndLoad} disabled={loading}>
              Save Token + Load
            </button>
            <button className="btn" type="button" onClick={() => void refreshAll(token)} disabled={loading || !token.trim()}>
              Refresh
            </button>
            <button className="btn" type="button" onClick={runIngestNow} disabled={runningIngest || !token.trim()}>
              {runningIngest ? "Running..." : "Run Ingestion Now"}
            </button>
          </div>
          {error ? <div style={{ color: "#b91c1c", marginTop: 8 }}>{error}</div> : null}
          {notice ? <div style={{ color: "var(--muted)", marginTop: 8 }}>{notice}</div> : null}
        </div>

        <div className="card" style={{ padding: 14, marginBottom: 12 }}>
          <div style={{ fontWeight: 900, marginBottom: 8 }}>Ingestion Status</div>
          <div style={{ fontSize: 13, color: "var(--muted)", marginBottom: 8 }}>
            Critical feeds: {criticalFeeds.length} | Degraded feeds: {degradedFeeds.length} | Total checked: {feedHealth.length}
          </div>
          {!logs.length ? (
            <div style={{ color: "var(--muted)" }}>No ingestion logs loaded yet.</div>
          ) : (
            logs.slice(0, 8).map((log) => (
              <div key={log.id} style={{ borderTop: "1px solid var(--border)", paddingTop: 8, marginTop: 8 }}>
                <div style={{ fontWeight: 700 }}>
                  Run #{log.id} • {log.status} • {log.source || "cron/manual"}
                </div>
                <div style={{ fontSize: 12, color: "var(--muted)" }}>
                  Started {formatPublishedDate(log.started_at)} | Finished {log.finished_at ? formatPublishedDate(log.finished_at) : "running"}
                </div>
                <div style={{ fontSize: 12, color: "var(--muted)" }}>
                  Feeds {log.details?.feedsProcessed ?? 0}, New items {log.details?.itemsUpserted ?? 0}, Summaries {log.details?.summariesGenerated ?? 0}, Errors {log.feed_errors}
                </div>
              </div>
            ))
          )}
        </div>

        <div className="card" style={{ padding: 14, marginBottom: 12 }}>
          <div style={{ fontWeight: 900, marginBottom: 8 }}>Feed Health (48h)</div>
          {!feedHealth.length ? (
            <div style={{ color: "var(--muted)" }}>No feed health data loaded yet.</div>
          ) : (
            feedHealth
              .sort((a, b) => {
                const rank = (x: string) => (x === "critical" ? 0 : x === "degraded" ? 1 : x === "healthy" ? 2 : 3);
                return rank(a.health_status) - rank(b.health_status);
              })
              .slice(0, 25)
              .map((feed) => (
                <div key={feed.id} style={{ borderTop: "1px solid var(--border)", paddingTop: 8, marginTop: 8 }}>
                  <div style={{ fontWeight: 700 }}>
                    {feed.name} ({feed.health_status})
                  </div>
                  <div style={{ fontSize: 12, color: "var(--muted)" }}>
                    {feed.category} | Last check {feed.last_metric_at ? formatPublishedDate(feed.last_metric_at) : "never"} | Recent items {feed.recent_items} | Error rate {(feed.error_rate * 100).toFixed(0)}%
                  </div>
                </div>
              ))
          )}
        </div>

        <div className="card" style={{ padding: 14 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
            <div style={{ fontWeight: 900 }}>Lost & Found Listings</div>
            <select
              className="searchInput"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
              style={{ maxWidth: 180 }}
            >
              <option value="all">All</option>
              <option value="pending">Pending</option>
              <option value="approved">Approved</option>
              <option value="rejected">Rejected</option>
              <option value="resolved">Resolved</option>
            </select>
          </div>
          {!posts.length ? (
            <div style={{ color: "var(--muted)" }}>No listings found for this filter.</div>
          ) : (
            posts.map((post) => (
              <div key={post.id} style={{ borderTop: "1px solid var(--border)", paddingTop: 8, marginTop: 8 }}>
                <div style={{ fontWeight: 700 }}>
                  {post.type.toUpperCase()} • {post.status}
                  {post.is_resolved ? " • resolved" : ""}
                </div>
                <div>{post.title}</div>
                <div style={{ fontSize: 12, color: "var(--muted)" }}>
                  {post.county}, {post.state_code} | Submitted {formatPublishedDate(post.submitted_at)}
                </div>
                <div style={{ marginTop: 6, display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {post.status === "pending" ? (
                    <>
                      <button className="btn primary" type="button" onClick={() => void approvePost(post.id)}>
                        Approve
                      </button>
                      <button className="btn" type="button" onClick={() => void rejectPost(post.id)}>
                        Reject
                      </button>
                    </>
                  ) : null}
                  <button className="btn" type="button" onClick={() => void deletePost(post.id)}>
                    Delete
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </AppShell>
  );
}

function SearchScreen() {
  const nav = useNavigate();
  const [q, setQ] = useState("");
  const [scope, setScope] = useState<"ky" | "national" | "all">("ky");
  const [items, setItems] = useState<Item[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function runSearch(nextCursor?: string | null) {
    if (!q.trim()) return;
    if (nextCursor && loading) return;
    setLoading(true);
    try {
      const res = await searchItems(q.trim(), { scope, cursor: nextCursor ?? undefined, limit: 30 });
      setItems((prev) => (nextCursor ? [...prev, ...res.items] : res.items));
      setCursor(res.nextCursor);
    } finally {
      setLoading(false);
    }
  }

  return (
    <AppShell title="Search">
      <div className="section">
        <input
          className="pill"
          style={{ width: "100%", padding: "12px 12px", borderRadius: 12, border: "1px solid var(--border)" }}
          placeholder="Find specific articles in your Feedly"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void runSearch(null);
          }}
        />

        <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
          <button
            className="pill"
            style={{ flex: 1, textAlign: "center", cursor: "pointer", borderColor: scope === "ky" ? "var(--accent)" : undefined }}
            onClick={() => setScope("ky")}
          >
            Kentucky
          </button>
          <button
            className="pill"
            style={{ flex: 1, textAlign: "center", cursor: "pointer", borderColor: scope === "national" ? "var(--accent)" : undefined }}
            onClick={() => setScope("national")}
          >
            National
          </button>
          <button
            className="pill"
            style={{ flex: 1, textAlign: "center", cursor: "pointer", borderColor: scope === "all" ? "var(--accent)" : undefined }}
            onClick={() => setScope("all")}
          >
            Both
          </button>
        </div>

        <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
          <div className="pill" style={{ flex: 1, textAlign: "center" }}>
            Last 7 Days
          </div>
          <div className="pill" style={{ flex: 1, textAlign: "center" }}>
            Sort by Newest
          </div>
        </div>

        {!q.trim() ? (
          <div style={{ marginTop: 18, color: "var(--muted)" }}>
            <div style={{ fontWeight: 800, color: "#2563eb", marginBottom: 10 }}>Learn By Example</div>

            <div className="card" style={{ padding: 14 }}>
              <div className="pill" style={{ display: "inline-block", marginBottom: 10 }}>"Roger Federer"</div>
              <div>Put phrase inside <span style={{ color: "var(--accent)", fontWeight: 900 }}>quotes</span> for an exact match</div>

              <div style={{ height: 12 }} />

              <div className="pill" style={{ display: "inline-block", marginBottom: 10 }}>"Roger Federer" -tennis</div>
              <div>Use the <span style={{ color: "var(--accent)", fontWeight: 900 }}>minus (-)</span> operator to exclude results</div>

              <div style={{ height: 12 }} />

              <div className="pill" style={{ display: "inline-block", marginBottom: 10 }}>"Roger Federer" AND philanthropy</div>
              <div>Use <span style={{ color: "var(--accent)", fontWeight: 900 }}>AND</span> to search for multiple keywords</div>

              <div style={{ height: 12 }} />

              <div className="pill" style={{ display: "inline-block", marginBottom: 10 }}>"Roger Federer" OR "Rafael Nadal"</div>
              <div>Combine searches with <span style={{ color: "var(--accent)", fontWeight: 900 }}>OR</span></div>
            </div>
          </div>
        ) : (
          <div style={{ marginTop: 14 }}>
            <button className="btn block primary" onClick={() => runSearch(null)} disabled={loading}>
              {loading ? "Searching…" : "Search"}
            </button>

            <div style={{ height: 12 }} />

            <StoryDeck items={items} onOpen={(id) => nav(`/item/${id}`)} />

            {items.length ? <InfinitePager hasMore={Boolean(cursor)} loading={loading} onLoadMore={() => runSearch(cursor)} /> : null}
            {!loading && q.trim() && !items.length ? <div className="listStatus">No results found</div> : null}
          </div>
        )}
      </div>
    </AppShell>
  );
}
