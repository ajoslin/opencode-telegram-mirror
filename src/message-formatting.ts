/**
 * Message formatting for OpenCode parts
 * Matches kimaki's Discord formatting style
 */

import type { Part } from "@opencode-ai/sdk/v2"

/**
 * Escapes Telegram markdown special characters
 */
function escapeMarkdown(text: string): string {
  return text.replace(/([*_`\[\]])/g, "\\$1")
}

/**
 * Get tool summary text (file names, patterns, etc.)
 */
function getToolSummaryText(part: Part): string {
  if (part.type !== "tool") return ""

  const input = part.state.input ?? {}

  if (part.tool === "edit") {
    const filePath = (input.filePath as string) || ""
    const newString = (input.newString as string) || ""
    const oldString = (input.oldString as string) || ""
    const added = newString.split("\n").length
    const removed = oldString.split("\n").length
    const fileName = filePath.split("/").pop() || ""
    return fileName ? `*${escapeMarkdown(fileName)}* (+${added}-${removed})` : `(+${added}-${removed})`
  }

  if (part.tool === "write") {
    const filePath = (input.filePath as string) || ""
    const content = (input.content as string) || ""
    const lines = content.split("\n").length
    const fileName = filePath.split("/").pop() || ""
    return fileName ? `*${escapeMarkdown(fileName)}* (${lines} line${lines === 1 ? "" : "s"})` : `(${lines} line${lines === 1 ? "" : "s"})`
  }

  if (part.tool === "webfetch") {
    const url = (input.url as string) || ""
    const urlWithoutProtocol = url.replace(/^https?:\/\//, "")
    return urlWithoutProtocol ? `*${escapeMarkdown(urlWithoutProtocol)}*` : ""
  }

  if (part.tool === "read") {
    const filePath = (input.filePath as string) || ""
    const fileName = filePath.split("/").pop() || ""
    return fileName ? `*${escapeMarkdown(fileName)}*` : ""
  }

  if (part.tool === "glob") {
    const pattern = (input.pattern as string) || ""
    return pattern ? `*${escapeMarkdown(pattern)}*` : ""
  }

  if (part.tool === "grep") {
    const pattern = (input.pattern as string) || ""
    return pattern ? `*${escapeMarkdown(pattern)}*` : ""
  }

  if (part.tool === "bash" || part.tool === "todoread" || part.tool === "todowrite") {
    return ""
  }

  if (part.tool === "task") {
    const description = (input.description as string) || ""
    return description ? `_${escapeMarkdown(description)}_` : ""
  }

  return ""
}

/**
 * Format todo list from todowrite tool
 */
function formatTodoList(part: Part): string {
  if (part.type !== "tool" || part.tool !== "todowrite") return ""
  
  const todos = (part.state.input?.todos as Array<{
    content: string
    status: "pending" | "in_progress" | "completed" | "cancelled"
  }>) ?? []
  
  const activeIndex = todos.findIndex((todo) => todo.status === "in_progress")
  const activeTodo = todos[activeIndex]
  
  if (activeIndex === -1 || !activeTodo) return ""
  
  const num = `${activeIndex + 1}.`
  const content = activeTodo.content.charAt(0).toLowerCase() + activeTodo.content.slice(1)
  
  return `${num} *${escapeMarkdown(content)}*`
}

/**
 * Format a single part for Telegram display
 * Matches kimaki's formatting style
 */
export function formatPart(part: Part): string {
  if (part.type === "text") {
    if (!part.text?.trim()) return ""
    return part.text
  }

  if (part.type === "reasoning") {
    if (!part.text?.trim()) return ""
    return "> thinking"
  }

  if (part.type === "file") {
    return `[file] ${part.filename || "File"}`
  }

  if (part.type === "step-start" || part.type === "step-finish" || part.type === "patch") {
    return ""
  }

  if (part.type === "agent") {
    return `> agent ${part.id}`
  }

  if (part.type === "tool") {
    if (part.tool === "todowrite") {
      return formatTodoList(part)
    }

    // Question tool is handled via buttons, not text
    if (part.tool === "question") {
      return ""
    }

    if (part.state.status === "pending") {
      return ""
    }

    const summaryText = getToolSummaryText(part)
    const stateTitle = "title" in part.state ? part.state.title : undefined

    let toolTitle = ""
    if (part.state.status === "error") {
      toolTitle = part.state.error || "error"
    } else if (part.tool === "bash") {
      const command = (part.state.input?.command as string) || ""
      const description = (part.state.input?.description as string) || ""
      const isSingleLine = !command.includes("\n")
      if (isSingleLine && command.length <= 50) {
        toolTitle = `_${escapeMarkdown(command)}_`
      } else if (description) {
        toolTitle = `_${escapeMarkdown(description)}_`
      } else if (stateTitle) {
        toolTitle = `_${escapeMarkdown(stateTitle as string)}_`
      }
    } else if (stateTitle) {
      toolTitle = `_${escapeMarkdown(stateTitle as string)}_`
    }

    const icon = (() => {
      if (part.state.status === "error") return "X"
      if (part.tool === "edit" || part.tool === "write") return ">"
      return ">"
    })()
    
    return `${icon} ${part.tool} ${toolTitle} ${summaryText}`.trim()
  }

  return ""
}

export type { Part }
