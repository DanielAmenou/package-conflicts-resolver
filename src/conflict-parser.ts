/**
 * Git conflict parser for package.json files
 */

import {ConflictMarker} from "./types.js"

export type ConflictSide = "ours" | "theirs" | "base"

export class ConflictParser {
  // Labels after the markers are optional and CRLF line endings are tolerated.
  private static readonly CONFLICT_START = /^<{7}(?:\s.*)?$/
  private static readonly CONFLICT_BASE = /^\|{7}(?:\s.*)?$/
  private static readonly CONFLICT_MIDDLE = /^={7}\s*$/
  private static readonly CONFLICT_END = /^>{7}(?:\s.*)?$/

  /**
   * Strip a trailing carriage return so markers are detected in CRLF files.
   */
  private static markerText(line: string): string {
    return line.endsWith("\r") ? line.slice(0, -1) : line
  }

  /**
   * Parse Git conflict markers in a file content.
   * Supports both the default "merge" style and the "diff3"/"zdiff3" styles
   * (which include a `|||||||` base section).
   */
  static parseConflicts(content: string): ConflictMarker[] {
    const lines = content.split("\n")
    const conflicts: ConflictMarker[] = []
    let currentConflict: Partial<ConflictMarker> | null = null
    let baseMarkerSeen = false
    let oursLines: string[] = []
    let baseLines: string[] = []
    let theirsLines: string[] = []

    const reset = () => {
      currentConflict = null
      baseMarkerSeen = false
      oursLines = []
      baseLines = []
      theirsLines = []
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (line === undefined) continue
      const marker = this.markerText(line)

      if (this.CONFLICT_START.test(marker)) {
        // Start of conflict (a stray/nested start marker restarts parsing)
        reset()
        currentConflict = {start: i}
      } else if (this.CONFLICT_BASE.test(marker) && currentConflict && currentConflict.middle === undefined) {
        // Start of diff3-style base section
        baseMarkerSeen = true
      } else if (this.CONFLICT_MIDDLE.test(marker) && currentConflict) {
        // Middle of conflict
        currentConflict.middle = i
      } else if (this.CONFLICT_END.test(marker) && currentConflict && currentConflict.middle !== undefined) {
        // End of conflict
        currentConflict.end = i
        currentConflict.ours = oursLines.join("\n")
        currentConflict.theirs = theirsLines.join("\n")
        if (baseMarkerSeen) {
          currentConflict.base = baseLines.join("\n")
        }

        conflicts.push(currentConflict as ConflictMarker)
        reset()
      } else if (currentConflict) {
        // Content within conflict (empty lines are preserved)
        if (currentConflict.middle !== undefined) {
          theirsLines.push(line)
        } else if (baseMarkerSeen) {
          baseLines.push(line)
        } else {
          oursLines.push(line)
        }
      }
    }

    return conflicts
  }

  /**
   * Check if content has Git conflict markers
   */
  static hasConflicts(content: string): boolean {
    return this.parseConflicts(content).length > 0
  }

  /**
   * Check if any parsed conflict carries a diff3-style base section
   */
  static hasBaseSections(content: string): boolean {
    return this.parseConflicts(content).some(conflict => conflict.base !== undefined)
  }

  /**
   * Remove conflict markers and return clean content with resolved sections
   */
  static removeConflictMarkers(content: string, resolvedSections: Map<number, string>): string {
    const lines = content.split("\n")
    const conflicts = this.parseConflicts(content)
    const result: string[] = []
    let lastProcessedLine = 0

    for (const conflict of conflicts) {
      // Add lines before conflict
      for (let i = lastProcessedLine; i < conflict.start; i++) {
        const line = lines[i]
        if (line !== undefined) {
          result.push(line)
        }
      }

      // Add resolved content for this conflict
      const resolvedContent = resolvedSections.get(conflict.start)
      if (resolvedContent !== undefined) {
        if (resolvedContent.trim()) {
          result.push(...resolvedContent.split("\n"))
        }
      }

      lastProcessedLine = conflict.end + 1
    }

    // Add remaining lines after last conflict
    for (let i = lastProcessedLine; i < lines.length; i++) {
      const line = lines[i]
      if (line !== undefined) {
        result.push(line)
      }
    }

    return result.join("\n")
  }

  /**
   * Build a clean document variant by selecting one side of every conflict.
   * For "base", conflicts without a base section fall back to "ours".
   */
  static extractConflictSide(content: string, side: ConflictSide): string {
    const lines = content.split("\n")
    const conflicts = this.parseConflicts(content)
    const result: string[] = []
    let lastProcessedLine = 0

    for (const conflict of conflicts) {
      for (let i = lastProcessedLine; i < conflict.start; i++) {
        const line = lines[i]
        if (line !== undefined) {
          result.push(line)
        }
      }

      let selectedContent: string
      if (side === "ours") {
        selectedContent = conflict.ours
      } else if (side === "theirs") {
        selectedContent = conflict.theirs
      } else {
        selectedContent = conflict.base !== undefined ? conflict.base : conflict.ours
      }

      if (selectedContent.trim()) {
        result.push(...selectedContent.split("\n"))
      }

      lastProcessedLine = conflict.end + 1
    }

    for (let i = lastProcessedLine; i < lines.length; i++) {
      const line = lines[i]
      if (line !== undefined) {
        result.push(line)
      }
    }

    return result.join("\n")
  }

  /**
   * Extract field name from conflict content (for package.json)
   * This looks for the parent field that contains the conflict
   */
  static extractFieldName(conflictContent: string, fullContent: string, conflictStart: number): string | undefined {
    // First, try to extract from the conflict content itself
    const lines_conflict = conflictContent.trim().split("\n")
    for (const line of lines_conflict) {
      const match = line.match(/^\s*"([^"]+)"\s*:/)
      if (match) {
        const fieldName = match[1]
        // If it looks like a dependency (contains @, /, or common package patterns)
        // But exclude common package.json fields
        const packageJsonFields = [
          "name",
          "version",
          "description",
          "main",
          "scripts",
          "dependencies",
          "devDependencies",
          "peerDependencies",
          "optionalDependencies",
          "author",
          "license",
          "keywords",
          "repository",
          "bugs",
          "homepage",
        ]
        if (
          fieldName &&
          !packageJsonFields.includes(fieldName) &&
          (fieldName.includes("@") || fieldName.includes("/") || fieldName.match(/^[a-z][a-z0-9-]*$/))
        ) {
          return "dependencies" // Assume it's a dependency
        }
        return fieldName
      }
    }

    // If not found in conflict content, look backwards from conflict start to find the parent field
    const lines = fullContent.split("\n")
    let braceDepth = 0
    for (let i = conflictStart - 1; i >= 0; i--) {
      const line = lines[i]
      if (!line) continue

      // Count braces to understand nesting
      const openBraces = (line.match(/\{/g) || []).length
      const closeBraces = (line.match(/\}/g) || []).length
      braceDepth += closeBraces - openBraces

      // Look for field declarations like "dependencies": { or "node_modules/package": {
      const fieldMatch = line.match(/^\s*"([^"]+)"\s*:\s*\{?\s*$/)
      if (fieldMatch && braceDepth <= 0) {
        return fieldMatch[1]
      }

      // If we've gone up too many levels, stop
      if (braceDepth > 2) {
        break
      }
    }

    return undefined
  }

  /**
   * Validate that conflict content is valid JSON
   */
  static isValidJson(content: string): boolean {
    try {
      JSON.parse(content)
      return true
    } catch {
      return false
    }
  }

  /**
   * Parse partial JSON from conflict section
   */
  static parsePartialJson(content: string): any {
    const trimmed = content.trim()

    // Try to parse as complete JSON first
    if (this.isValidJson(trimmed)) {
      return JSON.parse(trimmed)
    }

    // Try to parse as object property (with or without a trailing comma)
    const withoutTrailingComma = trimmed.replace(/,\s*$/, "")
    try {
      const wrapped = `{${withoutTrailingComma}}`
      return JSON.parse(wrapped)
    } catch {
      // If still fails, try to extract key-value pairs
      const lines = trimmed.split("\n")
      const result: Record<string, any> = {}

      for (const line of lines) {
        const match = line.match(/^\s*"([^"]+)"\s*:\s*(.+?),?\s*$/)
        if (match && match[1] && match[2]) {
          try {
            result[match[1]] = JSON.parse(match[2].replace(/,$/, ""))
          } catch {
            result[match[1]] = match[2].replace(/[",]/g, "").trim()
          }
        }
      }

      return result
    }
  }
}
