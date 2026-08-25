/** Minimal levelled logger. Writes to stderr so CLI stdout stays pipeable. */

type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = ORDER[(process.env.LOG_LEVEL as Level) ?? 'info'] ?? ORDER.info;

const buffer: string[] = [];

function emit(level: Level, scope: string, message: string, extra?: unknown): void {
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}`;
  buffer.push(line);
  if (buffer.length > 500) buffer.shift();
  if (ORDER[level] < threshold) return;
  if (extra !== undefined) process.stderr.write(`${line} ${safe(extra)}\n`);
  else process.stderr.write(`${line}\n`);
}

function safe(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function createLogger(scope: string) {
  return {
    debug: (m: string, e?: unknown) => emit('debug', scope, m, e),
    info: (m: string, e?: unknown) => emit('info', scope, m, e),
    warn: (m: string, e?: unknown) => emit('warn', scope, m, e),
    error: (m: string, e?: unknown) => emit('error', scope, m, e),
  };
}

/** Recent log lines, used to persist a readable log with each research run. */
export function recentLog(limit = 200): string {
  return buffer.slice(-limit).join('\n');
}
