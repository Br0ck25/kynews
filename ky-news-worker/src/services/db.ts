export async function d1All<T = Record<string, unknown>>(
  db: D1Database,
  sql: string,
  binds: unknown[] = []
): Promise<T[]> {
  const res = await db.prepare(sql).bind(...binds).all<T>();
  return (res.results || []) as T[];
}

export async function d1First<T = Record<string, unknown>>(
  db: D1Database,
  sql: string,
  binds: unknown[] = []
): Promise<T | null> {
  const row = await db.prepare(sql).bind(...binds).first<T>();
  return row || null;
}

export async function d1Run(db: D1Database, sql: string, binds: unknown[] = []): Promise<D1Result> {
  return db.prepare(sql).bind(...binds).run();
}

export async function d1ExecMany(db: D1Database, statements: Array<{ sql: string; binds?: unknown[] }>): Promise<void> {
  if (!statements.length) return;
  await db.batch(statements.map((s) => db.prepare(s.sql).bind(...(s.binds || []))));
}

export async function tableHasColumn(db: D1Database, table: string, column: string): Promise<boolean> {
  const rows = await d1All<{ name: string }>(db, `PRAGMA table_info(${table})`);
  return rows.some((r) => r.name === column);
}
