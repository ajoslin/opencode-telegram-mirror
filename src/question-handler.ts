/**
 * Question handler for OpenCode question.asked events
 * Shows Telegram inline keyboard buttons for questions and collects responses
 */

import { TelegramClient, type CallbackQuery } from "./telegram"
import type { LogFn } from "./log"

// Question input schema matching OpenCode's question tool
export type QuestionInput = {
  questions: Array<{
    question: string
    header: string // max 12 chars
    options: Array<{
      label: string
      description: string
    }>
    multiple?: boolean
  }>
}

// Question request from OpenCode event
export type QuestionRequest = {
  id: string
  sessionID: string
  questions: QuestionInput["questions"]
}

type PendingQuestionContext = {
  sessionId: string
  requestId: string
  chatId: number
  threadId: number | null
  questions: QuestionInput["questions"]
  answers: Record<number, string[]> // questionIndex -> selected labels
  totalQuestions: number
  answeredCount: number
  messageIds: number[] // Track sent message IDs for cleanup
  awaitingFreetext: number | null // questionIndex awaiting freetext input, or null
  directory: string // Directory for looking up the correct OpenCode server
}

// Store pending questions by a unique key (chatId:threadId)
const pendingQuestions = new Map<string, PendingQuestionContext>()

function getThreadKey(chatId: number, threadId: number | null): string {
  return `${chatId}:${threadId ?? "main"}`
}

/**
 * Show question buttons in Telegram
 */
export async function showQuestionButtons({
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
  request: QuestionRequest
  directory: string
  log: LogFn
}): Promise<void> {
  const threadKey = getThreadKey(chatId, threadId)

  // Cancel any existing pending question for this thread
  const existing = pendingQuestions.get(threadKey)
  if (existing) {
    log("info", "Cancelling existing pending question", { threadKey })
  }

  const context: PendingQuestionContext = {
    sessionId,
    requestId: request.id,
    chatId,
    threadId,
    questions: request.questions,
    answers: {},
    totalQuestions: request.questions.length,
    answeredCount: 0,
    messageIds: [],
    awaitingFreetext: null,
    directory,
  }

  pendingQuestions.set(threadKey, context)

  // Send one message per question with inline keyboard
  for (let i = 0; i < request.questions.length; i++) {
    const q = request.questions[i]
    if (!q) continue

    const maxButtons = 100
    const maxOptions = Math.max(maxButtons - 1, 0)
    const trimmedOptions = q.options.slice(0, maxOptions)
    const includeOther = trimmedOptions.length < maxButtons
    const optionLines = trimmedOptions.map((opt, optIdx) => {
      const description = opt.description ? ` - ${opt.description}` : ""
      return `${optIdx + 1}. ${opt.label}${description}`
    })

    // Build inline keyboard - max 8 buttons per row, max 100 buttons total
    const options = [
      ...trimmedOptions.map((opt, optIdx) => ({
        label: opt.label.slice(0, 64), // Telegram button text limit
        callbackData: `q:${threadKey}:${i}:${optIdx}`,
      })),
    ]

    if (includeOther) {
      options.push({
        label: "Other",
        callbackData: `q:${threadKey}:${i}:other`,
      })
    }

    if (optionLines.length > 0 && includeOther) {
      optionLines.push(`${optionLines.length + 1}. Other`)
    }

    const keyboard = TelegramClient.buildInlineKeyboard(options, { columns: 1 })

    const messageResult = await telegram.sendMessage(
      `*${q.header}*\n${q.question}${optionLines.length > 0 ? `\n\n${optionLines.join("\n")}` : ""}`,
      { replyMarkup: keyboard }
    )

    if (messageResult.status === "error") {
      log("error", "Failed to send question message", {
        threadKey,
        error: messageResult.error.message,
      })
      continue
    }

    if (messageResult.value) {
      context.messageIds.push(messageResult.value.message_id)
    }

  }

  log("info", "Showed question buttons", {
    threadKey,
    questionCount: request.questions.length,
  })
}

/**
 * Handle callback query from question button press
 * Returns the answer data if all questions are answered, null otherwise
 * Returns { awaitingFreetext: true } if waiting for user to type custom answer
 */
export async function handleQuestionCallback({
  telegram,
  callback,
  log,
}: {
  telegram: TelegramClient
  callback: CallbackQuery
  log: LogFn
}): Promise<{ requestId: string; answers: string[][]; directory: string } | { awaitingFreetext: true } | null> {
  const data = callback.data
  if (!data?.startsWith("q:")) {
    return null
  }

  // Parse callback data: q:chatId:threadId:questionIndex:optionIndex
  const parts = data.split(":")
  log("debug", "Parsing question callback", { parts, partsLength: parts.length })
  
  if (parts.length < 5) {
    log("warn", "Invalid question callback data", { data })
    return null
  }

  const threadKey = `${parts[1]}:${parts[2]}`
  const questionIndex = Number.parseInt(parts[3] ?? "0", 10)
  const optionValue = parts[4] ?? "0"

  log("debug", "Looking up pending question", { 
    threadKey, 
    questionIndex, 
    optionValue,
    pendingKeys: Array.from(pendingQuestions.keys())
  })

  const context = pendingQuestions.get(threadKey)
  if (!context) {
    log("warn", "No pending question for threadKey", { threadKey })
    const answerResult = await telegram.answerCallbackQuery(callback.id, {
      text: "This question has expired",
      showAlert: true,
    })
    if (answerResult.status === "error") {
      log("error", "Failed to answer expired question", {
        error: answerResult.error.message,
      })
    }
    return null
  }

  const question = context.questions[questionIndex]
  if (!question) {
    log("error", "Question index not found", { questionIndex, threadKey })
    const answerResult = await telegram.answerCallbackQuery(callback.id)
    if (answerResult.status === "error") {
      log("error", "Failed to answer invalid question", {
        error: answerResult.error.message,
      })
    }
    return null
  }

  // Acknowledge the button press
  const ackResult = await telegram.answerCallbackQuery(callback.id)
  if (ackResult.status === "error") {
    log("error", "Failed to acknowledge question", {
      error: ackResult.error.message,
    })
  }

  // Handle "Other" - wait for freetext input
  if (optionValue === "other") {
    context.awaitingFreetext = questionIndex
    
    // Update the message to prompt for freetext input
    const messageId = context.messageIds[questionIndex]
    if (messageId) {
      const editResult = await telegram.editMessage(
        messageId,
        `*${question.header}*\n${question.question}\n\n_Please type your answer:_`
      )
      if (editResult.status === "error") {
        log("error", "Failed to prompt freetext answer", {
          error: editResult.error.message,
        })
      }
    }
    
    log("info", "Awaiting freetext input for question", { threadKey, questionIndex })
    return { awaitingFreetext: true }
  }

  // Record the selected option answer
  const optIdx = Number.parseInt(optionValue, 10)
  const selectedLabel = question.options[optIdx]?.label ?? `Option ${optIdx + 1}`
  context.answers[questionIndex] = [selectedLabel]
  context.answeredCount++

  // Update the message to show the selection and remove keyboard
  const messageId = context.messageIds[questionIndex]
  if (messageId) {
    const answeredText = context.answers[questionIndex]?.join(", ") ?? ""
    const editResult = await telegram.editMessage(
      messageId,
      `*${question.header}*\n${question.question}\n\n_${answeredText}_`
    )
    if (editResult.status === "error") {
      log("error", "Failed to update answered question", {
        error: editResult.error.message,
      })
    }
  }

  // Check if all questions are answered
  if (context.answeredCount >= context.totalQuestions) {
    // Build answers array
    const answers = context.questions.map((_, i) => context.answers[i] ?? [])

    pendingQuestions.delete(threadKey)

    log("info", "All questions answered", {
      threadKey,
      requestId: context.requestId,
      directory: context.directory,
    })

    return {
      requestId: context.requestId,
      answers,
      directory: context.directory,
    }
  }

  return null
}

/**
 * Check if there's a pending freetext question for a thread
 */
export function isAwaitingFreetext(chatId: number, threadId: number | null): boolean {
  const threadKey = getThreadKey(chatId, threadId)
  const context = pendingQuestions.get(threadKey)
  return context?.awaitingFreetext !== null && context?.awaitingFreetext !== undefined
}

/**
 * Handle freetext answer for "Other" option
 * Returns the answer data if all questions are answered, null otherwise
 */
export async function handleFreetextAnswer({
  telegram,
  chatId,
  threadId,
  text,
  log,
}: {
  telegram: TelegramClient
  chatId: number
  threadId: number | null
  text: string
  log: LogFn
}): Promise<{ requestId: string; answers: string[][]; directory: string } | null> {
  const threadKey = getThreadKey(chatId, threadId)
  const context = pendingQuestions.get(threadKey)

  if (!context || context.awaitingFreetext === null) {
    return null
  }

  const questionIndex = context.awaitingFreetext
  const question = context.questions[questionIndex]

  // Record the freetext answer
  context.answers[questionIndex] = [text]
  context.answeredCount++
  context.awaitingFreetext = null

  // Update the message to show the answer
  const messageId = context.messageIds[questionIndex]
  if (messageId && question) {
    const editResult = await telegram.editMessage(
      messageId,
      `*${question.header}*\n${question.question}\n\n_${text}_`
    )
    if (editResult.status === "error") {
      log("error", "Failed to update freetext answer", {
        error: editResult.error.message,
      })
    }
  }

  log("info", "Freetext answer recorded", { threadKey, questionIndex, text: text.slice(0, 50) })

  // Check if all questions are answered
  if (context.answeredCount >= context.totalQuestions) {
    // Build answers array
    const answers = context.questions.map((_, i) => context.answers[i] ?? [])

    pendingQuestions.delete(threadKey)

    log("info", "All questions answered (after freetext)", {
      threadKey,
      requestId: context.requestId,
      directory: context.directory,
    })

    return {
      requestId: context.requestId,
      answers,
      directory: context.directory,
    }
  }

  return null
}

/**
 * Cancel pending question for a thread (e.g., when user sends a new message that's not a freetext answer)
 */
export function cancelPendingQuestion(
  chatId: number,
  threadId: number | null
): { requestId: string; answers: string[][]; directory: string } | null {
  const threadKey = getThreadKey(chatId, threadId)
  const context = pendingQuestions.get(threadKey)

  if (!context) {
    return null
  }

  // Build answers with cancellation markers for unanswered questions
  const answers = context.questions.map((_, i) => {
    return context.answers[i] ?? ["(cancelled - user sent new message)"]
  })

  pendingQuestions.delete(threadKey)

  return {
    requestId: context.requestId,
    answers,
    directory: context.directory,
  }
}

/**
 * Check if there's a pending question for a thread
 */
export function hasPendingQuestion(chatId: number, threadId: number | null): boolean {
  return pendingQuestions.has(getThreadKey(chatId, threadId))
}
