const NAMED_HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: "\"",
  apos: "'",
  nbsp: " ",
  ndash: "-",
  mdash: "-",
  hellip: "...",
  rsquo: "'",
  lsquo: "'",
  rdquo: "\"",
  ldquo: "\""
};

function decodeNumericEntity(raw: string): string | null {
  const value = raw.trim().toLowerCase();
  const isHex = value.startsWith("x");
  const num = Number.parseInt(isHex ? value.slice(1) : value, isHex ? 16 : 10);
  if (!Number.isFinite(num) || num <= 0 || num > 0x10ffff) return null;
  try {
    return String.fromCodePoint(num);
  } catch {
    return null;
  }
}

export function decodeHtmlEntities(input: string): string {
  if (!input) return "";
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]{2,16});/g, (match, inner) => {
    const key = String(inner || "");
    if (!key) return match;
    if (key.startsWith("#")) {
      const decoded = decodeNumericEntity(key.slice(1));
      return decoded ?? match;
    }
    const named = NAMED_HTML_ENTITIES[key.toLowerCase()];
    return named ?? match;
  });
}

export function normalizeWhitespace(input: string): string {
  return String(input || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function toHttpsUrl(input: string | null | undefined): string | null {
  const raw = String(input || "").trim();
  if (!raw) return null;
  if (raw.startsWith("//")) return `https:${raw}`;

  try {
    const url = new URL(raw);
    if (url.protocol === "http:") url.protocol = "https:";
    if (url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}
