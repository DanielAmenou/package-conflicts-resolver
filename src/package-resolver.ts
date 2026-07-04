/**
 * Main package.json conflict resolver
 */

import {isDeepStrictEqual} from "node:util"
import {ConflictParser} from "./conflict-parser.js"
import {VersionResolver} from "./version-resolver.js"
import {Logger} from "./logger.js"
import {PackageJson, ConflictMarker, ResolutionResult, ResolvedConflict, CliOptions} from "./types.js"

interface MergeOutcome {
  value: any
  conflicts: ResolvedConflict[]
}

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

    // Strip UTF-8 BOM so JSON parsing works for files saved by Windows editors
    content = this.stripBom(content)

    try {
      // Check if there are any conflicts
      if (!ConflictParser.hasConflicts(content)) {
        this.logger.info("No conflicts found")
        result.resolved = true
        return result
      }

      this.logger.info("Found conflicts, resolving...")

      const semanticResult = this.resolveConflictVariants(content)
      if (semanticResult) {
        result.conflicts = semanticResult.conflicts
        result.packageJson = semanticResult.packageJson
        result.resolved = true

        this.logger.success(`Resolved ${result.conflicts.length} conflicts`)
        this.logger.logConflicts(result.conflicts)
        return result
      }

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
          result.packageJson = parsedJson
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
   * Merge full JSON documents using a semantic two-way merge.
   * This is used for real Git conflict markers, where the surrounding JSON
   * structure may be shared outside the conflict block.
   */
  private resolveConflictVariants(content: string): ResolutionResult | null {
    try {
      const ourContent = ConflictParser.extractConflictSide(content, "ours")
      const theirContent = ConflictParser.extractConflictSide(content, "theirs")
      // diff3/zdiff3 conflict styles carry the common ancestor: use it for a true 3-way merge
      const baseContent = ConflictParser.hasBaseSections(content)
        ? ConflictParser.extractConflictSide(content, "base")
        : undefined
      const result = this.mergeJsonContentsInternal(ourContent, theirContent, baseContent)
      return result.resolved ? result : null
    } catch (error) {
      this.logger.debug("Semantic conflict resolution failed, falling back to block-based parser", {
        error: error instanceof Error ? error.message : String(error),
      })
      return null
    }
  }

  /**
   * Merge base/current/other JSON contents for Git merge-driver usage.
   */
  async mergeJsonContents(
    baseContent: string,
    currentContent: string,
    otherContent: string
  ): Promise<ResolutionResult> {
    return this.mergeJsonContentsInternal(currentContent, otherContent, baseContent)
  }

  /**
   * Merge JSON contents, optionally with a base document for true three-way merges.
   */
  private mergeJsonContentsInternal(ourContent: string, theirContent: string, baseContent?: string): ResolutionResult {
    const result: ResolutionResult = {
      resolved: false,
      conflicts: [],
      errors: [],
    }

    try {
      const ourText = this.stripBom(ourContent)
      const theirText = this.stripBom(theirContent)
      const baseText = baseContent !== undefined ? this.stripBom(baseContent) : undefined

      const ourIsBlank = ourText.trim() === ""
      const theirIsBlank = theirText.trim() === ""

      if (ourIsBlank && theirIsBlank) {
        throw new Error("Both documents are empty")
      }

      // A side can be empty (e.g. file added on only one branch): take the other side
      const ourDocument = ourIsBlank ? undefined : JSON.parse(ourText)
      const theirDocument = theirIsBlank ? undefined : JSON.parse(theirText)

      if (ourDocument === undefined || theirDocument === undefined) {
        const survivor = ourDocument !== undefined ? ourDocument : theirDocument
        if (!this.isPlainObject(survivor)) {
          throw new Error("Expected JSON object documents")
        }
        result.packageJson = survivor as PackageJson
        result.resolved = true
        return result
      }

      // Empty base (e.g. file added on both branches) means "no common ancestor"
      const baseDocument = baseText !== undefined && baseText.trim() !== "" ? JSON.parse(baseText) : undefined

      if (!this.isPlainObject(ourDocument) || !this.isPlainObject(theirDocument)) {
        throw new Error("Expected JSON object documents")
      }

      if (baseDocument !== undefined && !this.isPlainObject(baseDocument)) {
        throw new Error("Expected base document to be a JSON object")
      }

      const merged = this.mergeValue([], baseDocument, ourDocument, theirDocument)
      result.conflicts = merged.conflicts
      result.packageJson = this.finalizeMergedDocument(merged.value)
      result.resolved = true
    } catch (error) {
      result.errors.push(error instanceof Error ? error.message : String(error))
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
        const resolved = this.resolveSimpleConflict(fieldName, ourValue, theirValue)

        // Store original conflict content for formatting purposes (to preserve trailing commas)
        resolved.originalOurs = conflict.ours
        resolved.originalTheirs = conflict.theirs

        return resolved
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
    if (this.isPlainObject(ourData) && ourData[fieldName]) {
      ourDeps = ourData[fieldName]
    } else if (this.isPlainObject(ourData)) {
      // If it's a direct dependency object
      ourDeps = ourData
    } else {
      // Fall back to simple resolution for non-object data
      const ourValue = typeof ourData === "object" ? JSON.stringify(ourData) : String(ourData)
      const theirValue = typeof theirData === "object" ? JSON.stringify(theirData) : String(theirData)
      return this.resolveSimpleConflict(fieldName, ourValue, theirValue)
    }

    if (this.isPlainObject(theirData) && theirData[fieldName]) {
      theirDeps = theirData[fieldName]
    } else if (this.isPlainObject(theirData)) {
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
    if (!this.isPlainObject(ourData) || !this.isPlainObject(theirData)) {
      // Fall back to simple resolution for non-object data
      const ourValue = typeof ourData === "object" ? JSON.stringify(ourData) : String(ourData)
      const theirValue = typeof theirData === "object" ? JSON.stringify(theirData) : String(theirData)
      return this.resolveSimpleConflict(fieldName, ourValue, theirValue)
    }

    // Lock entries with different versions are resolved atomically so that
    // version/resolved/integrity never get mixed between the two sides.
    if (
      this.isLockPackageEntry(ourData) &&
      this.isLockPackageEntry(theirData) &&
      ourData.version !== theirData.version
    ) {
      const resolution = VersionResolver.resolveVersion(ourData.version, theirData.version, this.options.strategy)
      const winner = resolution.resolved === theirData.version ? theirData : ourData

      return {
        field: fieldName,
        ourValue: JSON.stringify(ourData, null, 2),
        theirValue: JSON.stringify(theirData, null, 2),
        resolvedValue: JSON.stringify(winner, null, 2),
        strategy: this.options.strategy,
      }
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
    // Look for the field in the content (field names may contain regex special chars)
    const escapedFieldName = fieldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const regex = new RegExp(`"${escapedFieldName}"\\s*:\\s*(".*?"|[^,\\n}]+)`, "i")
    const match = content.match(regex)

    if (match && match[1]) {
      // Return the raw JSON token (quotes preserved) so the value type survives formatting
      return match[1].trim()
    }

    return content.trim()
  }

  /**
   * Unquote a raw JSON string token for comparison purposes
   */
  private unquoteJsonToken(token: string): string {
    const trimmed = token.trim()
    if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
      try {
        return JSON.parse(trimmed)
      } catch {
        return trimmed.slice(1, -1)
      }
    }
    return trimmed
  }

  /**
   * Resolve simple field conflicts (version, name, etc.)
   */
  private resolveSimpleConflict(fieldName: string, ourValue: string, theirValue: string): ResolvedConflict {
    // Values may be raw JSON tokens; compare their unquoted forms, but keep the
    // winning raw token so string/number/boolean types survive re-serialization.
    const ourComparable = this.unquoteJsonToken(ourValue)
    const theirComparable = this.unquoteJsonToken(theirValue)

    let winnerIsTheirs: boolean
    if (fieldName === "version") {
      const resolution = VersionResolver.resolveVersion(ourComparable, theirComparable, this.options.strategy)
      winnerIsTheirs = resolution.resolved === theirComparable && ourComparable !== theirComparable
    } else {
      const resolution = VersionResolver.resolveNonVersion(ourComparable, theirComparable, this.options.strategy)
      winnerIsTheirs = String(resolution.resolved) === theirComparable && ourComparable !== theirComparable
    }

    return {
      field: fieldName,
      ourValue,
      theirValue,
      resolvedValue: winnerIsTheirs ? theirValue : ourValue,
      strategy: this.options.strategy,
    }
  }

  /**
   * Format resolved content for insertion
   */
  private formatResolvedContent(resolved: ResolvedConflict): string {
    // When we couldn't determine the field, don't invent a key: keep one side verbatim
    if (resolved.field === "unknown") {
      const side = this.options.strategy === "theirs" ? resolved.originalTheirs : resolved.originalOurs
      return side !== undefined ? side : resolved.resolvedValue
    }

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
        return `  "${resolved.field}": ${this.formatJsonValue(resolved.resolvedValue)}`
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
      const value = this.formatJsonValue(resolved.resolvedValue)

      // Check if original content had trailing comma - if so, preserve it
      const originalHadTrailingComma =
        (resolved.originalOurs && resolved.originalOurs.trim().endsWith(",")) ||
        (resolved.originalTheirs && resolved.originalTheirs.trim().endsWith(","))

      const comma = originalHadTrailingComma ? "," : ""
      return `  "${resolved.field}": ${value}${comma}`
    }
  }

  /**
   * Format a raw resolved value as valid JSON: booleans, numbers, null, objects
   * and pre-quoted strings pass through; bare strings get properly escaped quotes.
   */
  private formatJsonValue(raw: string): string {
    const trimmed = raw.trim()
    try {
      JSON.parse(trimmed)
      return trimmed
    } catch {
      return JSON.stringify(trimmed)
    }
  }

  /**
   * Strip a UTF-8 byte order mark
   */
  private stripBom(content: string): string {
    return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content
  }

  /**
   * Write resolved package.json to file
   */
  async writeResolvedPackage(packageJson: PackageJson, filePath: string, originalContent?: string): Promise<void> {
    const content = this.serializeDocument(packageJson, originalContent)

    if (this.options.dryRun) {
      this.logger.info(`Would write resolved file to ${filePath}`)
    } else {
      const fs = await import("fs/promises")
      await fs.writeFile(filePath, content, "utf8")
      this.logger.success(`Wrote resolved file to ${filePath}`)
    }
  }

  /**
   * Serialize the document preserving the original file's indentation
   * (tabs, 2 or 4 spaces), line endings (LF/CRLF) and trailing newline.
   */
  private serializeDocument(packageJson: PackageJson, originalContent?: string): string {
    let indent: string | number = 2
    let eol = "\n"
    let trailingNewline = true

    if (originalContent !== undefined && originalContent.length > 0) {
      const indentMatch = originalContent.match(/^([ \t]+)\S/m)
      if (indentMatch && indentMatch[1]) {
        indent = indentMatch[1]
      }
      eol = originalContent.includes("\r\n") ? "\r\n" : "\n"
      trailingNewline = /(?:\r?\n)\s*$/.test(originalContent)
    }

    let content = JSON.stringify(packageJson, null, indent)
    if (eol !== "\n") {
      content = content.replace(/\n/g, eol)
    }
    if (trailingNewline) {
      content += eol
    }

    return content
  }

  private mergeValue(path: string[], baseValue: any, ourValue: any, theirValue: any): MergeOutcome {
    if (ourValue === undefined && theirValue === undefined) {
      return {value: undefined, conflicts: []}
    }

    const preferStrategyResolution = this.shouldResolveAsVersion(path, ourValue, theirValue)

    if (!preferStrategyResolution && this.isUnchangedFromBase(ourValue, baseValue)) {
      return {value: theirValue, conflicts: []}
    }

    if (!preferStrategyResolution && this.isUnchangedFromBase(theirValue, baseValue)) {
      return {value: ourValue, conflicts: []}
    }

    if (ourValue === undefined) {
      return {value: theirValue, conflicts: []}
    }

    if (theirValue === undefined) {
      return {value: ourValue, conflicts: []}
    }

    if (isDeepStrictEqual(ourValue, theirValue)) {
      return {value: ourValue, conflicts: []}
    }

    // Lockfile package entries must stay internally consistent: version, resolved
    // and integrity belong together, so never merge them field-by-field.
    if (
      this.isLockPackageEntry(ourValue) &&
      this.isLockPackageEntry(theirValue) &&
      ourValue.version !== theirValue.version
    ) {
      return this.mergeLockPackageEntry(path, ourValue, theirValue)
    }

    if (this.isPlainObject(ourValue) && this.isPlainObject(theirValue)) {
      return this.mergeObjectValues(path, this.asPlainObject(baseValue), ourValue, theirValue)
    }

    if (Array.isArray(ourValue) && Array.isArray(theirValue)) {
      return this.mergeArrayValues(path, baseValue, ourValue, theirValue)
    }

    return this.resolveLeafConflict(path, ourValue, theirValue)
  }

  private mergeObjectValues(
    path: string[],
    baseValue: Record<string, any> | undefined,
    ourValue: Record<string, any>,
    theirValue: Record<string, any>
  ): MergeOutcome {
    const merged: Record<string, any> = {}
    const conflicts: ResolvedConflict[] = []
    const keys = this.orderedUnion(Object.keys(ourValue), Object.keys(theirValue), Object.keys(baseValue || {}))

    for (const key of keys) {
      const mergedChild = this.mergeValue(path.concat(key), baseValue?.[key], ourValue[key], theirValue[key])
      if (mergedChild.value !== undefined) {
        merged[key] = mergedChild.value
      }
      conflicts.push(...mergedChild.conflicts)
    }

    return {value: merged, conflicts}
  }

  private mergeArrayValues(path: string[], baseValue: any, ourValue: any[], theirValue: any[]): MergeOutcome {
    if (Array.isArray(baseValue)) {
      if (isDeepStrictEqual(ourValue, baseValue)) {
        return {value: theirValue, conflicts: []}
      }
      if (isDeepStrictEqual(theirValue, baseValue)) {
        return {value: ourValue, conflicts: []}
      }
    }

    if (ourValue.every(this.isPrimitiveValue) && theirValue.every(this.isPrimitiveValue)) {
      const mergedArray = [...ourValue]
      for (const item of theirValue) {
        if (!mergedArray.some(existing => isDeepStrictEqual(existing, item))) {
          mergedArray.push(item)
        }
      }

      return {
        value: mergedArray,
        conflicts: [this.createConflictRecord(path, ourValue, theirValue, mergedArray)],
      }
    }

    return this.resolveLeafConflict(path, ourValue, theirValue)
  }

  /**
   * A package-lock entry: has a string version plus resolved/integrity metadata.
   */
  private isLockPackageEntry(value: any): value is Record<string, any> {
    return (
      this.isPlainObject(value) &&
      typeof value.version === "string" &&
      (typeof value.resolved === "string" || typeof value.integrity === "string")
    )
  }

  /**
   * Resolve a lockfile entry conflict atomically: pick the side whose version
   * wins under the strategy and keep all of its correlated fields together.
   */
  private mergeLockPackageEntry(
    path: string[],
    ourValue: Record<string, any>,
    theirValue: Record<string, any>
  ): MergeOutcome {
    const resolution = VersionResolver.resolveVersion(ourValue.version, theirValue.version, this.options.strategy)
    const winner = resolution.resolved === theirValue.version ? theirValue : ourValue

    return {
      value: winner,
      conflicts: [this.createConflictRecord(path, ourValue, theirValue, winner)],
    }
  }

  private resolveLeafConflict(path: string[], ourValue: any, theirValue: any): MergeOutcome {
    const resolution = this.shouldResolveAsVersion(path, ourValue, theirValue)
      ? VersionResolver.resolveVersion(String(ourValue), String(theirValue), this.options.strategy)
      : VersionResolver.resolveNonVersion(ourValue, theirValue, this.options.strategy)

    return {
      value: resolution.resolved,
      conflicts: [this.createConflictRecord(path, ourValue, theirValue, resolution.resolved)],
    }
  }

  private createConflictRecord(path: string[], ourValue: any, theirValue: any, resolvedValue: any): ResolvedConflict {
    return {
      field: this.formatPath(path),
      ourValue: this.stringifyConflictValue(ourValue),
      theirValue: this.stringifyConflictValue(theirValue),
      resolvedValue: this.stringifyConflictValue(resolvedValue),
      strategy: this.options.strategy,
    }
  }

  private finalizeMergedDocument(document: any): PackageJson {
    if (!this.isPlainObject(document)) {
      throw new Error("Merged document is not a JSON object")
    }

    return document as PackageJson
  }

  private isUnchangedFromBase(value: any, baseValue: any): boolean {
    if (baseValue === undefined) {
      return value === undefined
    }

    if (value === undefined) {
      return false
    }

    return isDeepStrictEqual(value, baseValue)
  }

  private shouldResolveAsVersion(path: string[], ourValue: any, theirValue: any): boolean {
    if (typeof ourValue !== "string" || typeof theirValue !== "string") {
      return false
    }

    const currentKey = path[path.length - 1]
    const parentKey = path[path.length - 2]

    return currentKey === "version" || this.isDependencyField(parentKey || "")
  }

  private stringifyConflictValue(value: any): string {
    if (value === undefined) {
      return "<deleted>"
    }

    if (typeof value === "string") {
      return value
    }

    return JSON.stringify(value)
  }

  private formatPath(path: string[]): string {
    return path.length === 0 ? "root" : path.join(".")
  }

  private orderedUnion(...lists: string[][]): string[] {
    const seen = new Set<string>()
    const ordered: string[] = []

    for (const list of lists) {
      for (const item of list) {
        if (!seen.has(item)) {
          seen.add(item)
          ordered.push(item)
        }
      }
    }

    return ordered
  }

  private isPlainObject(value: any): value is Record<string, any> {
    return value !== null && typeof value === "object" && !Array.isArray(value)
  }

  private asPlainObject(value: any): Record<string, any> | undefined {
    return this.isPlainObject(value) ? value : undefined
  }

  private isPrimitiveValue = (value: any): boolean => {
    return value === null || ["string", "number", "boolean"].includes(typeof value)
  }
}
