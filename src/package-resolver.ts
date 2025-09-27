/**
 * Main package.json conflict resolver
 */

import {ConflictParser} from "./conflict-parser.js"
import {VersionResolver} from "./version-resolver.js"
import {Logger} from "./logger.js"
import {
  PackageJson,
  ConflictMarker,
  ResolutionResult,
  ResolvedConflict,
  ResolutionStrategy,
  STABLE_PACKAGE_JSON_FIELDS,
  CliOptions,
} from "./types.js"

export class PackageResolver {
  private logger: Logger
  private options: CliOptions

  constructor(options: CliOptions) {
    this.options = options
    this.logger = new Logger({
      quiet: options.quiet,
      json: options.json,
      verbose: options.verbose,
    })
  }

  /**
   * Resolve conflicts in package.json content
   */
  async resolveConflicts(content: string): Promise<ResolutionResult> {
    const result: ResolutionResult = {
      resolved: false,
      conflicts: [],
      errors: [],
    }

    try {
      // Check if there are any conflicts
      if (!ConflictParser.hasConflicts(content)) {
        this.logger.info("No conflicts found in package.json")
        result.resolved = true
        return result
      }

      this.logger.info("Found conflicts in package.json, resolving...")

      // Parse conflicts
      const conflicts = ConflictParser.parseConflicts(content)
      this.logger.debug(`Found ${conflicts.length} conflict markers`, {conflicts})

      // Resolve each conflict
      const resolvedSections = new Map<number, string>()

      for (const conflict of conflicts) {
        try {
          const resolved = await this.resolveConflict(conflict, content)
          if (resolved) {
            result.conflicts.push(resolved)
            resolvedSections.set(conflict.start, this.formatResolvedContent(resolved))
          }
        } catch (error) {
          const errorMsg = `Failed to resolve conflict at line ${conflict.start}: ${error instanceof Error ? error.message : String(error)}`
          this.logger.error(errorMsg)
          result.errors.push(errorMsg)
        }
      }

      // Generate final content
      if (result.errors.length === 0) {
        const resolvedContent = ConflictParser.removeConflictMarkers(content, resolvedSections)

        try {
          const parsedJson = JSON.parse(resolvedContent)
          result.packageJson = this.stabilizeFieldOrder(parsedJson)
          result.resolved = true

          this.logger.success(`Resolved ${result.conflicts.length} conflicts`)
          this.logger.logConflicts(result.conflicts)
        } catch (error) {
          const errorMsg = `Failed to parse resolved JSON: ${error instanceof Error ? error.message : String(error)}`
          this.logger.error(errorMsg)
          result.errors.push(errorMsg)
        }
      }
    } catch (error) {
      const errorMsg = `Failed to resolve conflicts: ${error instanceof Error ? error.message : String(error)}`
      this.logger.error(errorMsg)
      result.errors.push(errorMsg)
    }

    return result
  }

  /**
   * Resolve a single conflict
   */
  private async resolveConflict(conflict: ConflictMarker, fullContent: string): Promise<ResolvedConflict | null> {
    try {
      // Find the field being conflicted first
      const fieldName =
        ConflictParser.extractFieldName(conflict.ours, fullContent, conflict.start) ||
        ConflictParser.extractFieldName(conflict.theirs, fullContent, conflict.start) ||
        "unknown"

      this.logger.debug("Resolving conflict for field:", fieldName)

      // For object fields (dependencies, scripts), parse as objects
      if (this.isDependencyField(fieldName) || fieldName === "scripts") {
        const ourData = ConflictParser.parsePartialJson(conflict.ours)
        const theirData = ConflictParser.parsePartialJson(conflict.theirs)
        return this.resolveDependencyConflict(fieldName, ourData, theirData)
      } else if (fieldName.startsWith("node_modules/")) {
        // For package-lock.json node_modules entries, parse as objects and resolve fields
        const ourData = ConflictParser.parsePartialJson(conflict.ours)
        const theirData = ConflictParser.parsePartialJson(conflict.theirs)
        const resolved = this.resolveNodeModulesConflict(fieldName, ourData, theirData)

        // Store original conflict content for formatting purposes
        if (resolved) {
          resolved.originalOurs = conflict.ours
          resolved.originalTheirs = conflict.theirs
        }

        return resolved
      } else {
        // For simple fields, extract values directly
        const ourValue = this.extractFieldValue(conflict.ours, fieldName)
        const theirValue = this.extractFieldValue(conflict.theirs, fieldName)
        return this.resolveSimpleConflict(fieldName, ourValue, theirValue)
      }
    } catch (error) {
      this.logger.error(`Failed to resolve conflict: ${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }

  /**
   * Resolve dependency field conflicts (dependencies, devDependencies, etc.)
   */
  private resolveDependencyConflict(fieldName: string, ourData: any, theirData: any): ResolvedConflict | null {
    // For dependency conflicts, ourData and theirData should be the parsed dependency objects
    // But they might be individual dependency lines, so we need to handle both cases

    let ourDeps: Record<string, string> = {}
    let theirDeps: Record<string, string> = {}

    // If the data is already an object with the field name, extract it
    if (typeof ourData === "object" && ourData[fieldName]) {
      ourDeps = ourData[fieldName]
    } else if (typeof ourData === "object") {
      // If it's a direct dependency object
      ourDeps = ourData
    } else {
      // Fall back to simple resolution for non-object data
      const ourValue = typeof ourData === "object" ? JSON.stringify(ourData) : String(ourData)
      const theirValue = typeof theirData === "object" ? JSON.stringify(theirData) : String(theirData)
      return this.resolveSimpleConflict(fieldName, ourValue, theirValue)
    }

    if (typeof theirData === "object" && theirData[fieldName]) {
      theirDeps = theirData[fieldName]
    } else if (typeof theirData === "object") {
      theirDeps = theirData
    }

    // Merge dependencies, resolving version conflicts while preserving order
    const merged: Record<string, string> = {}

    // First add all our dependencies in their original order
    for (const packageName of Object.keys(ourDeps)) {
      const ourVersion = ourDeps[packageName]
      if (ourVersion !== undefined) {
        merged[packageName] = ourVersion
      }
    }

    // Then add their dependencies that we don't have, maintaining their order
    for (const packageName of Object.keys(theirDeps)) {
      const theirVersion = theirDeps[packageName]
      if (theirVersion === undefined) continue

      if (!(packageName in merged)) {
        merged[packageName] = theirVersion
      } else {
        const ourVersion = merged[packageName]
        // At this point we know theirVersion is defined (checked above)
        // and ourVersion must be defined since it's in merged
        if (ourVersion !== theirVersion) {
          // Version conflict - resolve using strategy
          // We know both versions are defined at this point
          const resolution = VersionResolver.resolveVersion(
            ourVersion as string,
            theirVersion as string,
            this.options.strategy
          )
          merged[packageName] = resolution.resolved
        }
      }
    }

    return {
      field: fieldName,
      ourValue: JSON.stringify(ourDeps, null, 2),
      theirValue: JSON.stringify(theirDeps, null, 2),
      resolvedValue: JSON.stringify(merged, null, 2),
      strategy: this.options.strategy,
    }
  }

  /**
   * Resolve node_modules conflicts (for package-lock.json)
   */
  private resolveNodeModulesConflict(fieldName: string, ourData: any, theirData: any): ResolvedConflict | null {
    if (typeof ourData !== "object" || typeof theirData !== "object") {
      // Fall back to simple resolution for non-object data
      const ourValue = typeof ourData === "object" ? JSON.stringify(ourData) : String(ourData)
      const theirValue = typeof theirData === "object" ? JSON.stringify(theirData) : String(theirData)
      return this.resolveSimpleConflict(fieldName, ourValue, theirValue)
    }

    // Merge node_modules entry, resolving field conflicts
    const merged: Record<string, any> = {}
    const allKeys = new Set([...Object.keys(ourData), ...Object.keys(theirData)])

    for (const key of allKeys) {
      const ourValue = ourData[key]
      const theirValue = theirData[key]

      if (ourValue !== undefined && theirValue !== undefined && ourValue !== theirValue) {
        // Field conflict - resolve based on field type
        if (key === "version") {
          // Version conflict - use version resolution strategy
          const resolution = VersionResolver.resolveVersion(ourValue, theirValue, this.options.strategy)
          merged[key] = resolution.resolved
        } else {
          // Other fields - use strategy-based resolution
          const resolution = VersionResolver.resolveNonVersion(ourValue, theirValue, this.options.strategy)
          merged[key] = resolution.resolved
        }
      } else {
        // No conflict - use whichever exists
        merged[key] = ourValue !== undefined ? ourValue : theirValue
      }
    }

    return {
      field: fieldName,
      ourValue: JSON.stringify(ourData, null, 2),
      theirValue: JSON.stringify(theirData, null, 2),
      resolvedValue: JSON.stringify(merged, null, 2),
      strategy: this.options.strategy,
    }
  }

  /**
   * Check if field is a dependency field
   */
  private isDependencyField(fieldName: string): boolean {
    return ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].includes(fieldName)
  }

  /**
   * Extract field value from conflict content
   */
  private extractFieldValue(content: string, fieldName: string): string {
    // Look for the field in the content
    const regex = new RegExp(`"${fieldName}"\\s*:\\s*(".*?"|[^,\\n}]+)`, "i")
    const match = content.match(regex)

    if (match && match[1]) {
      let value = match[1].trim()
      // Remove quotes if it's a string
      if (value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1)
      }
      return value
    }

    return content.trim()
  }

  /**
   * Resolve simple field conflicts (version, name, etc.)
   */
  private resolveSimpleConflict(fieldName: string, ourValue: string, theirValue: string): ResolvedConflict {
    let resolvedValue: string

    if (fieldName === "version") {
      const resolution = VersionResolver.resolveVersion(ourValue, theirValue, this.options.strategy)
      resolvedValue = resolution.resolved
    } else {
      const resolution = VersionResolver.resolveNonVersion(ourValue, theirValue, this.options.strategy)
      resolvedValue = String(resolution.resolved)
    }

    return {
      field: fieldName,
      ourValue,
      theirValue,
      resolvedValue,
      strategy: this.options.strategy,
    }
  }

  /**
   * Format resolved content for insertion
   */
  private formatResolvedContent(resolved: ResolvedConflict): string {
    if (this.isDependencyField(resolved.field) || resolved.field === "scripts") {
      // For dependency conflicts, format as the complete field with its content
      try {
        const resolvedDeps = JSON.parse(resolved.resolvedValue)
        const lines = []

        // Add the field name
        lines.push(`  "${resolved.field}": {`)

        // Add each dependency/script
        const entries = Object.entries(resolvedDeps)
        for (let i = 0; i < entries.length; i++) {
          const entry = entries[i]
          if (entry) {
            const [key, value] = entry
            const isLast = i === entries.length - 1
            const comma = isLast ? "" : ","
            lines.push(`    "${key}": "${value}"${comma}`)
          }
        }

        lines.push("  }")
        return lines.join("\n")
      } catch (error) {
        // Fallback to simple formatting
        const value = resolved.resolvedValue.startsWith('"') ? resolved.resolvedValue : `"${resolved.resolvedValue}"`
        return `  "${resolved.field}": ${value}`
      }
    } else if (resolved.field.startsWith("node_modules/")) {
      // For package-lock.json node_modules entries, format as multi-line object
      try {
        const resolvedObj = JSON.parse(resolved.resolvedValue)
        const lines = []

        for (const [key, value] of Object.entries(resolvedObj)) {
          if (typeof value === "string") {
            lines.push(`      "${key}": "${value}",`)
          } else {
            lines.push(`      "${key}": ${JSON.stringify(value)},`)
          }
        }

        // Check if original content had trailing comma - if so, keep it
        const originalHadTrailingComma =
          (resolved.originalOurs && resolved.originalOurs.trim().endsWith(",")) ||
          (resolved.originalTheirs && resolved.originalTheirs.trim().endsWith(","))

        if (!originalHadTrailingComma && lines.length > 0) {
          // Remove trailing comma from last line only if original didn't have one
          const lastLine = lines[lines.length - 1]
          if (lastLine) {
            lines[lines.length - 1] = lastLine.replace(/,$/, "")
          }
        }

        return lines.join("\n")
      } catch (error) {
        // Fallback to simple formatting
        return resolved.resolvedValue
      }
    } else {
      // For simple values, format as JSON property
      const value = resolved.resolvedValue.startsWith('"') ? resolved.resolvedValue : `"${resolved.resolvedValue}"`
      return `  "${resolved.field}": ${value}`
    }
  }

  /**
   * Stabilize field order in package.json
   */
  private stabilizeFieldOrder(packageJson: PackageJson): PackageJson {
    const ordered: PackageJson = {}

    // Add stable fields in order
    for (const field of STABLE_PACKAGE_JSON_FIELDS) {
      if (packageJson[field] !== undefined) {
        ;(ordered as any)[field] = packageJson[field]
      }
    }

    // Add remaining fields
    for (const [key, value] of Object.entries(packageJson)) {
      if (!STABLE_PACKAGE_JSON_FIELDS.includes(key as any)) {
        ordered[key] = value
      }
    }

    return ordered
  }

  /**
   * Write resolved package.json to file
   */
  async writeResolvedPackage(packageJson: PackageJson, filePath: string): Promise<void> {
    const content = JSON.stringify(packageJson, null, 2) + "\n"

    if (this.options.dryRun) {
      this.logger.info(`Would write resolved package.json to ${filePath}`)
    } else {
      const fs = await import("fs/promises")
      await fs.writeFile(filePath, content, "utf8")
      this.logger.success(`Wrote resolved package.json to ${filePath}`)
    }
  }
}
