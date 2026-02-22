import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { getItem, type Item } from "../data/api";
import { cacheLastOpened, getCachedItem, isSaved, markRead, toggleSaved } from "../data/localDb";

function htmlToText(html: string | null | undefined) {
  if (!html) return "";
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<\/(p|div|section|article|blockquote|h[1-6]|li)>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<[^>]+>/g, "")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function splitLongParagraph(paragraph: string): string[] {
  const text = paragraph.trim();
  if (!text) return [];
  if (text.length < 420) return [text];

  const sentences = (text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [])
    .map((x) => x.trim())
    .filter(Boolean);
  if (sentences.length < 4) return [text];

  const out: string[] = [];
  let bucket: string[] = [];
  for (const sentence of sentences) {
    bucket.push(sentence);
    const joined = bucket.join(" ").trim();
    if (joined.length >= 320 || bucket.length >= 3) {
      out.push(joined);
      bucket = [];
    }
  }
  if (bucket.length) out.push(bucket.join(" ").trim());
  return out.filter(Boolean);
}

function toParagraphs(html: string | null | undefined): string[] {
  const clean = htmlToText(html);
  if (!clean) return [];
  const base = clean
    .split(/\n{2,}/)
    .map((x) => x.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (!base.length) return [];
  return base.flatMap((paragraph) => splitLongParagraph(paragraph));
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
  const [shareMessage, setShareMessage] = useState<string>("");

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
    setShareMessage("");
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

  async function share() {
    if (!item?.url) return;
    setShareMessage("");

    try {
      if (navigator.share) {
        await navigator.share({
          title: item.title,
          text: item.title,
          url: item.url
        });
        return;
      }
    } catch (err: any) {
      if (String(err?.name || "") === "AbortError") return;
    }

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(item.url);
        setShareMessage("Link copied.");
        return;
      }
    } catch {
      // fall through to direct open
    }

    window.open(item.url, "_blank", "noopener,noreferrer");
  }

  const dt = item?.published_at ? new Date(item.published_at) : null;
  const dateStr = dt ? dt.toLocaleString() : "-";
  const summaryParagraphs = useMemo(() => toParagraphs(item?.summary), [item?.summary]);
  const contentParagraphs = useMemo(() => toParagraphs(item?.content), [item?.content]);
  const summaryFingerprint = summaryParagraphs.join(" ").toLowerCase();
  const contentFingerprint = contentParagraphs.join(" ").toLowerCase();
  const showContent = contentParagraphs.length > 0 && contentFingerprint !== summaryFingerprint;

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
                    {saved ? "Saved" : "Save"}
                  </button>
                  <button className="btn" onClick={share} disabled={!item.url}>
                    Share
                  </button>
                  {item.url ? (
                    <a className="btn" href={item.url} target="_blank" rel="noreferrer">
                      Open Original
                    </a>
                  ) : null}
                </div>
                {shareMessage ? <div className="meta" style={{ marginTop: 8 }}>{shareMessage}</div> : null}

                <div className="readerBody">
                  {summaryParagraphs.length ? (
                    <>
                      <div style={{ fontWeight: 800, marginBottom: 6 }}>Summary</div>
                      {summaryParagraphs.map((paragraph, idx) => (
                        <p key={`summary-${idx}`}>{paragraph}</p>
                      ))}
                    </>
                  ) : null}
                  {showContent ? (
                    <>
                      <div style={{ fontWeight: 800, marginBottom: 6, marginTop: 12 }}>Source Excerpt</div>
                      {contentParagraphs.map((paragraph, idx) => (
                        <p key={`content-${idx}`}>{paragraph}</p>
                      ))}
                    </>
                  ) : null}
                  {!summaryParagraphs.length && !contentParagraphs.length ? (
                    <p style={{ color: "var(--muted)" }}>This feed did not provide enough text for an in-app summary yet.</p>
                  ) : null}
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
