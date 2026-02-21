export function logInfo(event: string, data: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ level: "info", event, ts: new Date().toISOString(), ...data }));
}

export function logWarn(event: string, data: Record<string, unknown> = {}): void {
  console.warn(JSON.stringify({ level: "warn", event, ts: new Date().toISOString(), ...data }));
}

export function logError(event: string, err: unknown, data: Record<string, unknown> = {}): void {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  console.error(
    JSON.stringify({ level: "error", event, ts: new Date().toISOString(), message, stack, ...data })
  );
}
