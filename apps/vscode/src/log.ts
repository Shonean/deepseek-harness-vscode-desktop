import type { OutputChannel } from 'vscode'

/**
 * Process-wide log sink for the extension: one output channel ("DeepSeek
 * Harness") carrying activation, kernel subprocess, broker, tunnel, and
 * command events with ISO timestamps, so a real-host failure can be read
 * without attaching a debugger. Bound once at activation; calls before
 * binding are dropped.
 */
let channel: OutputChannel | undefined

/** Bind the singleton output channel at activation. */
export function bindLog(bound: OutputChannel): void {
  channel = bound
}

/** Append one timestamped line; a no-op before {@link bindLog}. */
export function log(message: string): void {
  channel?.appendLine(`${new Date().toISOString()} ${message}`)
}

/** Append an error line with message and stack when available. */
export function logError(message: string, error: unknown): void {
  const detail = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)
  log(`[error] ${message}: ${detail}`)
}

/** Reveal the channel in the output view. */
export function showLog(): void {
  channel?.show()
}

/** Test seam: forget the bound channel. */
export function resetLogForTests(): void {
  channel = undefined
}
