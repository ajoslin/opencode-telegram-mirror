/**
 * Diff service for uploading diffs to the diff viewer
 */

import type { LogFn } from "./log"

// Configure via environment variable - optional, if not set diff uploads are disabled
const DIFF_VIEWER_URL = process.env.DIFF_VIEWER_URL || null

export interface DiffFile {
  path: string
  oldContent: string
  newContent: string
  additions: number
  deletions: number
}

export interface DiffUploadResult {
  id: string
  url: string
  viewerUrl: string // URL for the mini-app viewer
}

/**
 * Count additions and deletions between two strings
 */
function countChanges(oldContent: string, newContent: string): { additions: number; deletions: number } {
  const oldLines = oldContent.split("\n")
  const newLines = newContent.split("\n")
  
  // Simple line-based diff counting
  const oldSet = new Set(oldLines)
  const newSet = new Set(newLines)
  
  let additions = 0
  let deletions = 0
  
  for (const line of newLines) {
    if (!oldSet.has(line)) additions++
  }
  
  for (const line of oldLines) {
    if (!newSet.has(line)) deletions++
  }
  
  return { additions, deletions }
}

/**
 * Upload a diff to the diff viewer service
 */
export async function uploadDiff(
  files: DiffFile[],
  options?: { title?: string; log?: LogFn }
): Promise<DiffUploadResult | null> {
  const log = options?.log ?? (() => {})
  
  // If DIFF_VIEWER_URL is not configured, skip diff upload
  if (!DIFF_VIEWER_URL) {
    log("debug", "Diff upload skipped - DIFF_VIEWER_URL not configured")
    return null
  }
  
  try {
    log("debug", "Uploading diff", { fileCount: files.length, url: DIFF_VIEWER_URL })
    
    const response = await fetch(`${DIFF_VIEWER_URL}/api/diff`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: options?.title,
        files,
      }),
    })
    
    if (!response.ok) {
      log("error", "Failed to upload diff", { status: response.status })
      return null
    }
    
    const data = await response.json() as { id: string; url: string }
    
    log("info", "Diff uploaded", { id: data.id, url: data.url })
    
    return {
      id: data.id,
      url: data.url,
      viewerUrl: `${DIFF_VIEWER_URL}/diff/${data.id}`,
    }
  } catch (error) {
    log("error", "Error uploading diff", { error: String(error) })
    return null
  }
}

/**
 * Create a diff file from edit tool input
 */
export function createDiffFromEdit(input: {
  filePath: string
  oldString: string
  newString: string
}): DiffFile {
  const { additions, deletions } = countChanges(input.oldString, input.newString)
  
  return {
    path: input.filePath,
    oldContent: input.oldString,
    newContent: input.newString,
    additions,
    deletions,
  }
}

/**
 * Generate inline diff preview (truncated for Telegram message)
 */
export function generateInlineDiffPreview(
  oldContent: string,
  newContent: string,
  maxLines = 10
): string {
  const oldLines = oldContent.split("\n")
  const newLines = newContent.split("\n")
  
  const diffLines: string[] = []
  let lineCount = 0
  
  // Find removed lines
  for (const line of oldLines) {
    if (!newLines.includes(line) && line.trim()) {
      diffLines.push(`-${line}`)
      lineCount++
      if (lineCount >= maxLines) break
    }
  }
  
  // Find added lines  
  if (lineCount < maxLines) {
    for (const line of newLines) {
      if (!oldLines.includes(line) && line.trim()) {
        diffLines.push(`+${line}`)
        lineCount++
        if (lineCount >= maxLines) break
      }
    }
  }
  
  if (diffLines.length === 0) {
    return ""
  }
  
  return `\`\`\`diff\n${diffLines.join("\n")}\n\`\`\``
}

export { DIFF_VIEWER_URL }
