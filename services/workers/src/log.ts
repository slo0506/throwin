type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

/** One JSON object per line, which Railway indexes. */
export function createLogger(min: Level = "info"): Logger {
  const emit =
    (level: Level) =>
    (msg: string, fields: Record<string, unknown> = {}) => {
      if (ORDER[level] < ORDER[min]) return;
      const line = JSON.stringify({ level, time: new Date().toISOString(), msg, ...fields });
      if (level === "error" || level === "warn") console.error(line);
      else console.log(line);
    };
  return { debug: emit("debug"), info: emit("info"), warn: emit("warn"), error: emit("error") };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
