# SEO Audit & Improvement Plan — Local KY News
**Audit Date:** March 14, 2026  
**Site:** localkynews.com  
**Audited:** All frontend pages, Cloudflare Worker backend, public files, database schema

---

## Executive Summary

The site has **strong foundational SEO** — the Cloudflare Worker performs server-side rendering for bots, sitemaps are dynamically generated, NewsArticle JSON-LD schema is comprehensive, and thin content is automatically suppressed. However, there are **clear, fixable gaps** in category feed pages, pagination link tags, schema coverage on secondary pages, and image format optimization that are leaving ranking opportunities on the table.

**Overall Grade: B+ → Target: A**

---

## ✅ What's Already Done Well

### Infrastructure
- **Dynamic robots.txt** — All major crawlers allowed; AI bots (GPTBot, PerplexityBot, ClaudeBot) explicitly welcomed
- **Three-part sitemap system** — `/sitemap-index.xml`, `/sitemap.xml` (all articles + 120 county pages), `/sitemap-news.xml` (last 48h, 1-min TTL for Google News)
- **Bot detection + server-side rendering** — Crawlers receive full HTML with meta tags, not a JS loading spinner
- **120-county 301 redirects** — All legacy `/news/:county` paths redirect to canonical `/news/kentucky/:county` with 301s in `_redirects`
- **llms.txt** — Properly structured for AI discovery systems
- **PWA manifest** — Icons, shortcuts, standalone display
- **Performance headers** — 1-year cache on hashed assets, proper no-cache on HTML, security headers

### Metadata & Schema
- **NewsArticle JSON-LD** on every article — headline, datePublished, dateModified, author, publisher, isAccessibleForFree, contentLocation, speakable
- **BreadcrumbList** on articles and county pages
- **CollectionPage + FAQPage** on county hub pages
- **WebSite + Organization** schema on homepage
- **Event schema** for sports/event articles (extracted dates, location, organizer)
- **Canonical URLs** on all article and county pages
- **OG + Twitter Card tags** on all article and county pages
- **Dynamic robots meta** — articles under 150 words automatically get `noindex,follow`
- **noindex on search results** — correct, prevents duplicate content penalty
- **noindex on paginated county pages** — correct

### Content & Code Quality
- Dedicated `seo_description` DB column separate from display summary
- `image_alt`, `image_width`, `image_height` stored in database and passed through to schema
- Smart image alt fallback: `imageAlt → "News photo from {county} — {title}"`
- `fetchpriority="high"` + `loading="eager"` on above-fold featured image (LCP optimization)
- `loading="lazy"` on all below-fold images
- Semantic heading hierarchy — each page has exactly one `<h1>`
- SEO-friendly URL structure: `/news/kentucky/pike-county/article-slug`
- `normalizeOgImage()` prevents logo appearing in social preview cards

---

## 🔴 Critical Gaps (Fix First — High Impact)

### 1. Category Feed Pages Missing OG, Twitter Cards, and Canonical ✅ Completed

**Pages affected:** `/today`, `/national`, `/sports`, `/weather`, `/schools`

**Fix:** `src/pages/category-feed-page.js` now injects OG tags, Twitter card tags, canonical URL, and updates the `<meta name="description">` tag on mount. This ensures these high-traffic category pages produce correct social previews and provide a canonical signal for search engines.

**Impact:** High — social shares of category pages now show correct previews, and Google receives a canonical hint for each category page.

---

### 2. `setPaginationLinks()` Is Now Called (✅ Completed)

**File:** [category-feed-page.js](src/pages/category-feed-page.js)

✅ The pagination meta links are already injected. The existing `useEffect` that runs when `cursor` changes now calls `setPaginationLinks(prevCursor, cursor, baseUrl)`, which creates `<link rel="prev">` and `<link rel="next">` elements in the document head.

**Impact:** Medium-High — improves crawl efficiency and prevents link equity fragmentation across paginated series.

---

### 3. Server-Side Redirect Missing for Legacy Routes ✅ Completed

**Problem:** The `LegacyCountyRedirect` component in [App.js](src/App.js) uses React Router's `<Redirect>` — a **client-side JavaScript redirect**. Googlebot and other crawlers may not execute JavaScript, meaning they could index the old `/news/:county` URLs and never follow the redirect to the canonical `/news/kentucky/:county` path.

**Fix:** Implemented a **301 HTTP redirect** in `worker/src/index.ts` for `/news/:county` → `/news/kentucky/:county` before the SPA shell is served. This ensures crawlers and non-JS clients receive the canonical URL immediately.

**Verification step:**
```bash
curl -I https://localkynews.com/news/pike-county
# Returns: HTTP/2 301 Location: /news/kentucky/pike-county
```

**Impact:** High — ensures legacy URLs pass PageRank to canonical URLs and prevents old URLs from being indexed.

---

## 🟡 Important Gaps (Fix Soon — Medium Impact)

### 4. About, Contact, Privacy, Editorial Policy Pages Missing OG/Twitter Cards ✅ Completed

**Pages:** `/about`, `/contact`, `/privacy-policy`, `/editorial-policy`

**Fix:** Each page now injects OG tags, Twitter card tags, and a canonical URL in an effect on mount, using the same pattern as the category feed metadata injection.

**Impact:** Medium — improves E-E-A-T signals, provides correct social sharing previews, and ensures a canonical signal for each page.

---

### 5. County Info Sub-Pages Missing All Metadata

**Pages:** `/news/kentucky/:county/government-offices`, `/news/kentucky/:county/utilities`

**Problem:** These sub-pages (county government offices, utilities) have no OG tags, no canonical, and no structured data. They represent **120 × 2 = 240 unique local information pages** — a major long-tail SEO opportunity.

**Fix needed:**
- Set canonical URL per page: `https://localkynews.com/news/kentucky/{county}/government-offices`
- Set OG tags with county-specific content
- Add `GovernmentService` JSON-LD schema for government offices pages
- Add `LocalBusiness` or `UtilityService` JSON-LD for utilities pages

**Example GovernmentService schema:**
```json
{
  "@context": "https://schema.org",
  "@type": "GovernmentService",
  "name": "{County} County Government Services",
  "areaServed": { "@type": "AdministrativeArea", "name": "{County} County, Kentucky" },
  "provider": { "@type": "GovernmentOrganization", "name": "{County} County Government" }
}
```

**Impact:** Medium-High — 240 additional indexable pages with structured data, strong local SEO signals.

---

### 6. Add `<link rel="sitemap">` to HTML Head ✅ Completed

**Problem:** The root `index.html` does not include a `<link rel="sitemap" href="/sitemap-index.xml">` tag, which is the standard HTML discovery hint for sitemap location.

**Fix:** Added to both `index.html` and `public/index.html`:
```html
<link rel="sitemap" type="application/xml" href="/sitemap-index.xml" />
```

**Impact:** Low-Medium — improves sitemap discoverability for crawlers that don't parse `robots.txt`.

---

### 7. Add `hreflang` Tags ✅ Completed

**Problem:** All content is `en-US` but no `hreflang` attribute is set in the HTML. This is a minor but easy win.

**Fix:** Added to `index.html` and `public/index.html`:
```html
<link rel="alternate" hreflang="en-US" href="https://localkynews.com/" />
<link rel="alternate" hreflang="x-default" href="https://localkynews.com/" />
```

**Impact:** Low — prevents any potential locale confusion with search engines.

---

### 8. Thin WWW / Non-WWW Canonicalization Verification ✅ Completed

**Problem:** Both `localkynews.com` and `www.localkynews.com` routes are handled by the Worker. It's unclear whether both serve `<link rel="canonical">` pointing to the same preferred version. If the canonical in the homepage HTML says `https://localkynews.com/` but `www.localkynews.com/` also serves `index,follow`, there's a potential duplicate content signal.

**Fix:** Implemented Option A — the Worker now issues a **301 redirect from `www.localkynews.com` to `localkynews.com`** at the HTTP level, ensuring a single canonical hostname and consolidating ranking signals.

**Impact:** Medium — prevents duplicate content issues and ensures all SEO signals consolidate on the non-www domain.

---

## 🟢 Optimization Opportunities (Nice to Have — Lower Urgency)

### 10. Responsive Images (srcset + WebP)

**Current state:** All images are served as single-size URLs from source. No `srcset`, no `sizes`, no WebP.

**Fix approach:**
- Route all images through a Cloudflare Images or Images Resizing service
- Add `srcset` attributes with at least two sizes (e.g., 400w and 800w)
- Add `type="image/webp"` via `<picture>` element or Accept header negotiation

**Impact:** Medium — improves LCP score and Core Web Vitals, which are ranking signals. WebP images are typically 30-40% smaller.

---

### 11. Internal Linking Strategy

**Current state:** Articles don't appear to link to related articles, county pages, or topical clusters. Internal links pass PageRank and help Google understand site structure.

**Fix opportunities:**
- Add "Related Articles" section at the bottom of every article page (already has county/category data to query by)
- Link county article cards to the `/news/kentucky/:county` hub page
- Add breadcrumb navigation links in the UI (the JSON-LD exists; the visible HTML `<nav>` may not)
- Link from county hub pages to the 2–3 most recent articles per subcategory (sports, schools, weather)

**Impact:** High long-term — strong internal linking is one of the most undervalued on-page SEO factors.

---

### 12. E-E-A-T Enhancement for News Site Credibility

**Current state:** Editorial policy page exists with AI disclosure. Contact page exists.

**Gaps:**
- No author bylines with author profile pages or schema
- No "Corrections" policy page
- No masthead/team page with real names and credentials
- No ISSN or media accreditation signals
- `foundingDate: 2025` is recent — new sites face trust gap with Google News

**Fix:**
- Add author profile schema to the editorial policy and about pages
- Add a `NewsMediaOrganization` JSON-LD with `masthead`, `ethics policy URL`, and `corrections` fields
- Consider applying for Google News inclusion (requires editorial standards)
- Add date of each article's last review/verification to the NewsArticle schema

**Impact:** High long-term — E-E-A-T is increasingly central to Google's quality evaluation of news sites.

---

### 13. Core Web Vitals Monitoring

**What to measure:**
- **LCP (Largest Contentful Paint)** — target < 2.5s. Featured image likely drives LCP; verify `fetchpriority="high"` is working as expected
- **FID/INP (Interaction to Next Paint)** — Redux state updates and Material-UI rendering can cause delays
- **CLS (Cumulative Layout Shift)** — image width/height attributes are set, but verify no font-swap shifts

**Tools:**
- Google Search Console → Core Web Vitals report (field data)
- PageSpeed Insights (localkynews.com/today, localkynews.com/news/kentucky/pike-county)
- Chrome DevTools Performance tab

---

### 14. FAQ Schema Expansion to Articles

**Current state:** FAQPage schema is only on county hub pages.

**Opportunity:** For articles about recurring topics (tax deadlines, school calendars, election maps), add FAQPage or HowTo schema inline with the article content. This can generate rich results (expandable FAQ accordions) in Google search.

**Impact:** Medium — rich results improve click-through rate significantly.

---

### 15. Add `<meta name="news_keywords">` Tags ✅ Completed

**Current state:** Google News sitemap includes keywords per article; the HTML pages now also include `<meta name="news_keywords">`, derived from county, category, and Kentucky.

**Impact:** Low-Medium — primarily a Google News signal.

---

### 16. Robots.txt Route in wrangler.jsonc ✅ Completed

**Problem:** `/robots.txt` is served by the Worker (correctly) but is not explicitly listed as a Worker route in `wrangler.jsonc`. It works via catch-all, but explicit routing is more maintainable.

**Fix:** Added to `wrangler.jsonc`:
```json
{ "pattern": "localkynews.com/robots.txt", "zone_name": "localkynews.com" },
{ "pattern": "www.localkynews.com/robots.txt", "zone_name": "localkynews.com" }
```

---

## 📋 Prioritized Action Plan

| Priority | Task | File(s) | Impact | Effort |
|---|---|---|---|---|
| **P0** | Add OG + Twitter cards + canonical to category feed pages | `src/pages/category-feed-page.js` | 🔴 High | Low |
| **P0** | Call `setPaginationLinks()` in category feed | `src/pages/category-feed-page.js` | 🔴 High | Low |
| **P0** | Verify HTTP 301 for `/news/:county` in Worker | `worker/src/index.ts` | 🔴 High | Low |
| **P1** | Add OG/Twitter/canonical to About, Contact, Privacy, Editorial Policy | 4 page files | 🟡 Med | Low |
| **P1** | Add schema + OG/Twitter to county info sub-pages | `src/pages/county-info-page.js` | 🟡 Med | Medium |
| **P1** | Add `<link rel="sitemap">` to HTML heads | `index.html`, `public/index.html` | 🟡 Low | Trivial |
| **P1** | Add hreflang tags | `index.html`, `public/index.html` | 🟡 Low | Trivial |
| **P1** | Verify/fix www vs non-www canonicalization | `worker/src/index.ts` | 🟡 Med | Low |
| **P2** | Add Related Articles section to article pages | `src/pages/article-slug-page.js` | 🟢 High | Medium |
| **P2** | Add breadcrumb navigation UI (HTML, not just JSON-LD) | Article + county pages | 🟢 Med | Medium |
| **P2** | E-E-A-T improvements (author schema, masthead, corrections) | About, Editorial Policy pages | 🟢 High | High |
| **P2** | Responsive images (srcset, WebP, Cloudflare Images) | All image-rendering components | 🟢 Med | High |
| **P2** | Add `<meta name="news_keywords">` to article pages | `src/pages/article-slug-page.js` | 🟢 Low | Low |
| **P3** | Core Web Vitals audit and optimization | Varies | 🟢 Med | Medium |
| **P3** | FAQ schema on recurring-topic articles | Article pages | 🟢 Med | High |
| **P3** | Internal linking (related articles, county cross-links) | Multiple components | 🟢 High | High |
| **P3** | Add robots.txt route explicitly to wrangler.jsonc | `worker/wrangler.jsonc` | 🟢 Low | Trivial |

---

## 🎯 Quick Wins Summary (Can Be Done Today)

These can be implemented in a few hours with minimal risk:

1. **Add `<link rel="sitemap">` + hreflang to index.html** — 5-minute trivial edit
2. **Add OG/Twitter/canonical to CategoryFeedPage** — ~30 lines of code, one file
3. **Call `setPaginationLinks()`** — one function call in an existing effect
4. **Add OG/Twitter to About/Contact/Privacy/Editorial pages** — ~10 lines each
5. **Add `<meta name="news_keywords">` to article page** — one line

These five items won't break anything and immediately close visible gaps in social sharing and crawl signals.

---

## 🔍 Monitoring Checklist

After implementing changes, validate with:

- [ ] **Google Search Console** → Sitemaps → Confirm all three sitemaps submitted and processing
- [ ] **Google Search Console** → Coverage → Check for crawl errors on category pages
- [ ] **Google Rich Results Test** → Test a county page, article page, and homepage
- [ ] **Facebook Sharing Debugger** → Test `/today`, `/national`, a county page, an article URL
- [ ] **Twitter Card Validator** → Same URLs
- [ ] **PageSpeed Insights** → Test `/today` and a county page (mobile and desktop)
- [ ] **Screaming Frog** → Full crawl to find any orphan pages, duplicate titles, missing metas
- [ ] **curl -I** → Verify `/news/pike-county` returns HTTP 301 (not 200)

---

## 📊 Current State vs Target State

| Dimension | Current | Target | Gap |
|---|---|---|---|
| Category pages have OG tags | ❌ 0/6 | ✅ 6/6 | Add OG to feed pages |
| Category pages have canonical | ❌ 0/6 | ✅ 6/6 | Add canonical to feed pages |
| Pagination rel links called | ❌ 0% | ✅ 100% | Call existing function |
| County info sub-pages have schema | ❌ 0/240 | ✅ 240/240 | Add GovernmentService schema |
| Articles have news_keywords meta | ❌ | ✅ | Add meta tag |
| Sitemap linked from HTML head | ❌ | ✅ | One-line fix |
| www/non-www canonicalization | ⚠️ Unverified | ✅ Verified | Audit + verify |
| Legacy route has HTTP 301 | ⚠️ Unverified | ✅ Verified | Audit + verify |
| Internal related article links | ❌ | ✅ | Build related articles component |
| Responsive images (srcset) | ❌ | ✅ | Cloudflare Images integration |
| E-E-A-T signals (author schema) | ⚠️ Minimal | ✅ Full | Author profiles + masthead |
| Core Web Vitals monitored | ❌ | ✅ | GSC setup + PageSpeed baseline |
