/**
 * Bot configuration loading
 */

import { readFile } from "node:fs/promises"
import { join } from "node:path"
import type { LogFn } from "./log"

export interface BotConfig {
  botToken?: string
  chatId?: string
  threadId?: number
  // URL to poll for updates (Cloudflare DO endpoint)
  updatesUrl?: string
  // URL to send messages (defaults to Telegram API if not set)
  sendUrl?: string
}

export async function loadConfig(directory: string, log?: LogFn): Promise<BotConfig> {
  const config: BotConfig = {}
  const homeDir = process.env.HOME || process.env.USERPROFILE || ""

  const configPaths = [
    join(homeDir, ".config", "opencode", "telegram.json"),
    join(directory, ".opencode", "telegram.json"),
  ]

  log?.("debug", "Checking config file paths", { paths: configPaths })

  for (const configPath of configPaths) {
    try {
      const content = await readFile(configPath, "utf-8")
      const fileConfig = JSON.parse(content) as BotConfig
      Object.assign(config, fileConfig)
      log?.("info", "Loaded config file", { 
        path: configPath,
        keys: Object.keys(fileConfig),
      })
    } catch (error) {
      log?.("debug", "Config file not found or invalid", { 
        path: configPath,
        error: String(error).slice(0, 100),
      })
    }
  }

  // Environment variables override file config
  const envOverrides: string[] = []
  
  if (process.env.TELEGRAM_BOT_TOKEN) {
    config.botToken = process.env.TELEGRAM_BOT_TOKEN
    envOverrides.push("TELEGRAM_BOT_TOKEN")
  }
  if (process.env.TELEGRAM_CHAT_ID) {
    config.chatId = process.env.TELEGRAM_CHAT_ID
    envOverrides.push("TELEGRAM_CHAT_ID")
  }
  if (process.env.TELEGRAM_THREAD_ID) {
    const parsed = Number(process.env.TELEGRAM_THREAD_ID)
    if (!Number.isNaN(parsed)) {
      config.threadId = parsed
      envOverrides.push("TELEGRAM_THREAD_ID")
    }
  }
  if (process.env.TELEGRAM_UPDATES_URL) {
    config.updatesUrl = process.env.TELEGRAM_UPDATES_URL
    envOverrides.push("TELEGRAM_UPDATES_URL")
  }
  if (process.env.TELEGRAM_SEND_URL) {
    config.sendUrl = process.env.TELEGRAM_SEND_URL
    envOverrides.push("TELEGRAM_SEND_URL")
  }

  if (envOverrides.length > 0) {
    log?.("info", "Environment variable overrides applied", { variables: envOverrides })
  }

  return config
}
