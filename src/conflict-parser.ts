/**
 * Git conflict parser for package.json files
 */

import {ConflictMarker} from "./types.js"

export class ConflictParser {
  private static readonly CONFLICT_START = /^<{7} (.+)$/
  private static readonly CONFLICT_MIDDLE = /^={7}$/
  private static readonly CONFLICT_END = /^>{7} (.+)$/

  /**
   * Parse Git conflict markers in a file content
   */
  static parseConflicts(content: string): ConflictMarker[] {
    const lines = content.split("\n")
    const conflicts: ConflictMarker[] = []
    let currentConflict: Partial<ConflictMarker> | null = null
    let oursLines: string[] = []
    let theirsLines: string[] = []

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (!line) continue

      if (this.CONFLICT_START.test(line)) {
        // Start of conflict
        currentConflict = {start: i}
        oursLines = []
        theirsLines = []
      } else if (this.CONFLICT_MIDDLE.test(line) && currentConflict) {
        // Middle of conflict
        currentConflict.middle = i
      } else if (this.CONFLICT_END.test(line) && currentConflict && currentConflict.middle !== undefined) {
        // End of conflict
        currentConflict.end = i
        currentConflict.ours = oursLines.join("\n")
        currentConflict.theirs = theirsLines.join("\n")

        conflicts.push(currentConflict as ConflictMarker)
        currentConflict = null
        oursLines = []
        theirsLines = []
      } else if (currentConflict) {
        // Content within conflict
        if (currentConflict.middle === undefined) {
          // Before middle marker (ours)
          oursLines.push(line)
        } else {
          // After middle marker (theirs)
          theirsLines.push(line)
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

    // Try to parse as object property
    try {
      const wrapped = `{${trimmed}}`
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
