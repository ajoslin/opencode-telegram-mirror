/**
 * OpenCode server process manager.
 * Spawns and maintains a single OpenCode API server.
 */

import { spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import {
  createOpencodeClient,
  type OpencodeClient,
  type Config,
} from "@opencode-ai/sdk"
import {
  createOpencodeClient as createOpencodeClientV2,
  type OpencodeClient as OpencodeClientV2,
} from "@opencode-ai/sdk/v2"
import { createLogger } from "./log"

const log = createLogger()

export interface OpenCodeServer {
  process: ChildProcess
  client: OpencodeClient
  clientV2: OpencodeClientV2
  port: number
  directory: string
}

let server: OpenCodeServer | null = null

async function getOpenPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, () => {
      const address = srv.address()
      if (address && typeof address === "object") {
        const port = address.port
        srv.close(() => resolve(port))
      } else {
        reject(new Error("Failed to get port"))
      }
    })
    srv.on("error", reject)
  })
}

async function waitForServer(port: number, maxAttempts = 30): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/session`, {
        signal: AbortSignal.timeout(2000),
      })
      if (response.status < 500) {
        return true
      }
    } catch {
      // Keep trying
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error(`Server did not start on port ${port} after ${maxAttempts} seconds`)
}

export async function startServer(directory: string): Promise<OpenCodeServer> {
  // Reuse existing server if running
  if (server && !server.process.killed) {
    log("info", "Reusing existing server", { directory, port: server.port })
    return server
  }

  // Verify directory exists
  try {
    fs.accessSync(directory, fs.constants.R_OK | fs.constants.X_OK)
  } catch {
    throw new Error(`Directory not accessible: ${directory}`)
  }

  const envPort = process.env.OPENCODE_PORT
  const parsedPort = envPort ? Number(envPort) : null
  const port = parsedPort && !Number.isNaN(parsedPort) ? parsedPort : await getOpenPort()
  const opencodePath = process.env.OPENCODE_PATH || `${process.env.HOME}/.opencode/bin/opencode`

  log("info", "Starting opencode serve", { directory, port })

  const serverProcess = spawn(opencodePath, ["serve", "--port", port.toString()], {
    stdio: "pipe",
    detached: false,
    cwd: directory,
    env: {
      ...process.env,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        lsp: false,
        formatter: false,
        permission: {
          edit: "allow",
          bash: "allow",
          webfetch: "allow",
        },
      } satisfies Config),
    },
  })

  serverProcess.stdout?.on("data", (data) => {
    log("debug", "opencode stdout", { data: data.toString().trim().slice(0, 200) })
  })

  serverProcess.stderr?.on("data", (data) => {
    log("debug", "opencode stderr", { data: data.toString().trim().slice(0, 200) })
  })

  serverProcess.on("error", (error) => {
    log("error", "Server process error", { directory, error: String(error) })
  })

  serverProcess.on("exit", (code) => {
    log("info", "Server exited", { directory, code })
    server = null

    if (code !== 0) {
      log("info", "Restarting server", { directory })
      startServer(directory).catch((e) => {
        log("error", "Failed to restart server", { error: String(e) })
      })
    }
  })

  await waitForServer(port)
  log("info", "Server ready", { directory, port })

  const baseUrl = `http://127.0.0.1:${port}`
  const fetchWithTimeout = (request: Request) =>
    fetch(request, {
      // @ts-ignore - bun supports timeout
      timeout: false,
    })

  const client = createOpencodeClient({
    baseUrl,
    fetch: fetchWithTimeout,
  })

  const clientV2 = createOpencodeClientV2({
    baseUrl,
    fetch: fetchWithTimeout as typeof fetch,
  })

  server = {
    process: serverProcess,
    client,
    clientV2,
    port,
    directory,
  }

  return server
}

export function getServer(): OpenCodeServer | null {
  return server
}

export async function stopServer(): Promise<void> {
  if (server) {
    server.process.kill()
    log("info", "Server stopped", { directory: server.directory })
    server = null
  }
}
