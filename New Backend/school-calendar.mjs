/**
 * School Event Calendar Parser
 *
 * Fetches and parses ICS (iCalendar) feeds from Kentucky school district sites.
 * Creates structured school_events rows alongside articles.
 *
 * Sources:
 *  - kyschools.us district sites (most have /calendar or /calendar.ics endpoints)
 *  - Individual district sites (anderson.k12.ky.us etc.)
 *
 * Events are surfaced on the /schools page alongside articles.
 * Schedule: Sync calendars every 6 hours.
 */

const UA = "Mozilla/5.0 (compatible; KYNewsAggregator/1.0; +https://localkynews.com/bot)";

// ─── ICS Calendar URLs per county ────────────────────────────────────────────
// Pattern: https://{county}.kyschools.us/calendar.ics or /calendar/ics
// We try multiple paths and use the first that works.

const ICS_PATH_CANDIDATES = [
  "/calendar.ics",
  "/ical.ics",
  "/calendar/ical.ics",
  "/feed/calendar.ics",
  "/calendar?format=ics",
  "/events.ics",
  "/events/calendar.ics",
];

export const SCHOOL_DISTRICT_DOMAINS = {
  "Adair":        "www.adair.kyschools.us",
  "Allen":        "www.allen.kyschools.us",
  "Anderson":     "www.anderson.k12.ky.us",
  "Ballard":      "ballard.kyschools.us",
  "Barren":       "www.barren.kyschools.us",
  "Bath":         "www.bath.k12.ky.us",
  "Bell":         "www.bell.kyschools.us",
  "Boone":        "www.boone.kyschools.us",
  "Bourbon":      "www.bourbon.kyschools.us",
  "Boyd":         "www.boyd.kyschools.us",
  "Boyle":        "www.boyle.kyschools.us",
  "Bracken":      "bracken.kyschools.us",
  "Breathitt":    "breathitt.kyschools.us",
  "Breckinridge": "www.breck.kyschools.us",
  "Bullitt":      "www.bullitt.k12.ky.us",
  "Butler":       "butler.kyschools.us",
  "Caldwell":     "www.caldwellschools.com",
  "Calloway":     "www.calloway.kyschools.us",
  "Campbell":     "www.campbell.kyschools.us",
  "Carlisle":     "www.carlisle.kyschools.us",
  "Carroll":      "carroll.kyschools.us",
  "Carter":       "carter.kyschools.us",
  "Casey":        "casey.kyschools.us",
  "Christian":    "christian.kyschools.us",
  "Clark":        "www.clark.kyschools.us",
  "Clay":         "clay.kyschools.us",
  "Clinton":      "clinton.kyschools.us",
  "Crittenden":   "crittenden.kyschools.us",
  "Cumberland":   "cumberland.kyschools.us",
  "Daviess":      "www.daviess.kyschools.us",
  "Edmonson":     "edmonson.kyschools.us",
  "Elliott":      "elliott.kyschools.us",
  "Estill":       "estill.kyschools.us",
  "Fayette":      "www.fcps.net",
  "Fleming":      "fleming.kyschools.us",
  "Floyd":        "www.floyd.kyschools.us",
  "Franklin":     "www.franklin.kyschools.us",
  "Fulton":       "fulton.kyschools.us",
  "Gallatin":     "gallatin.kyschools.us",
  "Garrard":      "garrard.kyschools.us",
  "Grant":        "grant.kyschools.us",
  "Graves":       "www.graves.kyschools.us",
  "Grayson":      "grayson.kyschools.us",
  "Green":        "green.kyschools.us",
  "Greenup":      "greenup.kyschools.us",
  "Hancock":      "hancock.kyschools.us",
  "Hardin":       "www.hardin.kyschools.us",
  "Harlan":       "harlan.kyschools.us",
  "Harrison":     "harrison.kyschools.us",
  "Hart":         "hart.kyschools.us",
  "Henderson":    "henderson.kyschools.us",
  "Henry":        "henry.kyschools.us",
  "Hickman":      "hickman.kyschools.us",
  "Hopkins":      "www.hopkins.kyschools.us",
  "Jackson":      "jackson.kyschools.us",
  "Jefferson":    "www.jefferson.kyschools.us",
  "Jessamine":    "www.jessamine.kyschools.us",
  "Johnson":      "johnson.kyschools.us",
  "Kenton":       "www.kenton.kyschools.us",
  "Knott":        "knott.kyschools.us",
  "Knox":         "www.knox.kyschools.us",
  "Larue":        "larue.kyschools.us",
  "Laurel":       "www.laurel.kyschools.us",
  "Lawrence":     "lawrence.kyschools.us",
  "Lee":          "lee.kyschools.us",
  "Leslie":       "leslie.kyschools.us",
  "Letcher":      "letcher.kyschools.us",
  "Lewis":        "lewis.kyschools.us",
  "Lincoln":      "lincoln.kyschools.us",
  "Livingston":   "livingston.kyschools.us",
  "Logan":        "logan.kyschools.us",
  "Lyon":         "lyon.kyschools.us",
  "Madison":      "www.madison.kyschools.us",
  "Magoffin":     "magoffin.kyschools.us",
  "Marion":       "www.marion.kyschools.us",
  "Marshall":     "www.marshall.kyschools.us",
  "Martin":       "martin.kyschools.us",
  "Mason":        "mason.kyschools.us",
  "McCracken":    "www.mccracken.kyschools.us",
  "McCreary":     "mccreary.kyschools.us",
  "McLean":       "mclean.kyschools.us",
  "Meade":        "meade.kyschools.us",
  "Menifee":      "menifee.kyschools.us",
  "Mercer":       "mercer.kyschools.us",
  "Metcalfe":     "metcalfe.kyschools.us",
  "Monroe":       "monroe.kyschools.us",
  "Montgomery":   "montgomery.kyschools.us",
  "Morgan":       "morgan.kyschools.us",
  "Muhlenberg":   "www.muhlenberg.kyschools.us",
  "Nelson":       "nelson.kyschools.us",
  "Nicholas":     "nicholas.kyschools.us",
  "Ohio":         "ohio.kyschools.us",
  "Oldham":       "www.oldham.kyschools.us",
  "Owen":         "owen.kyschools.us",
  "Owsley":       "owsley.kyschools.us",
  "Pendleton":    "pendleton.kyschools.us",
  "Perry":        "www.perry.kyschools.us",
  "Pike":         "www.pike.kyschools.us",
  "Powell":       "powell.kyschools.us",
  "Pulaski":      "www.pulaski.kyschools.us",
  "Robertson":    "robertson.kyschools.us",
  "Rockcastle":   "rockcastle.kyschools.us",
  "Rowan":        "www.rowan.kyschools.us",
  "Russell":      "russell.kyschools.us",
  "Scott":        "scott.kyschools.us",
  "Shelby":       "www.shelby.kyschools.us",
  "Simpson":      "simpson.kyschools.us",
  "Spencer":      "spencer.kyschools.us",
  "Taylor":       "taylor.kyschools.us",
  "Todd":         "todd.kyschools.us",
  "Trigg":        "trigg.kyschools.us",
  "Trimble":      "trimble.kyschools.us",
  "Union":        "union.kyschools.us",
  "Warren":       "www.warren.kyschools.us",
  "Washington":   "washington.kyschools.us",
  "Wayne":        "wayne.kyschools.us",
  "Webster":      "webster.kyschools.us",
  "Whitley":      "whitley.kyschools.us",
  "Wolfe":        "wolfe.kyschools.us",
  "Woodford":     "www.woodford.kyschools.us",
};

// ─── ICS Parser ───────────────────────────────────────────────────────────────

/**
 * Minimal ICS parser — handles VEVENT blocks.
 * No external dependencies needed.
 */
function parseIcs(text) {
  const events = [];
  const lines = text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    // Unfold long lines (continuation lines start with space/tab)
    .replace(/\n[ \t]/g, "")
    .split("\n");

  let current = null;

  for (const raw of lines) {
    const line = raw.trim();

    if (line === "BEGIN:VEVENT") {
      current = {};
      continue;
    }

    if (line === "END:VEVENT") {
      if (current) events.push(current);
      current = null;
      continue;
    }

    if (!current) continue;

    // Parse key:value, handling keys with params like DTSTART;TZID=...
    const colonIdx = line.indexOf(":");
    if (colonIdx < 0) continue;
    const rawKey = line.slice(0, colonIdx);
    const value = line.slice(colonIdx + 1).trim();
    const key = rawKey.split(";")[0].toUpperCase();

    switch (key) {
      case "SUMMARY":    current.title    = unescapeIcs(value); break;
      case "DESCRIPTION":current.description = unescapeIcs(value); break;
      case "DTSTART":    current.startRaw = value; current.start = parseIcsDate(value); break;
      case "DTEND":      current.endRaw   = value; current.end   = parseIcsDate(value); break;
      case "LOCATION":   current.location = unescapeIcs(value); break;
      case "URL":        current.url      = value; break;
      case "UID":        current.uid      = value; break;
      case "STATUS":     current.status   = value; break;
      case "CATEGORIES": current.categories = value.split(",").map((s) => s.trim()); break;
    }
  }

  return events;
}

function unescapeIcs(str) {
  return String(str || "")
    .replace(/\\n/g, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

function parseIcsDate(raw) {
  if (!raw) return null;
  try {
    // DATE-TIME: 20240315T090000Z or 20240315T090000
    // DATE only: 20240315
    const clean = raw.replace(/[TZ]/g, (m) => (m === "T" ? "T" : "Z")).trim();
    if (/^\d{8}$/.test(raw)) {
      // All-day: 20240315
      return new Date(`${raw.slice(0,4)}-${raw.slice(4,6)}-${raw.slice(6,8)}`).toISOString();
    }
    return new Date(clean).toISOString();
  } catch {
    return null;
  }
}

// ─── Fetch & parse ────────────────────────────────────────────────────────────

async function tryFetchIcs(domain, path) {
  const url = `https://${domain}${path}`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/calendar, */*" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("calendar") && !ct.includes("text") && !ct.includes("octet")) return null;
    const text = await res.text();
    if (!text.includes("BEGIN:VCALENDAR")) return null;
    return text;
  } catch {
    return null;
  }
}

/**
 * Fetch the ICS calendar for a county school district.
 * Tries multiple path candidates.
 */
export async function fetchDistrictCalendar(county) {
  const domain = SCHOOL_DISTRICT_DOMAINS[county];
  if (!domain) return [];

  for (const path of ICS_PATH_CANDIDATES) {
    const text = await tryFetchIcs(domain, path);
    if (text) {
      const events = parseIcs(text);
      return events.map((e) => ({ ...e, county, domain }));
    }
  }

  return [];
}

// ─── DB sync ──────────────────────────────────────────────────────────────────

/**
 * Upsert school events from all counties into school_events table.
 */
export async function syncSchoolCalendars(db, counties = null) {
  const targets = counties || Object.keys(SCHOOL_DISTRICT_DOMAINS);
  let total = 0;

  for (const county of targets) {
    try {
      const events = await fetchDistrictCalendar(county);
      for (const ev of events) {
        if (!ev.title || !ev.start) continue;
        // Skip events more than 90 days in the past
        const start = new Date(ev.start);
        if (isNaN(start.getTime())) continue;
        if (start < new Date(Date.now() - 90 * 86_400_000)) continue;

        await db.prepare(`
          INSERT INTO school_events (uid, county, title, description, start_at, end_at, location, url, fetched_at)
          VALUES (@uid, @county, @title, @description, @start, @end, @location, @url, datetime('now'))
          ON CONFLICT(uid) DO UPDATE SET
            title       = excluded.title,
            description = excluded.description,
            start_at    = excluded.start_at,
            end_at      = excluded.end_at,
            location    = excluded.location,
            fetched_at  = excluded.fetched_at
        `).run({
          uid: ev.uid || `${county}-${ev.start}-${ev.title}`.slice(0, 255),
          county,
          title: (ev.title || "").slice(0, 300),
          description: (ev.description || "").slice(0, 2000),
          start: ev.start,
          end: ev.end || null,
          location: (ev.location || "").slice(0, 300),
          url: ev.url || null,
        });
        total++;
      }
      console.log(`  📅 ${county}: ${events.length} events`);
    } catch (err) {
      console.warn(`  ⚠ Calendar sync failed for ${county}: ${err.message}`);
    }

    // Polite delay
    await new Promise((r) => setTimeout(r, 200));
  }

  console.log(`✅ School calendar sync: ${total} events upserted`);
  return total;
}

/**
 * API query: upcoming school events for a county (or all counties)
 */
export function schoolEventsQuery(counties = []) {
  if (counties.length === 0) {
    return {
      sql: `
        SELECT * FROM school_events
        WHERE start_at >= datetime('now', '-1 day')
        ORDER BY start_at ASC
        LIMIT 100
      `,
      params: {},
    };
  }

  const placeholders = counties.map((_, i) => `@c${i}`).join(", ");
  const params = {};
  counties.forEach((c, i) => { params[`c${i}`] = c; });

  return {
    sql: `
      SELECT * FROM school_events
      WHERE county IN (${placeholders})
        AND start_at >= datetime('now', '-1 day')
      ORDER BY start_at ASC
      LIMIT 100
    `,
    params,
  };
}
