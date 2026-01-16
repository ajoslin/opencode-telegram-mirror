#!/usr/bin/env bun
/**
 * OpenCode Telegram Mirror
 *
 * Polls for Telegram updates from a Cloudflare Durable Object endpoint,
 * runs opencode serve, and sends responses back.
 *
 * Usage: bun run src/main.ts [directory] [session-id]
 *
 * Environment variables:
 *   TELEGRAM_BOT_TOKEN   - Bot token for sending messages
 *   TELEGRAM_CHAT_ID     - Chat ID to operate in
 *   TELEGRAM_UPDATES_URL - URL to poll for updates (CF DO endpoint)
 */

import {
	startServer,
	connectToServer,
	stopServer,
	getServer,
	type OpenCodeServer,
} from "./opencode"
import { TelegramClient } from "./telegram"
import { loadConfig } from "./config"
import { createLogger } from "./log"
import {
	getSessionId,
	setSessionId,
	getLastUpdateId,
	setLastUpdateId,
} from "./database"
import { formatPart, type Part } from "./message-formatting"
import {
	showQuestionButtons,
	handleQuestionCallback,
	handleFreetextAnswer,
	isAwaitingFreetext,
	cancelPendingQuestion,
	type QuestionRequest,
} from "./question-handler"
import {
	showPermissionButtons,
	handlePermissionCallback,
	cancelPendingPermission,
	type PermissionRequest,
} from "./permission-handler"
import {
	uploadDiff,
	createDiffFromEdit,
	generateInlineDiffPreview,
} from "./diff-service"

const log = createLogger()

/**
 * Update the pinned status message with a new state
 * Format: -----\n**Task**: taskName\nstate\n-----
 */
async function updateStatusMessage(
  telegram: TelegramClient,
  state: string
): Promise<void> {
  const statusMessageId = process.env.STATUS_MESSAGE_ID
  const taskDescription = process.env.TASK_DESCRIPTION
  const branchName = process.env.BRANCH_NAME

  if (!statusMessageId) {
    log("debug", "No STATUS_MESSAGE_ID, skipping status update")
    return
  }

  const taskName = taskDescription || branchName || "sandbox"
  const text = `-----\n**Task**: ${taskName}\n${state}\n-----`

  const messageId = Number.parseInt(statusMessageId, 10)
  const editResult = await telegram.editMessage(messageId, text)
  const success = editResult.status === "ok" && editResult.value
  log("debug", "Status message update", { messageId, state, success })
}

interface BotState {
	server: OpenCodeServer;
	telegram: TelegramClient;
	botToken: string;
	directory: string;
	chatId: string;
	threadId: number | null;
	threadTitle: string | null;
	updatesUrl: string | null;
	botUserId: number | null;
	sessionId: string | null;

	assistantMessageIds: Set<string>;
	pendingParts: Map<string, Part[]>;
	sentPartIds: Set<string>;
}

async function main() {
	const path = await import("node:path")
	const directory = path.resolve(process.argv[2] || process.cwd())
	const sessionIdArg = process.argv[3]

	log("info", "=== Telegram Mirror Bot Starting ===")
	log("info", "Startup parameters", {
		directory,
		sessionIdArg: sessionIdArg || "(none)",
		nodeVersion: process.version,
		platform: process.platform,
		pid: process.pid,
	})

	log("info", "Loading configuration...")
	const configResult = await loadConfig(directory, log)
	if (configResult.status === "error") {
		log("error", "Configuration load failed", {
			error: configResult.error.message,
			path: configResult.error.path,
		})
		console.error("Failed to load Telegram config")
		process.exit(1)
	}

	const config = configResult.value

	log("info", "Configuration loaded", {
		hasBotToken: !!config.botToken,
		chatId: config.chatId || "(not set)",
		threadId: config.threadId ?? "(none)",
		hasUpdatesUrl: !!config.updatesUrl,
		hasSendUrl: !!config.sendUrl,
	})

	if (!config.botToken || !config.chatId) {
		log("error", "Missing required configuration", {
			hasBotToken: !!config.botToken,
			hasChatId: !!config.chatId,
		})
		console.error("Missing botToken or chatId in config")
		console.error(
			"Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID environment variables"
		)
		process.exit(1)
	}

	// Connect to OpenCode server (external URL or start our own)
	const openCodeUrl = process.env.OPENCODE_URL
	let server: OpenCodeServer

	if (openCodeUrl) {
		log("info", "Connecting to external OpenCode server...", {
			url: openCodeUrl,
		})
		const serverResult = await connectToServer(openCodeUrl, directory)
		if (serverResult.status === "error") {
			log("error", "Failed to connect to OpenCode server", {
				error: serverResult.error.message,
			})
			console.error("Failed to connect to OpenCode server")
			process.exit(1)
		}
		server = serverResult.value
		log("info", "Connected to OpenCode server", {
			baseUrl: server.baseUrl,
			directory,
		})
	} else {
		log("info", "Starting OpenCode server...")
		const serverResult = await startServer(directory)
		if (serverResult.status === "error") {
			log("error", "Failed to start OpenCode server", {
				error: serverResult.error.message,
			})
			console.error("Failed to start OpenCode server")
			process.exit(1)
		}
		server = serverResult.value
		log("info", "OpenCode server started", {
			port: server.port,
			baseUrl: server.baseUrl,
			directory,
		})
	}

	// Initialize Telegram client for sending messages
	const telegram = new TelegramClient({
		botToken: config.botToken,
		chatId: config.chatId,
		threadId: config.threadId,
		log,
		baseUrl: config.sendUrl,
	})

	// Verify bot
	log("info", "Verifying bot token...")
	const botInfoResult = await telegram.getMe()
	if (botInfoResult.status === "error") {
		log("error", "Bot verification failed - invalid token", {
			error: botInfoResult.error.message,
		})
		console.error("Invalid bot token")
		process.exit(1)
	}
	const botInfo = botInfoResult.value
	log("info", "Bot verified successfully", {
		username: botInfo.username,
		botId: botInfo.id,
	})

	// Register bot commands (menu)
	const commandsResult = await telegram.setMyCommands([
		{ command: "interrupt", description: "Stop the current operation" },
		{ command: "plan", description: "Switch to plan mode" },
		{ command: "build", description: "Switch to build mode" },
		{ command: "review", description: "Review changes [commit|branch|pr]" },
	])
	if (commandsResult.status === "error") {
		log("warn", "Failed to set bot commands", { error: commandsResult.error.message })
	}

	// Determine session ID
	log("info", "Checking for existing session...")
	let sessionId: string | null = sessionIdArg || getSessionId(log)

	if (sessionId) {
		log("info", "Found existing session ID, validating...", { sessionId })
		const sessionCheck = await server.client.session.get({
			path: { id: sessionId },
		})
		if (!sessionCheck.data) {
			log("warn", "Stored session not found on server, will create new", {
				oldSessionId: sessionId,
			})
			sessionId = null
		} else {
			log("info", "Session validated successfully", { sessionId })
		}
	} else {
		log("info", "No existing session found, will create on first message")
	}

	const state: BotState = {
		server,
		telegram,
		botToken: config.botToken,
		directory,
		chatId: config.chatId,
		threadId: config.threadId ?? null,
		threadTitle: null,
		updatesUrl: config.updatesUrl || null,
		botUserId: botInfo.id,
		sessionId,
		assistantMessageIds: new Set(),
		pendingParts: new Map(),
		sentPartIds: new Set(),
	}

	log("info", "Bot state initialized", {
		directory: state.directory,
		chatId: state.chatId,
		threadId: state.threadId ?? "(none)",
		threadTitle: state.threadTitle ?? "(unknown)",
		sessionId: state.sessionId || "(pending)",
		pollSource: state.updatesUrl ? "Cloudflare DO" : "Telegram API",
	})

	// Start polling for updates
	log("info", "Starting updates poller...")
	startUpdatesPoller(state)

	// Subscribe to OpenCode events
	log("info", "Starting event subscription...")
	subscribeToEvents(state)

	process.on("SIGINT", async () => {
		log("info", "Received SIGINT, shutting down gracefully...")
		const stopResult = await stopServer()
		if (stopResult.status === "error") {
			log("error", "Shutdown failed", { error: stopResult.error.message })
		}
		log("info", "Shutdown complete")
		process.exit(0)
	})

	process.on("SIGTERM", async () => {
		log("info", "Received SIGTERM, shutting down gracefully...")
		const stopResult = await stopServer()
		if (stopResult.status === "error") {
			log("error", "Shutdown failed", { error: stopResult.error.message })
		}
		log("info", "Shutdown complete")
		process.exit(0)
	})

	log("info", "=== Bot Startup Complete ===")
	log("info", "Bot is running", {
		sessionId: state.sessionId || "(will create on first message)",
		pollSource: state.updatesUrl ? "Cloudflare DO" : "Telegram API",
		updatesUrl: state.updatesUrl || "(using Telegram API)",
	})

	// Signal the worker that we're ready - it will update the status message with tunnel URL
	const workerWsUrl = process.env.WORKER_WS_URL
	if (workerWsUrl && state.chatId && state.threadId) {
		const workerBaseUrl = workerWsUrl
			.replace("wss://", "https://")
			.replace("ws://", "http://")
			.replace(/\/ws$/, "")
			.replace(/\/sandbox-ws$/, "")

		const readyUrl = `${workerBaseUrl}/session-ready`
		log("info", "Signaling worker that mirror is ready", { readyUrl })

		try {
			const response = await fetch(readyUrl, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					chatId: state.chatId,
					threadId: state.threadId,
				}),
			})
			log("info", "Worker ready signal response", {
				status: response.status,
				ok: response.ok,
			})
		} catch (error) {
			log("error", "Failed to signal worker", { error: String(error) })
		}
	}

	// Send initial prompt to OpenCode if context was provided
	const initialContext = process.env.INITIAL_CONTEXT
	const taskDescription = process.env.TASK_DESCRIPTION
	const branchName = process.env.BRANCH_NAME

	if (initialContext || taskDescription) {
		log("info", "Sending initial context to OpenCode", {
			hasContext: !!initialContext,
			hasTask: !!taskDescription,
			branchName,
		})

		// Build the instruction prompt
		let prompt = `You are now connected to a Telegram thread for branch "${branchName || "unknown"}".\n\n`

		if (initialContext) {
			prompt += `## Task Context\n${initialContext}\n\n`
		}

		if (taskDescription && !initialContext) {
			prompt += `## Task\n${taskDescription}\n\n`
		}

		prompt += `Read any context/description (if present). Then:
1. If a clear task or action is provided, ask any clarifying questions you need before implementing.
2. If no clear action/context is provided, ask how to proceed.

Do not start implementing until you have clarity on what needs to be done.`

		// Create session and send prompt
		try {
			const sessionResult = await state.server.client.session.create({
				body: { title: `Telegram: ${branchName || "session"}` },
			})

			if (sessionResult.data?.id) {
				state.sessionId = sessionResult.data.id
				setSessionId(sessionResult.data.id, log)
				log("info", "Created OpenCode session", { sessionId: state.sessionId })

				// Send the initial prompt
				await state.server.client.session.prompt({
					path: { id: state.sessionId },
					body: { parts: [{ type: "text", text: prompt }] },
				})
				log("info", "Sent initial prompt to OpenCode")
			}
		} catch (error) {
			log("error", "Failed to send initial context to OpenCode", {
				error: String(error),
			})
		}
	}
}

// =============================================================================
// Updates Polling (from CF DO or Telegram directly)
// =============================================================================

interface TelegramUpdate {
	update_id: number
	message?: {
		message_id: number
		message_thread_id?: number
		date?: number
		text?: string
		caption?: string
		photo?: Array<{
			file_id: string
			file_unique_id: string
			width: number
			height: number
		}>
		from?: { id: number; username?: string }
		chat: { id: number }
	}
	callback_query?: import("./telegram").CallbackQuery
}

async function startUpdatesPoller(state: BotState) {
	const pollSource = state.updatesUrl ? "Cloudflare DO" : "Telegram API"

	// Only process messages after startup time to avoid replaying history
	const startupTimestamp = process.env.STARTUP_TIMESTAMP
		? Number.parseInt(process.env.STARTUP_TIMESTAMP, 10)
		: Math.floor(Date.now() / 1000)

	log("info", "Updates poller started", {
		source: pollSource,
		chatId: state.chatId,
		threadId: state.threadId ?? "(none)",
		startupTimestamp,
		startupTime: new Date(startupTimestamp * 1000).toISOString(),
	})

	let pollCount = 0
	let totalUpdatesProcessed = 0

	while (true) {
		try {
			pollCount++
			const pollStart = Date.now()

			let updates = state.updatesUrl
				? await pollFromDO(state)
				: await pollFromTelegram(state)

			const pollDuration = Date.now() - pollStart

			// Filter out messages from before startup (they're included in initial context)
			// For callback_query updates, use the embedded message date
			const beforeFilter = updates.length
			updates = updates.filter((u) => {
				const messageDate =
					u.message?.date ?? u.callback_query?.message?.date ?? 0
				return messageDate >= startupTimestamp
			})

			if (beforeFilter > updates.length) {
				log("debug", "Filtered old messages", {
					before: beforeFilter,
					after: updates.length,
					startupTimestamp,
				})
			}

			if (updates.length > 0) {
				totalUpdatesProcessed += updates.length
				log("info", "Received updates", {
					count: updates.length,
					totalProcessed: totalUpdatesProcessed,
					pollDuration: `${pollDuration}ms`,
					updateIds: updates.map((u) => u.update_id),
				})
			} else if (state.updatesUrl) {
				// Add delay between polls when using DO (no long-polling)
				await Bun.sleep(1000)
			}

			for (const update of updates) {
				try {
					const updateType = update.message
						? "message"
						: update.callback_query
							? "callback_query"
							: "unknown"
					log("debug", "Processing update", {
						updateId: update.update_id,
						type: updateType,
						raw: JSON.stringify(update),
					})

					if (update.message) {
						await handleTelegramMessage(state, update.message)
					} else if (update.callback_query) {
						await handleTelegramCallback(state, update.callback_query)
					}

					log("debug", "Update processed successfully", {
						updateId: update.update_id,
					})
				} catch (err) {
					log("error", "Error processing update", {
						updateId: update.update_id,
						error: String(err),
					})
				}
			}
		} catch (error) {
			log("error", "Poll error, retrying in 5s", {
				pollNumber: pollCount,
				error: String(error),
			})
			await Bun.sleep(5000)
		}
	}
}

async function pollFromDO(state: BotState): Promise<TelegramUpdate[]> {
	if (!state.updatesUrl) return []

	const since = getLastUpdateId(log)
	const parsed = new URL(state.updatesUrl)
	parsed.searchParams.set("since", String(since))
	parsed.searchParams.set("chat_id", state.chatId)
	if (state.threadId !== null) {
		parsed.searchParams.set("thread_id", String(state.threadId))
	}

	const headers: Record<string, string> = {}

	if (parsed.username || parsed.password) {
		const credentials = btoa(`${parsed.username}:${parsed.password}`)
		headers.Authorization = `Basic ${credentials}`
		parsed.username = ""
		parsed.password = ""
	}

	const response = await fetch(parsed.toString(), { headers })

	if (!response.ok) {
		log("error", "DO poll failed", {
			status: response.status,
			statusText: response.statusText,
		})
		throw new Error(`DO poll failed: ${response.status}`)
	}

	const data = (await response.json()) as {
		updates?: Array<{ payload: TelegramUpdate; update_id: number }>
	}
	// DO wraps Telegram updates in { payload: {...}, update_id, chat_id, received_at }
	// Extract the actual Telegram update from payload
	const updates = (data.updates ?? []).map(
		(u) => u.payload ?? u
	) as TelegramUpdate[]

	if (updates.length > 0) {
		const lastUpdate = updates[updates.length - 1]
		log("info", "DO poll returned updates", {
			previousId: since,
			newId: lastUpdate.update_id,
			updateCount: updates.length,
			threadIds: updates.map((u) => u.message?.message_thread_id ?? "none"),
		})
		setLastUpdateId(lastUpdate.update_id, log)
	}

	return updates
}

async function pollFromTelegram(state: BotState): Promise<TelegramUpdate[]> {
	const lastUpdateId = getLastUpdateId(log)
	const baseUrl = `https://api.telegram.org/bot${state.botToken}`

	const params = new URLSearchParams({
		offset: String(lastUpdateId + 1),
		timeout: "30",
		allowed_updates: JSON.stringify(["message", "callback_query"]),
	})

	const response = await fetch(`${baseUrl}/getUpdates?${params}`)
	const data = (await response.json()) as {
		ok: boolean
		result?: TelegramUpdate[]
	}

	if (!data.ok || !data.result) {
		return []
	}

	// Filter to our chat and update last ID
	const updates: TelegramUpdate[] = []
	for (const update of data.result) {
		setLastUpdateId(update.update_id, log)

		const chatId =
			update.message?.chat.id || update.callback_query?.message?.chat.id
		if (String(chatId) === state.chatId) {
			updates.push(update)
		}
	}

	return updates
}

async function handleTelegramMessage(
	state: BotState,
	msg: NonNullable<TelegramUpdate["message"]>,
) {
	const messageText = msg.text || msg.caption
	if (!messageText && !msg.photo) return

	// Ignore all bot messages - context is sent directly via OpenCode API
	if (msg.from?.id === state.botUserId) {
		log("debug", "Ignoring bot message")
		return
	}

	if (state.threadId && msg.message_thread_id !== state.threadId) {
		log("debug", "Ignoring message from different thread", {
			msgThreadId: msg.message_thread_id,
			stateThreadId: state.threadId,
		})
		return
	}

	// Handle "x" as interrupt (like double-escape in opencode TUI)
	if (messageText?.trim().toLowerCase() === "x") {
		log("info", "Received interrupt command 'x'")
		if (state.sessionId) {
			const abortResult = await state.server.clientV2.session.abort({
				sessionID: state.sessionId,
				directory: state.directory,
			})
			if (abortResult.data) {
				await state.telegram.sendMessage("Interrupted.")
			} else {
				log("error", "Failed to abort session", {
					sessionId: state.sessionId,
					error: abortResult.error,
				})
				await state.telegram.sendMessage("Failed to interrupt the session.")
			}
		} else {
			await state.telegram.sendMessage("No active session to interrupt.")
		}
		return
	}

	if (messageText?.trim() === "/connect") {
		const publicUrl = process.env.OPENCODE_PUBLIC_URL
		if (publicUrl) {
			const sendResult = await state.telegram.sendMessage(
				`OpenCode server is ready:\n${publicUrl}`
			)
			if (sendResult.status === "error") {
				log("error", "Failed to send connect response", {
					error: sendResult.error.message,
				})
			}
		} else {
			const sendResult = await state.telegram.sendMessage(
				"OpenCode URL is not available yet."
			)
			if (sendResult.status === "error") {
				log("error", "Failed to send connect response", {
					error: sendResult.error.message,
				})
			}
		}
		return
	}

	if (messageText?.trim() === "/interrupt") {
		log("info", "Received /interrupt command")
		if (state.sessionId) {
			const abortResult = await state.server.clientV2.session.abort({
				sessionID: state.sessionId,
				directory: state.directory,
			})
			if (abortResult.data) {
				await state.telegram.sendMessage("Interrupted.")
			} else {
				log("error", "Failed to abort session", {
					sessionId: state.sessionId,
					error: abortResult.error,
				})
				await state.telegram.sendMessage("Failed to interrupt.")
			}
		} else {
			await state.telegram.sendMessage("No active session.")
		}
		return
	}

	const commandMatch = messageText?.trim().match(/^\/(build|plan|review)(?:\s+(.*))?$/)
	if (commandMatch) {
		const [, command, args] = commandMatch
		log("info", "Received command", { command, args })

		if (!state.sessionId) {
			const result = await state.server.client.session.create({
				body: { title: "Telegram" },
			})
			if (result.data) {
				state.sessionId = result.data.id
				setSessionId(result.data.id, log)
				log("info", "Created session for command", { sessionId: result.data.id })
			} else {
				log("error", "Failed to create session for command")
				await state.telegram.sendMessage("Failed to create session.")
				return
			}
		}

		state.server.clientV2.session
			.command({
				sessionID: state.sessionId,
				directory: state.directory,
				command,
				arguments: args || "",
			})
			.catch((err) => {
				log("error", "Command failed", { command, error: String(err) })
			})

		log("info", "Command sent", { command, sessionId: state.sessionId })
		return
	}

	log("info", "Received message", {
		from: msg.from?.username,
		preview: messageText?.slice(0, 50) ?? "[photo]",
	})

	// Check for freetext answer
	const threadId = state.threadId ?? 0

	if (isAwaitingFreetext(msg.chat.id, threadId) && messageText) {
		const result = await handleFreetextAnswer({
			telegram: state.telegram,
			chatId: msg.chat.id,
			threadId,
			text: messageText,
			log,
		})

		if (result) {
			await state.server.clientV2.question.reply({
				requestID: result.requestId,
				answers: result.answers,
			})
		}
		return
	}

	// Cancel pending questions/permissions
	const cancelledQ = cancelPendingQuestion(msg.chat.id, threadId)
	if (cancelledQ) {
		await state.server.clientV2.question.reject({
			requestID: cancelledQ.requestId,
		})
	}

	const cancelledP = cancelPendingPermission(msg.chat.id, threadId)
	if (cancelledP) {
		await state.server.clientV2.permission.reply({
			requestID: cancelledP.requestId,
			reply: "reject",
		})
	}

	// Create session if needed
	if (!state.sessionId) {
		const result = await state.server.client.session.create({
			body: { title: "Telegram" },
		})

		if (result.data) {
			state.sessionId = result.data.id
			setSessionId(result.data.id, log)
			log("info", "Created session", { sessionId: result.data.id })
		} else {
			log("error", "Failed to create session")
			return
		}
	}

	// Build prompt parts
	const parts: Array<
		| { type: "text"; text: string }
		| { type: "file"; mime: string; url: string; filename?: string }
	> = []

	if (msg.photo && msg.photo.length > 0) {
		const bestPhoto = msg.photo[msg.photo.length - 1]
		const dataUrlResult = await state.telegram.downloadFileAsDataUrl(
			bestPhoto.file_id,
			"image/jpeg"
		)
		if (dataUrlResult.status === "ok") {
			parts.push({
				type: "file",
				mime: "image/jpeg",
				url: dataUrlResult.value,
				filename: `photo_${bestPhoto.file_unique_id}.jpg`,
			})
		} else {
			log("error", "Failed to download photo", {
				error: dataUrlResult.error.message,
				fileId: bestPhoto.file_id,
			})
		}
	}

	if (messageText) {
		parts.push({ type: "text", text: messageText })
	}

	if (parts.length === 0) return

	// Send to OpenCode
	state.server.clientV2.session
		.prompt({
			sessionID: state.sessionId,
			directory: state.directory,
			parts,
		})
		.catch((err) => {
			log("error", "Prompt failed", { error: String(err) })
		})

	log("info", "Prompt sent", { sessionId: state.sessionId })
}

async function handleTelegramCallback(
	state: BotState,
	callback: import("./telegram").CallbackQuery,
) {
	log("info", "Received callback", { data: callback.data })

	if (
		state.threadId &&
		callback.message?.message_thread_id !== state.threadId
	) {
		return
	}

	const questionResult = await handleQuestionCallback({
		telegram: state.telegram,
		callback,
		log,
	})

	if (questionResult) {
		if ("awaitingFreetext" in questionResult) return

		await state.server.clientV2.question.reply({
			requestID: questionResult.requestId,
			answers: questionResult.answers,
		})
		return
	}

	const permResult = await handlePermissionCallback({
		telegram: state.telegram,
		callback,
		log,
	})

	if (permResult) {
		await state.server.clientV2.permission.reply({
			requestID: permResult.requestId,
			reply: permResult.reply,
		})
	}
}



// =============================================================================
// OpenCode Events
// =============================================================================

interface OpenCodeEvent {
	type: string
	properties: {
		sessionID?: string
		info?: { id: string; sessionID: string; role: string }
		part?: Part
		session?: { id: string; title?: string }
		[key: string]: unknown
	}
}

async function subscribeToEvents(state: BotState) {
	log("info", "Subscribing to OpenCode events")

	try {
		const eventsResult = await state.server.clientV2.event.subscribe(
			{ directory: state.directory },
			{}
		)

		const stream = eventsResult.stream
		if (!stream) throw new Error("No event stream")

		log("info", "Event stream connected")

		for await (const event of stream) {
			try {
				await handleOpenCodeEvent(state, event as OpenCodeEvent)
			} catch (error) {
				log("error", "Event error", { error: String(error) })
			}
		}

		log("warn", "Event stream ended")
	} catch (error) {
		log("error", "Event subscription error", { error: String(error) })
	}

	// Retry
	if (getServer()) {
		await Bun.sleep(5000)
		subscribeToEvents(state)
	}
}

async function handleOpenCodeEvent(state: BotState, ev: OpenCodeEvent) {
	const sessionId =
		ev.properties?.sessionID ??
		ev.properties?.info?.sessionID ??
		ev.properties?.part?.sessionID
	const sessionTitle = ev.properties?.session?.title

	// Log errors in full and send to Telegram
	if (ev.type === "session.error") {
		const errorMsg = JSON.stringify(ev.properties, null, 2)
		log("error", "OpenCode session error", {
			sessionId,
			error: ev.properties,
		})
		// Send error to Telegram for visibility
		const sendResult = await state.telegram.sendMessage(
			`OpenCode Error:\n${errorMsg.slice(0, 3500)}`
		)
		if (sendResult.status === "error") {
			log("error", "Failed to send session error message", {
				error: sendResult.error.message,
			})
		}
	}

	if (ev.type !== "session.updated") {
		log("debug", "OpenCode event received", {
			type: ev.type,
			eventSessionId: sessionId,
			stateSessionId: state.sessionId,
			match: sessionId === state.sessionId,
		})
	}

	if (!sessionId || sessionId !== state.sessionId) return

	if (sessionTitle && state.threadId) {
		const trimmedTitle = sessionTitle.trim()
		const shouldUpdate = trimmedTitle && trimmedTitle !== state.threadTitle
		if (shouldUpdate) {
			const renameResult = await state.telegram.editForumTopic(
				state.threadId,
				trimmedTitle
			)
			if (renameResult.status === "ok") {
				state.threadTitle = trimmedTitle
				log("info", "Updated Telegram thread title", {
					threadId: state.threadId,
					title: trimmedTitle,
				})
			} else {
				log("error", "Failed to update Telegram thread title", {
					threadId: state.threadId,
					title: trimmedTitle,
					error: renameResult.error.message,
				})
			}
		}
	}

	if (ev.type === "message.updated") {
		const info = ev.properties.info
		if (info?.role === "assistant") {
			const key = `${info.sessionID}:${info.id}`
			state.assistantMessageIds.add(key)
			log("debug", "Registered assistant message", { key })
		}
	}

	if (ev.type === "message.part.updated") {
		const part = ev.properties.part
		if (!part) return

		const key = `${part.sessionID}:${part.messageID}`
		if (!state.assistantMessageIds.has(key)) {
			log("debug", "Ignoring part - not from assistant message", {
				key,
				registeredKeys: Array.from(state.assistantMessageIds),
				partType: part.type,
			})
			return
		}

		log("debug", "Processing message part", {
			key,
			partType: part.type,
			partId: part.id,
		})

		const existing = state.pendingParts.get(key) ?? []
		const idx = existing.findIndex((p) => p.id === part.id)
		if (idx >= 0) existing[idx] = part
		else existing.push(part)
		state.pendingParts.set(key, existing)

		if (part.type !== "step-finish") {
			const typingResult = await state.telegram.sendTypingAction()
			if (typingResult.status === "error") {
				log("debug", "Typing action failed", {
					error: typingResult.error.message,
				})
			}
		}

		// Send tools/reasoning immediately (except edit/write tools - wait for completion to get diff data)
		const isEditOrWrite =
			part.type === "tool" && (part.tool === "edit" || part.tool === "write")
		if (
			(part.type === "tool" &&
				part.state?.status === "running" &&
				!isEditOrWrite) ||
			part.type === "reasoning"
		) {
			if (!state.sentPartIds.has(part.id)) {
				const formatted = formatPart(part)
				if (formatted.trim()) {
					const sendResult = await state.telegram.sendMessage(formatted)
					if (sendResult.status === "error") {
						log("error", "Failed to send formatted part", {
							error: sendResult.error.message,
						})
					}
					state.sentPartIds.add(part.id)
				}
			}
		}

		// On step-finish, send remaining parts
		if (part.type === "step-finish") {
			for (const p of existing) {
				if (p.type === "step-start" || p.type === "step-finish") continue
				if (state.sentPartIds.has(p.id)) continue

				// Handle edit tool diffs
				if (
					p.type === "tool" &&
					p.tool === "edit" &&
					p.state?.status === "completed"
				) {
					const input = p.state.input ?? {}
					const filePath = (input.filePath as string) || ""
					const oldString = (input.oldString as string) || ""
					const newString = (input.newString as string) || ""

					log("debug", "Edit tool completed", {
						filePath,
						hasOldString: !!oldString,
						hasNewString: !!newString,
						oldStringLen: oldString.length,
						newStringLen: newString.length,
						inputKeys: Object.keys(input),
					})

					if (filePath && (oldString || newString)) {
						const diffFile = createDiffFromEdit({
							filePath,
							oldString,
							newString,
						})
						log("debug", "Uploading diff", {
							filePath,
							additions: diffFile.additions,
							deletions: diffFile.deletions,
						})
						const diffResult = await uploadDiff([diffFile], {
							title: filePath.split("/").pop() || "Edit",
							log,
						})

						const diffUpload = diffResult.status === "ok" ? diffResult.value : null
						if (diffResult.status === "error") {
							log("error", "Diff upload failed", {
								error: diffResult.error.message,
							})
						}

						log("debug", "Diff upload result", {
							success: !!diffUpload,
							url: diffUpload?.viewerUrl,
						})
						const formatted = formatPart(p)
						const preview = generateInlineDiffPreview(oldString, newString, 8)
						const message = preview ? `${formatted}\n\n${preview}` : formatted

						if (diffUpload) {
							const sendResult = await state.telegram.sendMessage(message, {
								replyMarkup: {
									inline_keyboard: [
										[{ text: "View Diff", url: diffUpload.viewerUrl }],
									],
								},
							})
							if (sendResult.status === "error") {
								log("error", "Failed to send diff message", {
									error: sendResult.error.message,
								})
							}
						} else {
							const sendResult = await state.telegram.sendMessage(message)
							if (sendResult.status === "error") {
								log("error", "Failed to send diff message", {
									error: sendResult.error.message,
								})
							}
						}
						state.sentPartIds.add(p.id)
						continue
					}

					log("warn", "Edit tool missing filePath or content", {
						filePath,
						hasOld: !!oldString,
						hasNew: !!newString,
					})
				}

				const formatted = formatPart(p)
				if (formatted.trim()) {
					const sendResult = await state.telegram.sendMessage(formatted)
					if (sendResult.status === "error") {
						log("error", "Failed to send formatted part", {
							error: sendResult.error.message,
						})
					}
					state.sentPartIds.add(p.id)
				}
			}
			state.pendingParts.delete(key)
		}
	}

	const threadId = state.threadId ?? 0

	if (ev.type === "question.asked") {
		await showQuestionButtons({
			telegram: state.telegram,
			chatId: Number(state.chatId),
			threadId,
			sessionId,
			request: ev.properties as unknown as QuestionRequest,
			directory: state.directory,
			log,
		})
	}

	if (ev.type === "permission.asked") {
		await showPermissionButtons({
			telegram: state.telegram,
			chatId: Number(state.chatId),
			threadId,
			sessionId,
			request: ev.properties as unknown as PermissionRequest,
			directory: state.directory,
			log,
		})
	}
}

main().catch((error) => {
	console.error("Fatal error:", error)
	process.exit(1)
})
