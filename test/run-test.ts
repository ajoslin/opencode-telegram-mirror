#!/usr/bin/env bun
/**
 * Test runner that starts the mock server and the bot together.
 * 
 * Usage:
 *   bun run test/run-test.ts [fixture-file] [timeout-seconds]
 */

import { spawn, type Subprocess } from "bun"
import { setTimeout } from "node:timers/promises"
import { unlink } from "node:fs/promises"

const MOCK_PORT = 3456
const fixtureFile = process.argv[2] || "test/fixtures/sample-updates.json"
const timeoutSeconds = Number(process.argv[3]) || 30

let mockServer: Subprocess | null = null
let botProcess: Subprocess | null = null

async function waitForServer(url: string, maxAttempts = 20): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const response = await fetch(url)
      if (response.ok) return true
    } catch {
      await setTimeout(250)
    }
  }
  return false
}

async function startMockServer(): Promise<Subprocess> {
  console.log("[test] Starting mock server...")
  
  const proc = spawn({
    cmd: ["bun", "run", "test/mock-server.ts", fixtureFile],
    env: {
      ...process.env,
      MOCK_PORT: String(MOCK_PORT),
    },
    stdout: "inherit",
    stderr: "inherit",
  })
  
  const ready = await waitForServer(`http://localhost:${MOCK_PORT}/_control`)
  if (!ready) {
    throw new Error("Mock server failed to start")
  }
  
  console.log("[test] Mock server ready")
  return proc
}

async function startBot(): Promise<Subprocess> {
  console.log("[test] Starting bot...")
  
  // Use a startup timestamp before fixture dates to ensure updates pass the filter
  // Fixtures use dates around 1768590000 (Jan 2026)
  const startupTimestamp = "1768589000"
  const testDbPath = "/tmp/telegram-opencode-test.db"
  
  const proc = spawn({
    cmd: ["bun", "run", "src/main.ts", "."],
    env: {
      ...process.env,
      TELEGRAM_UPDATES_URL: `http://localhost:${MOCK_PORT}/updates`,
      TELEGRAM_SEND_URL: `http://localhost:${MOCK_PORT}`,
      TELEGRAM_BOT_TOKEN: "test:token",
      TELEGRAM_CHAT_ID: "-1003546563617",
      TELEGRAM_DB_PATH: testDbPath,
      OPENCODE_URL: process.env.OPENCODE_URL || "",
      STARTUP_TIMESTAMP: startupTimestamp,
    },
    stdout: "inherit",
    stderr: "inherit",
  })
  
  console.log("[test] Bot started")
  return proc
}

async function getCapturedRequests(): Promise<unknown[]> {
  const response = await fetch(`http://localhost:${MOCK_PORT}/_control?action=captured`)
  const data = await response.json() as { requests: unknown[] }
  return data.requests
}

async function getServerStatus(): Promise<unknown> {
  const response = await fetch(`http://localhost:${MOCK_PORT}/_control?action=status`)
  return response.json()
}

function cleanup() {
  console.log("\n[test] Cleaning up...")
  
  if (botProcess) {
    botProcess.kill()
    botProcess = null
  }
  
  if (mockServer) {
    mockServer.kill()
    mockServer = null
  }
}

process.on("SIGINT", () => {
  cleanup()
  process.exit(0)
})

process.on("SIGTERM", () => {
  cleanup()
  process.exit(0)
})

async function main() {
  console.log("[test] === Test Runner Starting ===")
  console.log(`[test] Fixture: ${fixtureFile}`)
  console.log(`[test] Timeout: ${timeoutSeconds}s`)
  console.log("")
  
  try {
    await unlink("/tmp/telegram-opencode-test.db").catch(() => {})
    mockServer = await startMockServer()
    
    await setTimeout(500)
    
    botProcess = await startBot()
    
    console.log(`[test] Running for ${timeoutSeconds} seconds...`)
    console.log("[test] Press Ctrl+C to stop early")
    console.log("")
    
    await setTimeout(timeoutSeconds * 1000)
    
    console.log("\n[test] === Test Complete ===")
    
    const status = await getServerStatus()
    console.log("[test] Server status:", JSON.stringify(status, null, 2))
    
    const captured = await getCapturedRequests()
    console.log(`[test] Captured ${captured.length} Telegram API requests`)
    
    if (captured.length > 0) {
      console.log("[test] Sample requests:")
      for (const req of captured.slice(0, 5)) {
        console.log("  -", JSON.stringify(req).slice(0, 150))
      }
    }
    
  } catch (error) {
    console.error("[test] Error:", error)
    process.exitCode = 1
  } finally {
    cleanup()
  }
}

main()
