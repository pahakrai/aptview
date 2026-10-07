/**
 * structured-log.ts — emit structured JSON events to stdout for containerized
 * log collection (Fluent Bit / Loki / Promtail). One JSON object per line.
 */

export function logEvent(event: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level: 'info',
    event,
    ...fields,
  });
  process.stdout.write(line + '\n');
}
