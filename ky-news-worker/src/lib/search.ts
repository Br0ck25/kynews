export function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, "\\$&");
}

type ParsedToken =
  | { kind: "op"; op: "AND" | "OR" }
  | { kind: "term"; value: string; negated: boolean };

type ParsedGroup = {
  include: string[];
  exclude: string[];
};

export function parseSearchQuery(input: unknown): ParsedGroup[] {
  const q = String(input || "");
  const tokens: ParsedToken[] = [];
  let i = 0;

  while (i < q.length) {
    while (i < q.length && /\s/.test(q[i])) i += 1;
    if (i >= q.length) break;

    let negated = false;
    if (q[i] === "-") {
      negated = true;
      i += 1;
      while (i < q.length && /\s/.test(q[i])) i += 1;
    }
    if (i >= q.length) break;

    let value = "";
    let quoted = false;

    if (q[i] === '"') {
      quoted = true;
      i += 1;
      const start = i;
      while (i < q.length && q[i] !== '"') i += 1;
      value = q.slice(start, i);
      if (i < q.length && q[i] === '"') i += 1;
    } else {
      const start = i;
      while (i < q.length && !/\s/.test(q[i])) i += 1;
      value = q.slice(start, i);
    }

    value = value.trim();
    if (!value) continue;

    if (!quoted && !negated) {
      const upper = value.toUpperCase();
      if (upper === "AND" || upper === "OR") {
        tokens.push({ kind: "op", op: upper });
        continue;
      }
    }

    tokens.push({ kind: "term", value, negated });
  }

  const groups: ParsedGroup[] = [{ include: [], exclude: [] }];

  for (const token of tokens) {
    const current = groups[groups.length - 1];
    if (token.kind === "op") {
      if (token.op === "OR") {
        if (current.include.length || current.exclude.length) groups.push({ include: [], exclude: [] });
      }
      continue;
    }

    if (token.negated) current.exclude.push(token.value);
    else current.include.push(token.value);
  }

  return groups.filter((g) => g.include.length || g.exclude.length);
}

export function buildSearchClause(rawQuery: unknown): { clause: string; binds: string[] } {
  const searchableDoc = "LOWER(COALESCE(i.title, '') || ' ' || COALESCE(i.summary, '') || ' ' || COALESCE(i.content, ''))";
  const groups = parseSearchQuery(rawQuery);
  if (!groups.length) return { clause: "1=0", binds: [] };

  const binds: string[] = [];
  const orBlocks: string[] = [];

  for (const group of groups) {
    const andParts: string[] = [];

    for (const term of group.include) {
      andParts.push(`${searchableDoc} LIKE ? ESCAPE '\\'`);
      binds.push(`%${escapeLike(term.toLowerCase())}%`);
    }

    for (const term of group.exclude) {
      andParts.push(`${searchableDoc} NOT LIKE ? ESCAPE '\\'`);
      binds.push(`%${escapeLike(term.toLowerCase())}%`);
    }

    if (andParts.length) {
      orBlocks.push(`(${andParts.join(" AND ")})`);
    }
  }

  if (!orBlocks.length) return { clause: "1=0", binds: [] };
  return { clause: `(${orBlocks.join(" OR ")})`, binds };
}
