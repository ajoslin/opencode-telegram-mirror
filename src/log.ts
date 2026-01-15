/**
 * Stdout logging for the Telegram plugin
 */

export type LogFn = (
  level: "debug" | "info" | "warn" | "error",
  message: string,
  extra?: Record<string, unknown>
) => void

export function createLogger(): LogFn {
  return (level, message, extra) => {
    const timestamp = new Date().toISOString()
    const extraStr = extra ? ` ${JSON.stringify(extra)}` : ""
    const line = `${timestamp} [${level}] ${message}${extraStr}`

    if (level === "error" || level === "warn") {
      console.error(line)
    } else {
      console.log(line)
    }
  }
}
