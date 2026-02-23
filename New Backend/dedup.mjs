/**
 * Duplicate Detection
 *
 * Uses MinHash (approximated via multiple hash functions) to compute
 * Jaccard similarity between article titles/summaries.
 *
 * Problem: 10 outlets run the same AP/wire story with near-identical titles.
 * Solution: Hash incoming articles and compare against recent items in DB.
 *
 * Strategy:
 *  1. Normalise title → token set (lowercase, strip punctuation, remove stopwords)
 *  2. Compute a 16-hash MinHash signature
 *  3. Store signature as a compact string in items.minhash
 *  4. On ingest, compare against items from last 48h
 *  5. If Jaccard estimate ≥ 0.72 → mark as duplicate, deprioritize in feed
 *
 * Duplicates are NOT deleted — they're flagged is_duplicate=1 so the UI
 * can collapse them ("3 more sources covered this story").
 */

// ─── Stopwords (common English words that add no signal) ─────────────────────

const STOPWORDS = new Set([
  "a","an","the","and","or","but","in","on","at","to","for","of","with",
  "by","from","up","about","into","through","during","including","until",
  "against","among","throughout","despite","towards","upon","concerning",
  "is","are","was","were","be","been","being","have","has","had","do","does",
  "did","will","would","could","should","may","might","shall","can","need",
  "dare","ought","used","it","its","this","that","these","those","i","we",
  "you","he","she","they","what","which","who","whom","whose","when","where",
  "why","how","all","both","each","few","more","most","other","some","such",
  "than","then","as","if","just","over","also","after","before","while","says",
  "said","say","new","one","two","three","four","five","six","seven","eight",
  "not","no","nor","so","yet","both","either","neither","each","every","any",
]);

// ─── Normalisation ────────────────────────────────────────────────────────────

/**
 * Normalise text into a set of meaningful tokens.
 */
function tokenise(text) {
  return new Set(
    String(text || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2 && !STOPWORDS.has(t))
  );
}

// ─── MinHash ──────────────────────────────────────────────────────────────────

const NUM_HASHES = 16;
const MAX_INT = 0x7fffffff;

/**
 * Simple but fast integer hash family using FNV-1a variant.
 * Each of the NUM_HASHES functions uses a different seed.
 */
function hashToken(token, seed) {
  let h = seed ^ 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = (Math.imul(h, 0x01000193) >>> 0);
  }
  return h & MAX_INT;
}

const SEEDS = Array.from({ length: NUM_HASHES }, (_, i) => (i + 1) * 0x9e3779b9 & MAX_INT);

/**
 * Compute a MinHash signature for a token set.
 * Returns an array of NUM_HASHES integers.
 */
export function computeMinHash(tokens) {
  const sig = new Array(NUM_HASHES).fill(MAX_INT);
  for (const token of tokens) {
    for (let i = 0; i < NUM_HASHES; i++) {
      const h = hashToken(token, SEEDS[i]);
      if (h < sig[i]) sig[i] = h;
    }
  }
  return sig;
}

/**
 * Encode MinHash signature as a compact hex string for DB storage.
 */
export function encodeSignature(sig) {
  return sig.map((v) => v.toString(16).padStart(8, "0")).join("");
}

/**
 * Decode hex string back to signature array.
 */
export function decodeSignature(str) {
  const sig = [];
  for (let i = 0; i < str.length; i += 8) {
    sig.push(parseInt(str.slice(i, i + 8), 16));
  }
  return sig;
}

/**
 * Estimate Jaccard similarity from two MinHash signatures.
 * Returns a value 0.0–1.0.
 */
export function jaccardEstimate(sigA, sigB) {
  let matches = 0;
  for (let i = 0; i < sigA.length; i++) {
    if (sigA[i] === sigB[i]) matches++;
  }
  return matches / sigA.length;
}

// ─── High-level API ───────────────────────────────────────────────────────────

const DUPLICATE_THRESHOLD = 0.72; // Jaccard ≥ this → duplicate
const LOOKBACK_HOURS = 48;

/**
 * Compute the MinHash for an article.
 * Uses title + first 200 chars of summary for the signature.
 */
export function articleSignature(title, summary = "") {
  const text = `${title} ${summary.slice(0, 200)}`;
  const tokens = tokenise(text);
  const sig = computeMinHash(tokens);
  return { tokens, sig, encoded: encodeSignature(sig) };
}

/**
 * Check an incoming article against recent items in the DB.
 *
 * @param {object} db        - db-adapter instance
 * @param {string} title
 * @param {string} summary
 * @param {string} itemId    - the new item's ID (so we don't self-match)
 * @returns {{ isDuplicate: boolean, canonicalId: string|null, similarity: number }}
 */
export async function checkDuplicate(db, title, summary, itemId) {
  const { sig: incomingSig } = articleSignature(title, summary);

  // Load MinHash sigs from DB for recent items (last 48h)
  // We store them in items.minhash column
  const recent = await db.prepare(`
    SELECT id, minhash FROM items
    WHERE fetched_at >= datetime('now', '-${LOOKBACK_HOURS} hours')
      AND id != @itemId
      AND minhash IS NOT NULL
    ORDER BY published_at DESC
    LIMIT 500
  `).all({ itemId });

  let bestMatch = null;
  let bestSim = 0;

  for (const row of recent) {
    try {
      const storedSig = decodeSignature(row.minhash);
      const sim = jaccardEstimate(incomingSig, storedSig);
      if (sim > bestSim) {
        bestSim = sim;
        bestMatch = row.id;
      }
    } catch {
      // Corrupt signature — skip
    }
  }

  if (bestSim >= DUPLICATE_THRESHOLD) {
    return { isDuplicate: true, canonicalId: bestMatch, similarity: bestSim };
  }

  return { isDuplicate: false, canonicalId: null, similarity: bestSim };
}

/**
 * Store MinHash signature for a newly persisted item.
 */
export async function storeSignature(db, itemId, title, summary) {
  const { encoded } = articleSignature(title, summary);
  await db.prepare(`UPDATE items SET minhash = @minhash WHERE id = @id`)
    .run({ minhash: encoded, id: itemId });
}
