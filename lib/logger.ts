/**
 * Tiny stderr logger, disabled unless `PI_OCPOOL_DEBUG=1`.
 *
 * Extensions run inside the TUI, so anything written to stdout would corrupt
 * the interface. All output goes to stderr, prefixed for easy grepping.
 */
export interface Logger {
  debug(message: string): void;
}

export const silentLogger: Logger = { debug: () => {} };

export function createLogger(
  enabled: boolean,
  sink: (chunk: string) => void = (chunk) => process.stderr.write(chunk),
): Logger {
  if (!enabled) return silentLogger;
  return {
    debug(message: string): void {
      sink(`[pi-opencode-session-pool] ${message}\n`);
    },
  };
}
