#!/usr/bin/env bun
/**
 * Mock server for testing the Telegram mirror bot.
 * 
 * Serves two endpoints:
 * 1. /updates - Mock updates endpoint (replaces Cloudflare DO)
 * 2. /* - Mock Telegram Bot API (captures all sends)
 * 
 * Usage:
 *   bun run test/mock-server.ts [fixture-file]
 * 
 * Environment:
 *   MOCK_PORT - Port to listen on (default: 3456)
 */

import { readFile } from "node:fs/promises"
import { join } from "node:path"

interface TelegramUpdate {
  update_id: number
  chat_id?: string
  payload: {
    update_id: number
    message?: {
      message_id: number
      chat: { id: number }
      text?: string
      date?: number
      from?: { id: number; username?: string }
      message_thread_id?: number
    }
    callback_query?: {
      id: string
      data?: string
      message?: { chat: { id: number }; message_id: number }
    }
  }
  received_at?: number
}

interface CapturedRequest {
  timestamp: number
  method: string
  path: string
  body: unknown
}

const PORT = Number(process.env.MOCK_PORT) || 3456
const fixtureFile = process.argv[2] || "test/fixtures/sample-updates.json"

let updates: TelegramUpdate[] = []
let updateIndex = 0
let lastServedUpdateId = 0
const capturedRequests: CapturedRequest[] = []
let messageIdCounter = 1000

async function loadFixtures() {
  try {
    const content = await readFile(fixtureFile, "utf-8")
    updates = JSON.parse(content) as TelegramUpdate[]
    updates.sort((a, b) => a.update_id - b.update_id)
    console.log(`[mock] Loaded ${updates.length} updates from ${fixtureFile}`)
  } catch (error) {
    console.error(`[mock] Failed to load fixtures: ${error}`)
    updates = []
  }
}

function getNextUpdates(since: number, limit = 10): TelegramUpdate[] {
  const filtered = updates.filter(u => u.update_id > since)
  const batch = filtered.slice(0, limit)
  
  if (batch.length > 0) {
    lastServedUpdateId = batch[batch.length - 1].update_id
    console.log(`[mock] Serving ${batch.length} updates (since=${since}, max=${lastServedUpdateId})`)
  }
  
  return batch
}

function handleUpdatesEndpoint(url: URL): Response {
  const since = Number(url.searchParams.get("since") || "0")
  const chatId = url.searchParams.get("chat_id")
  
  let batch = getNextUpdates(since)
  
  if (chatId) {
    batch = batch.filter(u => u.chat_id === chatId || String(u.payload.message?.chat?.id) === chatId)
  }
  
  return Response.json({
    updates: batch.map(u => ({ payload: u.payload })),
  })
}

function handleTelegramApi(path: string, body: unknown): Response {
  const method = path.split("/").pop() || ""
  
  capturedRequests.push({
    timestamp: Date.now(),
    method,
    path,
    body,
  })
  
  console.log(`[mock] Captured Telegram API: ${method}`, JSON.stringify(body).slice(0, 200))
  
  switch (method) {
    case "getMe":
      return Response.json({
        ok: true,
        result: {
          id: 123456789,
          is_bot: true,
          first_name: "TestBot",
          username: "test_bot",
        },
      })
    
    case "sendMessage":
      return Response.json({
        ok: true,
        result: {
          message_id: ++messageIdCounter,
          chat: { id: (body as { chat_id?: string })?.chat_id || "-1" },
          date: Math.floor(Date.now() / 1000),
          text: (body as { text?: string })?.text || "",
        },
      })
    
    case "editMessageText":
      return Response.json({ ok: true, result: true })
    
    case "editForumTopic":
      return Response.json({ ok: true, result: true })
    
    case "answerCallbackQuery":
      return Response.json({ ok: true, result: true })
    
    case "sendChatAction":
      return Response.json({ ok: true, result: true })
    
    case "setMyCommands":
      console.log("[mock] Commands registered:", JSON.stringify((body as { commands?: unknown[] })?.commands))
      return Response.json({ ok: true, result: true })
    
    case "getFile":
      return Response.json({
        ok: true,
        result: {
          file_id: "test_file",
          file_path: "photos/test.jpg",
        },
      })
    
    default:
      console.log(`[mock] Unknown Telegram method: ${method}`)
      return Response.json({ ok: true, result: {} })
  }
}

function handleControlEndpoint(url: URL): Response {
  const action = url.searchParams.get("action")
  
  switch (action) {
    case "captured":
      return Response.json({ requests: capturedRequests })
    
    case "clear":
      capturedRequests.length = 0
      return Response.json({ ok: true })
    
    case "reset":
      updateIndex = 0
      lastServedUpdateId = 0
      capturedRequests.length = 0
      return Response.json({ ok: true })
    
    case "inject":
      return new Response("Use POST to inject updates", { status: 400 })
    
    case "status":
      return Response.json({
        totalUpdates: updates.length,
        lastServedUpdateId,
        capturedRequests: capturedRequests.length,
      })
    
    default:
      return Response.json({
        endpoints: {
          "/updates?since=N": "Get updates (mock DO endpoint)",
          "/_control?action=captured": "Get captured Telegram API requests",
          "/_control?action=clear": "Clear captured requests",
          "/_control?action=reset": "Reset update pointer and captured requests",
          "/_control?action=status": "Get server status",
          "POST /_control?action=inject": "Inject a new update",
          "/sendMessage, /editMessageText, etc": "Mock Telegram Bot API",
        },
      })
  }
}

async function handleControlPost(url: URL, body: unknown): Promise<Response> {
  const action = url.searchParams.get("action")
  
  if (action === "inject") {
    const update = body as TelegramUpdate
    if (!update.update_id || !update.payload) {
      return Response.json({ error: "Invalid update format" }, { status: 400 })
    }
    updates.push(update)
    updates.sort((a, b) => a.update_id - b.update_id)
    console.log(`[mock] Injected update ${update.update_id}`)
    return Response.json({ ok: true, totalUpdates: updates.length })
  }
  
  return Response.json({ error: "Unknown action" }, { status: 400 })
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url)
    const path = url.pathname
    
    if (path === "/updates") {
      return handleUpdatesEndpoint(url)
    }
    
    if (path === "/_control") {
      if (req.method === "POST") {
        const body = await req.json()
        return handleControlPost(url, body)
      }
      return handleControlEndpoint(url)
    }
    
    if (req.method === "POST") {
      try {
        const body = await req.json()
        return handleTelegramApi(path, body)
      } catch {
        return handleTelegramApi(path, {})
      }
    }
    
    if (req.method === "GET" && path.includes("/getMe")) {
      return handleTelegramApi(path, {})
    }
    
    if (req.method === "GET" && path.includes("/getFile")) {
      return handleTelegramApi(path, {})
    }
    
    return new Response("Not found", { status: 404 })
  },
})

loadFixtures().then(() => {
  console.log(`[mock] Mock server running at http://localhost:${PORT}`)
  console.log(`[mock] Updates endpoint: http://localhost:${PORT}/updates`)
  console.log(`[mock] Control endpoint: http://localhost:${PORT}/_control`)
  console.log(`[mock] Telegram API base: http://localhost:${PORT}`)
  console.log("")
  console.log("[mock] Environment variables for the bot:")
  console.log(`  TELEGRAM_UPDATES_URL=http://localhost:${PORT}/updates`)
  console.log(`  TELEGRAM_SEND_URL=http://localhost:${PORT}`)
  console.log("  TELEGRAM_BOT_TOKEN=test:token")
  console.log("  TELEGRAM_CHAT_ID=-1003546563617")
})
