/**
 * Permission handler for OpenCode permission.asked events
 * Shows Telegram inline keyboard buttons for Accept/Accept Always/Deny
 */

import { TelegramClient, type CallbackQuery } from "./telegram"
import type { LogFn } from "./log"

// Permission request from OpenCode event
export type PermissionRequest = {
  id: string
  sessionID: string
  permission: string // e.g., "bash", "edit", "webfetch"
  patterns: string[] // e.g., file paths or command patterns
}

type PendingPermissionContext = {
  sessionId: string
  requestId: string
  chatId: number
  threadId: number | null
  permission: string
  patterns: string[]
  messageId: number
  directory: string // Directory for looking up the correct OpenCode server
}

// Store pending permissions by a unique key (chatId:threadId)
const pendingPermissions = new Map<string, PendingPermissionContext>()

function getThreadKey(chatId: number, threadId: number | null): string {
  return `${chatId}:${threadId ?? "main"}`
}

/**
 * Show permission buttons in Telegram
 */
export async function showPermissionButtons({
  telegram,
  chatId,
  threadId,
  sessionId,
  request,
  directory,
  log,
}: {
  telegram: TelegramClient
  chatId: number
  threadId: number | null
  sessionId: string
  request: PermissionRequest
  directory: string
  log: LogFn
}): Promise<void> {
  const threadKey = getThreadKey(chatId, threadId)

  // Cancel any existing pending permission for this thread
  const existing = pendingPermissions.get(threadKey)
  if (existing) {
    log("info", "Replacing existing pending permission", { threadKey })
  }

  const patternStr = request.patterns.length > 0 
    ? request.patterns.join(", ") 
    : ""

  // Build message text
  let messageText = "*Permission Required*\n\n"
  messageText += `*Type:* \`${request.permission}\`\n`
  if (patternStr) {
    messageText += `*Pattern:* \`${patternStr}\``
  }

  // Build inline keyboard
  const options = [
    { label: "Accept", callbackData: `p:${threadKey}:once` },
    { label: "Accept Always", callbackData: `p:${threadKey}:always` },
    { label: "Deny", callbackData: `p:${threadKey}:reject` },
  ]

  const keyboard = TelegramClient.buildInlineKeyboard(options, { columns: 3 })

  const message = await telegram.sendMessage(messageText, { replyMarkup: keyboard })

  if (message) {
    const context: PendingPermissionContext = {
      sessionId,
      requestId: request.id,
      chatId,
      threadId,
      permission: request.permission,
      patterns: request.patterns,
      messageId: message.message_id,
      directory,
    }
    pendingPermissions.set(threadKey, context)

    log("info", "Showed permission buttons", {
      threadKey,
      permission: request.permission,
      patterns: request.patterns,
    })
  }
}

/**
 * Handle callback query from permission button press
 * Returns the reply data to send to OpenCode, including directory for server lookup
 */
export async function handlePermissionCallback({
  telegram,
  callback,
  log,
}: {
  telegram: TelegramClient
  callback: CallbackQuery
  log: LogFn
}): Promise<{ requestId: string; reply: "once" | "always" | "reject"; directory: string } | null> {
  const data = callback.data
  if (!data?.startsWith("p:")) {
    return null
  }

  // Parse callback data: p:chatId:threadId:reply
  const parts = data.split(":")
  if (parts.length < 4) {
    log("warn", "Invalid permission callback data", { data })
    return null
  }

  const threadKey = `${parts[1]}:${parts[2]}`
  const reply = parts[3] as "once" | "always" | "reject"

  const context = pendingPermissions.get(threadKey)
  if (!context) {
    await telegram.answerCallbackQuery(callback.id, {
      text: "This permission request has expired",
      showAlert: true,
    })
    return null
  }

  // Acknowledge the button press
  await telegram.answerCallbackQuery(callback.id)

  // Format result text
  const resultText = (() => {
    switch (reply) {
      case "once":
        return "Permission *accepted*"
      case "always":
        return "Permission *accepted* (auto-approve similar requests)"
      case "reject":
        return "Permission *rejected*"
    }
  })()

  // Update the message to show the result and remove keyboard
  const patternStr = context.patterns.length > 0 
    ? context.patterns.join(", ") 
    : ""

  let updatedText = "*Permission Required*\n\n"
  updatedText += `*Type:* \`${context.permission}\`\n`
  if (patternStr) {
    updatedText += `*Pattern:* \`${patternStr}\`\n\n`
  } else {
    updatedText += "\n"
  }
  updatedText += resultText

  await telegram.editMessage(context.messageId, updatedText)

  pendingPermissions.delete(threadKey)

  log("info", "Permission responded", {
    threadKey,
    requestId: context.requestId,
    reply,
    directory: context.directory,
  })

  return {
    requestId: context.requestId,
    reply,
    directory: context.directory,
  }
}

/**
 * Auto-reject pending permission for a thread (e.g., when user sends a new message)
 */
export function cancelPendingPermission(
  chatId: number,
  threadId: number | null
): { requestId: string; reply: "reject"; directory: string } | null {
  const threadKey = getThreadKey(chatId, threadId)
  const context = pendingPermissions.get(threadKey)

  if (!context) {
    return null
  }

  pendingPermissions.delete(threadKey)

  return {
    requestId: context.requestId,
    reply: "reject",
    directory: context.directory,
  }
}

/**
 * Check if there's a pending permission for a thread
 */
export function hasPendingPermission(chatId: number, threadId: number | null): boolean {
  return pendingPermissions.has(getThreadKey(chatId, threadId))
}
