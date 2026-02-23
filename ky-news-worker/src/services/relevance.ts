type RelevanceTier = "tier1_title" | "tier2_body";
type FailureTier = "tier2_body" | "tier3_ambiguous_city";

export type KentuckyRelevanceResult = {
  relevant: boolean;
  matchedTier: RelevanceTier | null;
  failedTier: FailureTier | null;
  bodyMentions: number;
};

const AMBIGUOUS_CITY_TERMS = ["Lexington", "Louisville", "Georgetown", "Franklin", "Winchester"] as const;

const KY_CITY_REGION_TERMS = [
  "Lexington",
  "Louisville",
  "Frankfort",
  "Bowling Green",
  "Owensboro",
  "Covington",
  "Pikeville",
  "Paducah",
  "Ashland",
  "Elizabethtown",
  "Hopkinsville",
  "Richmond",
  "Florence",
  "Georgetown",
  "Nicholasville",
  "Jeffersontown",
  "Radcliff",
  "Madisonville",
  "Winchester",
  "Erlanger",
  "Franklin",
  "Eastern Kentucky",
  "Western Kentucky",
  "Central Kentucky",
  "Appalachian Kentucky"
] as const;

const EXPLICIT_KY_TERMS = ["Kentucky", "KY"] as const;

const AMBIGUOUS_SET = new Set<string>(AMBIGUOUS_CITY_TERMS.map((term) => term.toLowerCase()));
const NON_AMBIGUOUS_TERMS = KY_CITY_REGION_TERMS.filter((term) => !AMBIGUOUS_SET.has(term.toLowerCase()));

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function termPattern(term: string): string {
  return `\\b${escapeRegex(term).replace(/\s+/g, "\\s+")}\\b`;
}

function combinedRegex(terms: readonly string[]): RegExp | null {
  if (!terms.length) return null;
  const sorted = [...terms].sort((a, b) => b.length - a.length);
  return new RegExp(`(?:${sorted.map(termPattern).join("|")})`, "gi");
}

const TITLE_EXPLICIT_KY_RE = combinedRegex(EXPLICIT_KY_TERMS) as RegExp;
const TITLE_NON_AMBIGUOUS_RE = combinedRegex(NON_AMBIGUOUS_TERMS) as RegExp;
const TITLE_AMBIGUOUS_RE = combinedRegex(AMBIGUOUS_CITY_TERMS) as RegExp;
const BODY_BASE_TERMS_RE = combinedRegex([...EXPLICIT_KY_TERMS, ...NON_AMBIGUOUS_TERMS]) as RegExp;
const BODY_WITH_AMBIGUOUS_TERMS_RE = combinedRegex([
  ...EXPLICIT_KY_TERMS,
  ...NON_AMBIGUOUS_TERMS,
  ...AMBIGUOUS_CITY_TERMS
]) as RegExp;
const ANY_AMBIGUOUS_RE = combinedRegex(AMBIGUOUS_CITY_TERMS) as RegExp;

function hasMatch(input: string, re: RegExp): boolean {
  re.lastIndex = 0;
  return re.test(input);
}

function countMentions(input: string, re: RegExp): number {
  re.lastIndex = 0;
  const matches = input.match(re);
  return matches ? matches.length : 0;
}

export function isKentuckyRelevant(title: string, bodyText: string): KentuckyRelevanceResult {
  const titleText = String(title || "");
  const body = String(bodyText || "");
  const articleText = `${titleText}\n${body}`;

  const hasArticleKySignal = hasMatch(articleText, TITLE_EXPLICIT_KY_RE);
  const titleHasExplicitKy = hasMatch(titleText, TITLE_EXPLICIT_KY_RE);
  const titleHasUnambiguousTerm = hasMatch(titleText, TITLE_NON_AMBIGUOUS_RE);
  const titleHasAmbiguousTerm = hasMatch(titleText, TITLE_AMBIGUOUS_RE);

  const titleStrongMatch =
    titleHasExplicitKy ||
    titleHasUnambiguousTerm ||
    (titleHasAmbiguousTerm && hasArticleKySignal);

  if (titleStrongMatch) {
    return {
      relevant: true,
      matchedTier: "tier1_title",
      failedTier: null,
      bodyMentions: 0
    };
  }

  const bodyMentions = countMentions(
    body,
    hasArticleKySignal ? BODY_WITH_AMBIGUOUS_TERMS_RE : BODY_BASE_TERMS_RE
  );

  if (bodyMentions >= 2) {
    return {
      relevant: true,
      matchedTier: "tier2_body",
      failedTier: null,
      bodyMentions
    };
  }

  const hasAmbiguousWithoutKy = !hasArticleKySignal && hasMatch(articleText, ANY_AMBIGUOUS_RE);

  return {
    relevant: false,
    matchedTier: null,
    failedTier: hasAmbiguousWithoutKy ? "tier3_ambiguous_city" : "tier2_body",
    bodyMentions
  };
}
