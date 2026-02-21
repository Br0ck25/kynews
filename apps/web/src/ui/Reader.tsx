import React, { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { getItem, type Item } from "../data/api";
import { cacheLastOpened, getCachedItem, isSaved, markRead, toggleSaved } from "../data/localDb";

function toText(html: string | null | undefined) {
  if (!html) return "";
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sourceFromUrl(url: string) {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export default function Reader() {
  const nav = useNavigate();
  const { id } = useParams();
  const [item, setItem] = useState<Item | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<boolean>(false);
  const [fromCache, setFromCache] = useState<boolean>(false);
  const [heroImageFailed, setHeroImageFailed] = useState<boolean>(false);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      if (!id) return;
      setError(null);
      setFromCache(false);

      const cached = await getCachedItem(id);
      if (cached && !cancelled) {
        setItem(cached);
        setFromCache(true);
      }

      try {
        const fresh = await getItem(id);
        if (cancelled) return;
        setItem(fresh);
        setFromCache(false);

        await cacheLastOpened({
          id: fresh.id,
          title: fresh.title,
          url: fresh.url,
          author: fresh.author ?? null,
          published_at: fresh.published_at ?? null,
          summary: fresh.summary ?? null,
          content: fresh.content ?? null,
          image_url: fresh.image_url ?? null,
          source: sourceFromUrl(fresh.url)
        });

        await markRead(id);
      } catch (e: any) {
        if (cached) return;
        if (cancelled) return;
        setError(String(e?.message || e));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [id]);

  useEffect(() => {
    let mounted = true;
    (async () => {
      if (!id) return;
      const s = await isSaved(id);
      if (mounted) setSaved(s);
    })();
    return () => {
      mounted = false;
    };
  }, [id]);

  useEffect(() => {
    setHeroImageFailed(false);
  }, [item?.id, item?.image_url]);

  async function toggle() {
    if (!id || !item) return;
    const next = await toggleSaved({
      id: item.id,
      title: item.title,
      url: item.url,
      author: item.author ?? null,
      published_at: item.published_at ?? null,
      summary: item.summary ?? null,
      content: item.content ?? null,
      image_url: item.image_url ?? null,
      source: sourceFromUrl(item.url)
    });
    setSaved(next);
  }

  const dt = item?.published_at ? new Date(item.published_at) : null;
  const dateStr = dt ? dt.toLocaleString() : "-";

  return (
    <div className="app">
      <header className="topbar">
        <button className="iconBtn" onClick={() => nav(-1)} aria-label="Back">
          ←
        </button>

        <div className="title">Article</div>
        <div className="topbarSpacer" />
      </header>

      <div className="appFrame">
        <div className="content">
          <div className="section">
            {error ? (
              <div className="card" style={{ padding: 14 }}>
                <div style={{ fontWeight: 900 }}>Error</div>
                <div style={{ color: "var(--muted)", marginTop: 8 }}>{error}</div>
              </div>
            ) : null}

            {item ? (
              <div className="card readerPad">
                <div className="readerMeta">
                  <span className="pill">{fromCache ? "offline cache" : "live"}</span>
                  <span className="pill">{item.author || "-"}</span>
                  <span className="pill">{dateStr}</span>
                </div>

                <div className="readerTitle">{item.title}</div>

                {item.image_url && !heroImageFailed ? (
                  <img className="hero" src={item.image_url} alt="" onError={() => setHeroImageFailed(true)} />
                ) : null}

                <div className="meta" style={{ marginTop: 12 }}>
                  <button className={"btn " + (saved ? "primary" : "")} onClick={toggle}>
                    {saved ? "Saved" : "Read later"}
                  </button>
                  {item.url ? (
                    <>
                      <button className="btn" onClick={() => nav(`/open?url=${encodeURIComponent(item.url)}`)}>
                        Open original in app
                      </button>
                      <a className="btn" href={item.url} target="_blank" rel="noreferrer">
                        Open external
                      </a>
                    </>
                  ) : null}
                </div>

                <div className="readerBody">
                  {toText(item.content || item.summary) ? (
                    <p>{toText(item.content || item.summary)}</p>
                  ) : (
                    <p style={{ color: "var(--muted)" }}>
                      This feed did not provide content. Use "Open original in app".
                    </p>
                  )}
                </div>
              </div>
            ) : (
              <div className="card" style={{ padding: 14, color: "var(--muted)" }}>
                Loading...
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
