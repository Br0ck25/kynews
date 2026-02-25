# Local KY News -- Full SEO & AI Implementation Plan

*Last Updated: 2026-02-25 | Version 2.0*

---

# 1. Project Objective

Build a high-authority Local KY News news aggregation platform that:

- Uses AI-generated summaries (35--50% of original article length)
- Strictly avoids hallucinations, assumptions, or added opinions
- Provides structured SEO optimization
- Complies with Google News requirements
- Ranks for hyper-local long-tail keywords
- Maintains fast Cloudflare-powered performance
- Respects and credits original publishers at all times

---

# 2. Content Strategy

## 2.1 Summary Length Policy

Each article will:

- Summarize 35--50% of the original article length
- Apply a hard cap of 1200 words maximum for short articles (under 400 words), regardless of percentage, to avoid over-reproducing brief pieces
- Preserve factual structure
- Maintain chronological order
- Use proper paragraphs and punctuation
- Avoid adding information not present in the source
- Avoid assumptions, analysis, or opinion

## 2.2 Attribution Structure

Every article page must include — prominently and without exception:

- Publisher name (displayed clearly above or below the summary)
- Direct link to the original article (labeled "Read full story at [Publisher Name]")
- Original author name (if provided by the source)
- Original published date and time
- A clear visual or textual label identifying this as a summary (e.g., "Summary — Original reporting by [Publisher Name]")

## 2.3 Editorial Philosophy

This platform summarizes; it does not replace. The summary exists to inform readers of what is happening in Kentucky.

---

# 3. Cloudflare AI Worker Implementation

## 3.1 Worker Responsibilities

The AI Worker must:

1. Fetch article content.
2. Clean HTML (remove ads, scripts, nav).
3. Extract structured article body.
4. Send text to AI model.

---

## 3.2 AI Prompt Requirements (STRICT MODE)

The Worker prompt must enforce:

- No new facts
- No speculation
- No summarization bias
- No opinion language
- No filler
- No "according to experts" unless in article
- No assumptions about cause, intent, or future events

### AI Prompt Template

```
You are a professional news summarizer for a local Kentucky news platform.

Before summarizing, clean the input:
- Remove copyright notices, legal disclaimers, broadcast restrictions,
  bylines, author credits, and publication boilerplate.
- Remove section headers and subheadings. Incorporate any essential
  information from headers into the body paragraphs naturally.

Summarize the cleaned article to approximately 35–50% of its original
length. If the original article is under 400 words, cap your summary
at 200 words maximum.

Your summary must:
- Begin with who, what, where, and why this is newsworthy.
- Cover the full arc of the article from start to finish.
- Always end on a complete sentence. Never end mid-sentence or mid-thought.
- Be formatted as short, readable paragraphs of 2–3 sentences each.
  Never output a wall of unbroken text or a single long paragraph.
- Preserve important facts, names, locations, dates, and figures exactly.
- Include no more than one direct quote, only if it meaningfully adds
  to the story.

Your summary must never:
- End mid-sentence under any circumstances. If you are approaching the
  word limit, finish the current sentence and stop cleanly.
- Output section headers, subheadings, or bolded titles of any kind.
- Output text as one unbroken paragraph.
- Include copyright notices, bylines, legal text, or publication footers.
- Add facts, opinions, assumptions, or analysis not in the original.
- Exaggerate, soften, or reframe any statement.

Return clean, publication-ready paragraphs only. No headlines, labels,
bullet points, subheadings, or commentary.

Article:
{ARTICLE_TEXT}
```

---

# 4. Database Structure

Each article record should store:

- id
- title
- slug
- summary
- original_url
- source_name
- source_author
- published_at
- county_tags
- category_tags
- created_at
- updated_at

---

# 5. SEO Architecture

## 5.1 URL Structure

- /perry-county/school-board-meeting-feb-2026
- /hazard-ky/flood-warning-update
- /knott-county/arrest-report-feb-2026

## 5.2 Canonicalization Policy

Article summary pages should use a **self-referencing canonical tag** pointing to the summary page URL. Do not use a canonical pointing to the original source URL, as this would signal to Google that your page has no independent value. The attribution link to the original source serves the crediting purpose; the canonical serves the indexing purpose. These are separate concerns.

## 5.3 Duplicate Content Strategy

Because many aggregators may summarize the same regional or AP-wire stories, differentiation is essential. Every summary page should:

- Surface county tags prominently (Perry County, Knott County, etc.) as a structural signal
- Publish as quickly as possible after source articles go live (first-to-index advantage)
- Include a brief unique introductory sentence placing the story in local context where factually possible without editorializing

## 5.4 Category Pages

Each county page must:

- Contain 300--500 words of unique introductory content about that county
- Dynamically list latest articles
- Include internal links
- Include structured data
- Be indexable

## 5.5 Required Schema

Use JSON-LD:

- NewsArticle
- WebSite
- BreadcrumbList

Include:

- headline
- datePublished
- dateModified
- author (original article author where available)
- publisher (original publisher name)
- mainEntityOfPage
- image (if available)

---

# 6. E-E-A-T Strategy

Google evaluates news content heavily on Experience, Expertise, Authoritativeness, and Trustworthiness. To support Google News approval and long-term ranking:

- Create a named editorial team page with bios and credentials
- Publish a clear editorial policy explaining the summarization methodology, attribution standards, and commitment to accuracy
- Include an About page that clearly identifies the organization, its mission, and its Kentucky focus
- Add author attribution on any original content (county introductory pages, dashboards, etc.)
- Display publisher attribution and original author credit on every summary page — this also signals transparency to Google's quality evaluators

---

# 7. News Sitemap Strategy

Generate:

- sitemap.xml (all content)
- news-sitemap.xml (last 48 hours only)

News sitemap must include:

- Publication name
- Publication language
- Publication date
- Title

Automatically regenerate every hour.

---

# 8. Internal Linking Strategy

Every article page should:

- Link to county page
- Link to category page
- Link to 3--5 related articles
- Include breadcrumb navigation

---

# 9. Content Discovery & Feed Monitoring

To consistently hit publishing volume targets, a reliable content discovery system is required:

- Monitor RSS feeds from all target Kentucky news sources
- Set up Google Alerts for key county names, towns, and recurring topics (flooding, school board, arrests, elections)
- Poll feeds on a scheduled interval (every 15--30 minutes recommended)
- Flag duplicate stories (same event covered by multiple outlets) to avoid processing the same news multiple times
- Prioritize time-sensitive breaking news for immediate processing

---

# 10. Content Velocity Plan

Recommended publishing volume:

- Focus only on Kentucky coverage
- Maintain consistent daily publishing rhythm — Google News rewards regularity

---

# 11. Google News Approval Checklist

Must include:

- About page with named organization and editorial team
- Contact page
- Editorial policy page (explain summarization approach and attribution standards)
- Privacy policy
- Clear publisher identity
- No scraped full-text content
- No auto-spun content
- Attribution and source links on every article page

---

# 12. Performance Optimization

Using Cloudflare:

- Edge caching enabled
- HTML caching rules
- Image compression
- Lazy loading
- Preconnect to API endpoints
- Minify JS/CSS

---

# 13. Anti-Hallucination Safeguards

## 13.1 Validation Step

After AI summary generation:

- Compare named entities between original and summary
- Reject summary if new entities appear
- Reject summary if dates differ
- Reject summary if numerical values differ

## 13.2 Length Check

If summary is:

- Less than 35% of original → regenerate
- More than 50% of original → regenerate
- More than 200 words for articles under 400 words → truncate and regenerate

---

# 14. Future Expansion

Phase 2:

- Geo-tagging
- Interactive county map
- Incident filtering
- School closings dashboard
- Election results dashboard

Phase 3:

- Personalized keyword filters
- Push notifications
- County email digests

---

# 15. Realistic Timeline

**Month 1:**
- AI worker finalized with updated prompt and length rules
- Schema implementation
- Sitemap automation
- Feed monitoring system live

**Month 2:**
- County authority pages with unique content
- E-E-A-T pages (About, Editorial Policy, Team bios)
- Google News submission

**Months 3--6:**
- Authority building
- Long-tail ranking growth
- Backlink acquisition

---

# 16. Core Principles

This platform must:

- Add value through structured, well-attributed summaries
- Respect original publishers and drive traffic back to them
- Credit every original author and publication clearly and prominently
- Stay factual and neutral
- Build topical authority in Kentucky
- Prioritize quality over volume
- Operate transparently so readers, publishers, and Google all understand exactly what this platform is and how it works

---

END OF DOCUMENT
