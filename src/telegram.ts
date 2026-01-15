/**
 * Telegram Bot API client for sending/receiving messages
 */

import type { LogFn } from "./log"

export interface TelegramConfig {
  botToken: string
  chatId: string // Channel, group, or DM chat ID
  threadId?: number // Optional thread/topic ID for forum groups
  log?: LogFn // Optional logger function
}

export interface TelegramPhotoSize {
  file_id: string
  file_unique_id: string
  width: number
  height: number
  file_size?: number
}

export interface TelegramMessage {
  message_id: number
  from?: {
    id: number
    first_name: string
    username?: string
    is_bot?: boolean
  }
  chat: {
    id: number
    type: string
  }
  message_thread_id?: number
  date: number
  text?: string
  caption?: string
  photo?: TelegramPhotoSize[]
  reply_to_message?: TelegramMessage
}

export interface CallbackQuery {
  id: string
  from: {
    id: number
    first_name: string
    username?: string
  }
  message?: TelegramMessage
  data?: string // Callback data from inline button
}

export interface TelegramUpdate {
  update_id: number
  message?: TelegramMessage
  callback_query?: CallbackQuery
}

interface GetUpdatesResponse {
  ok: boolean
  result: TelegramUpdate[]
  error_code?: number
  description?: string
}

interface SendMessageResponse {
  ok: boolean
  result: TelegramMessage
  error_code?: number
  description?: string
}

// Custom error for fatal Telegram errors (chat not found, etc.)
export class TelegramFatalError extends Error {
  constructor(
    message: string,
    public code: number
  ) {
    super(message)
    this.name = "TelegramFatalError"
  }
}

export interface InlineKeyboardButton {
  text: string
  callback_data?: string
  url?: string
  web_app?: { url: string }
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][]
}

export class TelegramClient {
  private baseUrl: string
  private chatId: string
  private threadId?: number
  private lastUpdateId = 0
  private log: LogFn

  constructor(config: TelegramConfig) {
    this.baseUrl = `https://api.telegram.org/bot${config.botToken}`
    this.chatId = config.chatId
    this.threadId = config.threadId
    // Default to no-op logger if none provided
    this.log = config.log ?? (() => {})
  }

  /**
   * Send a message to the configured chat/thread
   */
  async sendMessage(
    text: string,
    options?: {
      replyMarkup?: InlineKeyboardMarkup
      replyToMessageId?: number
    }
  ): Promise<TelegramMessage | null> {
    // Telegram has a 4096 character limit per message
    const maxLength = 4096
    const chunks = this.splitMessage(text, maxLength)

    this.log("debug", "Preparing to send message", {
      textLength: text.length,
      chunks: chunks.length,
      chatId: this.chatId,
      threadId: this.threadId,
      hasReplyMarkup: !!options?.replyMarkup,
    })

    let lastMessage: TelegramMessage | null = null

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]
      const isLastChunk = i === chunks.length - 1

      const params: Record<string, unknown> = {
        chat_id: this.chatId,
        text: chunk,
        parse_mode: "Markdown",
      }

      if (this.threadId) {
        params.message_thread_id = this.threadId
      }

      if (options?.replyToMessageId) {
        params.reply_to_message_id = options.replyToMessageId
      }

      // Only add reply markup to the last chunk
      if (isLastChunk && options?.replyMarkup) {
        params.reply_markup = options.replyMarkup
      }

      this.log("debug", "Sending chunk to Telegram API", {
        chunkIndex: i,
        chunkLength: chunk.length,
        isLastChunk,
      })

      try {
        const response = await fetch(`${this.baseUrl}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(params),
        })

        const data = (await response.json()) as SendMessageResponse

        this.log("debug", "Telegram API response", {
          ok: data.ok,
          messageId: data.result?.message_id,
        })

        if (!data.ok) {
          // Check for fatal errors (chat not found, etc.)
          if (data.error_code === 400 && data.description?.includes("chat not found")) {
            this.log("error", "Chat not found - stopping", { chatId: this.chatId, response: data })
            throw new TelegramFatalError(`Chat not found: ${this.chatId}`, 400)
          }
          
          this.log("warn", "Markdown failed, retrying without parse_mode", { response: data, text: chunk })
          // Retry without markdown if it fails (markdown can be finicky)
          params.parse_mode = undefined
          const retryResponse = await fetch(`${this.baseUrl}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(params),
          })
          const retryData = (await retryResponse.json()) as SendMessageResponse
          if (retryData.ok) {
            lastMessage = retryData.result
            this.log("info", "Message sent successfully (plain text)", { messageId: retryData.result.message_id })
          } else {
            // Check for fatal errors on retry too
            if (retryData.error_code === 400 && retryData.description?.includes("chat not found")) {
              this.log("error", "Chat not found - stopping", { chatId: this.chatId, response: retryData })
              throw new TelegramFatalError(`Chat not found: ${this.chatId}`, 400)
            }
            this.log("error", "Failed to send message", { response: retryData })
          }
        } else {
          lastMessage = data.result
          this.log("info", "Message sent successfully", { messageId: data.result.message_id })
        }
      } catch (error) {
        this.log("error", "Error sending message", { error: String(error) })
      }
    }

    return lastMessage
  }

  /**
   * Edit an existing message's text and/or reply markup
   */
  async editMessage(
    messageId: number,
    text: string,
    options?: { replyMarkup?: InlineKeyboardMarkup }
  ): Promise<boolean> {
    this.log("debug", "Editing message", { messageId, textLength: text.length })

    const params: Record<string, unknown> = {
      chat_id: this.chatId,
      message_id: messageId,
      text,
      parse_mode: "Markdown",
    }

    if (options?.replyMarkup) {
      params.reply_markup = options.replyMarkup
    }

    try {
      const response = await fetch(`${this.baseUrl}/editMessageText`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      })

      const data = (await response.json()) as { ok: boolean }

      if (!data.ok) {
        this.log("warn", "Edit with markdown failed, retrying plain", { messageId })
        // Retry without markdown
        params.parse_mode = undefined
        const retryResponse = await fetch(`${this.baseUrl}/editMessageText`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(params),
        })
        const retryData = (await retryResponse.json()) as { ok: boolean }
        this.log("debug", "Edit retry result", { messageId, ok: retryData.ok })
        return retryData.ok
      }

      this.log("debug", "Message edited successfully", { messageId })
      return true
    } catch (error) {
      this.log("error", "Error editing message", { messageId, error: String(error) })
      return false
    }
  }

  /**
   * Answer a callback query (acknowledge button press)
   */
  async answerCallbackQuery(
    callbackQueryId: string,
    options?: { text?: string; showAlert?: boolean }
  ): Promise<boolean> {
    this.log("debug", "Answering callback query", { callbackQueryId, text: options?.text })

    const params: Record<string, unknown> = {
      callback_query_id: callbackQueryId,
    }

    if (options?.text) {
      params.text = options.text
    }
    if (options?.showAlert) {
      params.show_alert = options.showAlert
    }

    try {
      const response = await fetch(`${this.baseUrl}/answerCallbackQuery`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      })

      const data = (await response.json()) as { ok: boolean }
      this.log("debug", "Callback query answered", { ok: data.ok })
      return data.ok
    } catch (error) {
      this.log("error", "Error answering callback query", { error: String(error) })
      return false
    }
  }

  /**
   * Get new updates (messages and callback queries) using long polling
   */
  async getUpdates(timeout = 30): Promise<TelegramUpdate[]> {
    try {
      const params = new URLSearchParams({
        offset: String(this.lastUpdateId + 1),
        timeout: String(timeout),
        allowed_updates: JSON.stringify(["message", "callback_query"]),
      })

      const response = await fetch(`${this.baseUrl}/getUpdates?${params}`)
      const data = (await response.json()) as GetUpdatesResponse

      if (!data.ok) {
        this.log("error", "Failed to get updates from Telegram API", { response: data })
        
        // Throw fatal errors so caller can handle them
        if (data.error_code === 409) {
          throw new TelegramFatalError(data.description || "Conflict", 409)
        }
        if (data.error_code === 401) {
          throw new TelegramFatalError(data.description || "Unauthorized", 401)
        }
        
        return []
      }

      const updates: TelegramUpdate[] = []

      for (const update of data.result) {
        this.lastUpdateId = update.update_id

        // Filter messages to our target chat/thread
        if (update.message) {
          const msg = update.message
          const chatMatches = String(msg.chat.id) === this.chatId
          const threadMatches = this.threadId
            ? msg.message_thread_id === this.threadId
            : true

          if (chatMatches && threadMatches) {
            updates.push(update)
            this.log("info", "Message matched filter", {
              updateId: update.update_id,
              from: msg.from?.username || msg.from?.first_name,
              preview: msg.text?.slice(0, 50),
            })
          }
        }

        // Include callback queries from our chat
        if (update.callback_query?.message) {
          const chatMatches =
            String(update.callback_query.message.chat.id) === this.chatId

          this.log("debug", "Processing callback query", {
            updateId: update.update_id,
            callbackData: update.callback_query.data,
            chatMatches,
          })

          if (chatMatches) {
            updates.push(update)
            this.log("info", "Callback query matched", {
              updateId: update.update_id,
              data: update.callback_query.data,
            })
          }
        }
      }

      this.log("debug", "Polling complete", {
        totalReceived: data.result.length,
        matchedUpdates: updates.length,
      })

      return updates
    } catch (error) {
      this.log("error", "Error getting updates", { error: String(error) })
      return []
    }
  }

  /**
   * Split a long message into chunks that fit Telegram's limit
   */
  private splitMessage(text: string, maxLength: number): string[] {
    if (text.length <= maxLength) {
      return [text]
    }

    const chunks: string[] = []
    let remaining = text

    while (remaining.length > 0) {
      if (remaining.length <= maxLength) {
        chunks.push(remaining)
        break
      }

      // Try to split at a newline
      let splitIndex = remaining.lastIndexOf("\n", maxLength)
      if (splitIndex === -1 || splitIndex < maxLength / 2) {
        // Try to split at a space
        splitIndex = remaining.lastIndexOf(" ", maxLength)
      }
      if (splitIndex === -1 || splitIndex < maxLength / 2) {
        // Force split at maxLength
        splitIndex = maxLength
      }

      chunks.push(remaining.slice(0, splitIndex))
      remaining = remaining.slice(splitIndex).trimStart()
    }

    return chunks
  }

  /**
   * Send typing indicator to show the bot is working
   * Returns a stop function to cancel the typing indicator
   */
  startTyping(intervalMs = 4000): () => void {
    // Send immediately
    this.sendTypingAction()

    // Telegram typing indicator lasts ~5 seconds, so refresh every 4 seconds
    const interval = setInterval(() => {
      this.sendTypingAction()
    }, intervalMs)

    return () => {
      clearInterval(interval)
    }
  }

  /**
   * Send a single typing action
   */
  async sendTypingAction(): Promise<void> {
    const params: Record<string, unknown> = {
      chat_id: this.chatId,
      action: "typing",
    }

    if (this.threadId) {
      params.message_thread_id = this.threadId
    }

    try {
      await fetch(`${this.baseUrl}/sendChatAction`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      })
    } catch (error) {
      this.log("debug", "Failed to send typing action", { error: String(error) })
    }
  }

  /**
   * Get bot info to verify the token is valid
   */
  async getMe(): Promise<{ ok: boolean; result?: { id: number; username: string } }> {
    try {
      const response = await fetch(`${this.baseUrl}/getMe`)
      return (await response.json()) as { ok: boolean; result?: { id: number; username: string } }
    } catch (error) {
      return { ok: false }
    }
  }

  /**
   * Get a file's download URL from Telegram
   * @param fileId The file_id from a photo/document/etc
   * @returns The file URL, or null on failure
   */
  async getFileUrl(fileId: string): Promise<string | null> {
    this.log("debug", "Getting file info", { fileId })

    try {
      const response = await fetch(`${this.baseUrl}/getFile?file_id=${encodeURIComponent(fileId)}`)
      const data = (await response.json()) as {
        ok: boolean
        result?: { file_id: string; file_unique_id: string; file_size?: number; file_path?: string }
        description?: string
      }

      if (!data.ok || !data.result?.file_path) {
        this.log("error", "Failed to get file info", { response: data })
        return null
      }

      // Construct the download URL
      // Format: https://api.telegram.org/file/bot<token>/<file_path>
      const downloadUrl = `${this.baseUrl.replace("/bot", "/file/bot")}/${data.result.file_path}`
      this.log("debug", "Got file URL", { fileId, filePath: data.result.file_path })
      return downloadUrl
    } catch (error) {
      this.log("error", "Error getting file URL", { fileId, error: String(error) })
      return null
    }
  }

  /**
   * Download a file from Telegram and return it as a base64 data URL
   * @param fileId The file_id from a photo/document/etc
   * @param mimeType The MIME type for the data URL (e.g., "image/jpeg")
   * @returns The base64 data URL, or null on failure
   */
  async downloadFileAsDataUrl(fileId: string, mimeType: string): Promise<string | null> {
    const fileUrl = await this.getFileUrl(fileId)
    if (!fileUrl) return null

    try {
      this.log("debug", "Downloading file", { fileUrl })
      const response = await fetch(fileUrl)
      if (!response.ok) {
        this.log("error", "Failed to download file", { status: response.status })
        return null
      }

      const buffer = await response.arrayBuffer()
      const base64 = Buffer.from(buffer).toString("base64")
      const dataUrl = `data:${mimeType};base64,${base64}`
      this.log("debug", "File downloaded", { size: buffer.byteLength })
      return dataUrl
    } catch (error) {
      this.log("error", "Error downloading file", { error: String(error) })
      return null
    }
  }

  /**
   * Build inline keyboard from options
   */
  static buildInlineKeyboard(
    options: Array<{ label: string; callbackData: string }>,
    options2?: { columns?: number; addOther?: boolean; otherCallbackData?: string }
  ): InlineKeyboardMarkup {
    const columns = options2?.columns ?? 2
    const keyboard: InlineKeyboardButton[][] = []
    let currentRow: InlineKeyboardButton[] = []

    for (const opt of options) {
      currentRow.push({
        text: opt.label,
        callback_data: opt.callbackData,
      })

      if (currentRow.length >= columns) {
        keyboard.push(currentRow)
        currentRow = []
      }
    }

    // Add remaining buttons
    if (currentRow.length > 0) {
      keyboard.push(currentRow)
    }

    // Add "Other" button for freetext input
    if (options2?.addOther) {
      keyboard.push([
        {
          text: "Other (type reply)",
          callback_data: options2.otherCallbackData ?? "other",
        },
      ])
    }

    return { inline_keyboard: keyboard }
  }
}
