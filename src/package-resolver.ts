/**
 * Main package.json conflict resolver
 */

import {writeFile} from "fs/promises"
import {randomUUID} from "node:crypto"
import {isDeepStrictEqual} from "node:util"
import {ConflictParser} from "./conflict-parser.js"
import {VersionResolver, type VersionResolution} from "./version-resolver.js"
import {Logger} from "./logger.js"
import {parseJsonLenient} from "./json-repair.js"
import {isNpmLockfile, validateLockfile} from "./lockfile-validator.js"
import {lockedVersionSatisfies, normalizeVersionPicks} from "./version-picks.js"
import {
  PackageJson,
  ConflictMarker,
  ResolutionResult,
  ResolvedConflict,
  CliOptions,
  LockfileIssue,
  PackageConflict,
  UnresolvedConflict,
  UnresolvedReason,
} from "./types.js"

interface MergeOutcome {
  value: any
  conflicts: ResolvedConflict[]
  /** Conflicts on package versions found while merging this value */
  packageConflicts?: PackageConflict[]
  /** Values left for the user to decide, found while merging this value */
  unresolved?: UnresolvedConflict[]
}

/**
 * What decides which values of the merged documents are package versions.
 */
interface MergeContext {
  /** The documents are npm lockfiles rather than package.json manifests */
  lockfile: boolean
  /**
   * The lockfile has a v2/v3 "packages" section. The legacy "dependencies"
   * section of a v2 lockfile then repeats the same installs: conflicts there
   * are resolved the same way but not listed a second time.
   */
  packagesSection: boolean
  /**
   * Block-based (fallback) merge only: the values it would have had to decide
   * although the strategy cannot (see UnresolvedReason). It cannot leave
   * single properties conflicted, so it then resolves nothing at all.
   */
  undecided?: Undecided[]
}

/** A value the block-based merge would have had to decide, and why the strategy cannot */
interface Undecided {
  field: string
  reason: UnresolvedReason
}

/** The values of a conflict: undefined where a side does not have it */
interface ConflictValues {
  base: any
  ours: any
  theirs: any
  resolved: any
}

/** A value that belongs to a package: a spec it is declared with, or a locked install of it */
interface PackageRef {
  name: string
  kind: PackageConflict["kind"]
  location: string
  /** Whether conflicts on this value are reported in packageConflicts */
  listed: boolean
}

/** A locked package entry a block-based (fallback) conflict covers, as each side has it */
interface FragmentEntry {
  ref: PackageRef
  path: string[]
  ours: Record<string, any>
  theirs: Record<string, any>
}

/** Fields that map package names to the version specs the project depends on */
const DEPENDENCY_FIELDS = new Set(["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"])

const NODE_MODULES = "node_modules/"

/**
 * Whether a lockfile "packages" key is an install location
 * ("node_modules/a/node_modules/b"), rather than the root project ("") or a
 * workspace folder ("packages/app").
 */
function isInstallLocation(location: string): boolean {
  return location.startsWith(NODE_MODULES) || location.includes(`/${NODE_MODULES}`)
}

/**
 * The package a value belongs to, from its path in the document:
 * - package.json: <dependency field>.<name>
 * - lockfile root and workspace entries: packages.<"" | folder>.<dependency field>.<name>
 * - lockfile installs: packages.<...node_modules/name> (lockfile v2/v3), and
 *   dependencies.<name>[.dependencies.<name>...] (lockfile v1, and the legacy
 *   section of v2)
 * The dependency fields inside installed entries are the published manifests
 * of third-party packages, not choices of the project: they are not packages'
 * specs here.
 */
function packageAt(path: string[], context: MergeContext): PackageRef | undefined {
  const [first, second, third, fourth] = path

  if (!context.lockfile) {
    return path.length === 2 && DEPENDENCY_FIELDS.has(first as string)
      ? {name: second as string, kind: "spec", location: first as string, listed: true}
      : undefined
  }

  if (first === "packages" && second !== undefined) {
    if (path.length === 2 && isInstallLocation(second)) {
      const name = second.slice(second.lastIndexOf(NODE_MODULES) + NODE_MODULES.length)
      return name === "" ? undefined : {name, kind: "lock", location: second, listed: true}
    }
    if (path.length === 4 && !isInstallLocation(second) && DEPENDENCY_FIELDS.has(third as string)) {
      const location = `${second === "" ? "root" : second} › ${third}`
      return {name: fourth as string, kind: "spec", location, listed: true}
    }
    return undefined
  }

  const isLegacyInstall =
    path.length >= 2 &&
    path.length % 2 === 0 &&
    path.every((segment, index) => index % 2 === 1 || segment === "dependencies")
  if (isLegacyInstall) {
    const names = path.filter((_, index) => index % 2 === 1)
    return {
      name: names[names.length - 1] as string,
      kind: "lock",
      location: names.map(name => `${NODE_MODULES}${name}`).join("/"),
      listed: !context.packagesSection,
    }
  }

  return undefined
}

/**
 * How a locked entry is shown in a package conflict: its version, or what it
 * points at when it has none (workspace links, some git and file installs).
 */
function describeLockEntry(entry: Record<string, any>): string {
  if (typeof entry.version === "string") {
    return entry.version
  }
  if (typeof entry.resolved === "string") {
    return entry.resolved
  }
  return "(no version)"
}

/**
 * Object fields whose immediate string values are version specs and must be
 * compared with semver rather than lexicographically.
 */
const VERSION_SPEC_PARENT_FIELDS = new Set([
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
  // package-lock.json v1/v2 records the ranges an entry was resolved with
  "requires",
  "engines",
  "overrides",
  "resolutions",
])

/**
 * Fields whose whole subtree holds version specs, however deeply nested.
 * npm's `overrides` and yarn's `resolutions` nest arbitrarily:
 *
 *   "overrides": {"foo": {".": "1.2.0", "bar": "1.2.0"}}
 *
 * so every string leaf below them is a spec, not free-form text.
 */
const VERSION_SPEC_SUBTREE_FIELDS = new Set(["overrides", "resolutions"])

/**
 * Fields of a package-lock entry that identify the exact artifact it points
 * to. They describe one tarball and must never be mixed between two sides.
 */
const LOCK_ENTRY_IDENTITY_FIELDS = ["version", "resolved", "integrity"] as const

/** The strategies that pick a side for any value; highest and lowest only order versions */
const SIDE_STRATEGIES = new Set(["ours", "theirs"])

/**
 * JSON.stringify(document, null, indent), except that each unresolved value
 * is written as a Git conflict between our value and theirs, around just its
 * property. Everything else reads exactly as JSON.stringify writes it, so the
 * user, or a later run with the ours or theirs strategy, only has these
 * properties left to decide.
 *
 * - The side of a branch that removed the value has no line. The property
 *   then comes first in its object: whichever side is kept, a comma still
 *   separates it from the properties after it, and none is left dangling.
 * - When the common ancestor is known, every conflict shows it, in a diff3
 *   `|||||||` section that is empty when the ancestor did not have the value.
 *   A later run needs it to tell a removal from an addition, and it would
 *   read a conflict without that section as if the ancestor were ours.
 */
function stringifyWithConflicts(document: PackageJson, indent: string, unresolved: UnresolvedConflict[]): string {
  // A stand-in value, unique to this call, marks the line of each conflict
  const nonce = randomUUID()
  const standIn = (index: number) => `pcr-conflict-${nonce}-${index}`
  const oneSided = (conflict: UnresolvedConflict) => conflict.ours === undefined || conflict.theirs === undefined
  const showBase = unresolved.some(conflict => conflict.base !== undefined)

  const copy = structuredClone(document)
  const conflicts = new Map<string, UnresolvedConflict>()
  unresolved.forEach((conflict, index) => {
    conflicts.set(JSON.stringify(standIn(index)), conflict)
    if (!oneSided(conflict)) {
      setAt(copy, conflict.path, standIn(index))
    }
  })
  // Last to first, so that the one-sided properties keep their order at the front
  for (let index = unresolved.length - 1; index >= 0; index--) {
    const conflict = unresolved[index] as UnresolvedConflict
    if (oneSided(conflict)) {
      setAt(copy, conflict.path, standIn(index), {first: true})
    }
  }

  return JSON.stringify(copy, null, indent)
    .split("\n")
    .flatMap(line => {
      // <indentation>"key": "<stand-in>" and the comma, when more properties follow
      const match = /^(\s*)("(?:[^"\\]|\\.)*"): ("[^"]*")(,?)$/.exec(line)
      const conflict = match !== null ? conflicts.get(match[3] as string) : undefined
      if (match === null || conflict === undefined) {
        return [line]
      }
      const [, indentation, key, , comma] = match
      // The property with a side's value, or no line for a side without one
      const side = (value: unknown): string[] =>
        value === undefined
          ? []
          : [
              `${indentation}${key}: ${JSON.stringify(value, null, indent).split("\n").join(`\n${indentation}`)}${comma}`,
            ]
      return [
        "<<<<<<< ours",
        ...side(conflict.ours),
        ...(showBase ? ["||||||| base", ...side(conflict.base)] : []),
        "=======",
        ...side(conflict.theirs),
        ">>>>>>> theirs",
      ]
    })
    .join("\n")
}

/**
 * Set the value at `path` of a document whose objects along the path exist;
 * with `first`, as the first property of its object.
 */
function setAt(document: Record<string, any>, path: string[], value: unknown, {first = false} = {}): void {
  let parent = document
  for (const key of path.slice(0, -1)) {
    parent = parent[key]
  }
  const key = path[path.length - 1] as string
  if (!first) {
    parent[key] = value
    return
  }
  const others = Object.entries(parent).filter(([name]) => name !== key)
  for (const name of Object.keys(parent)) {
    delete parent[name]
  }
  parent[key] = value
  for (const [name, entry] of others) {
    parent[name] = entry
  }
}

export class PackageResolver {
  private logger: Logger
  private options: CliOptions
  /** Versions picked for specific packages: they win over the strategy */
  private picks: Map<string, string>

  constructor(options: CliOptions) {
    this.options = options
    this.picks = normalizeVersionPicks(options.picks)
    this.logger = new Logger({
      quiet: options.quiet,
      json: options.json,
      verbose: options.verbose,
      silent: options.silent,
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
        result.packageConflicts = []
        result.unresolved = []
        result.resolved = true
        return result
      }

      this.logger.info("Found conflicts, resolving...")

      const semanticResult = this.resolveConflictVariants(content)
      if (semanticResult) {
        result.conflicts = semanticResult.conflicts
        result.packageJson = semanticResult.packageJson
        result.packageConflicts = semanticResult.packageConflicts ?? []
        result.unresolved = semanticResult.unresolved ?? []
        if (semanticResult.lockfileIssues !== undefined) {
          result.lockfileIssues = semanticResult.lockfileIssues
        }
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
      const context: MergeContext = {...this.fallbackContext(content), undecided: []}
      const packageConflicts: PackageConflict[] = []

      // A block that cannot be resolved fails the whole resolution: removing
      // its markers without a resolution would lose both of its sides
      for (const conflict of conflicts) {
        try {
          const resolved = await this.resolveConflict(conflict, content, context, packageConflicts)
          result.conflicts.push(resolved)
          resolvedSections.set(conflict.start, this.formatResolvedContent(resolved))
        } catch (error) {
          const errorMsg = `Failed to resolve conflict at line ${conflict.start + 1}: ${error instanceof Error ? error.message : String(error)}`
          this.logger.error(errorMsg)
          result.errors.push(errorMsg)
        }
      }

      // Unlike the semantic merge, this one cannot leave a single property
      // conflicted for the user: rather than decide such a value, it fails
      if (context.undecided !== undefined && context.undecided.length > 0) {
        const errorMsg = this.undecidedMessage(context.undecided)
        this.logger.error(errorMsg)
        result.errors.push(errorMsg)
      }

      // Generate final content
      if (result.errors.length === 0) {
        const resolvedContent = ConflictParser.removeConflictMarkers(content, resolvedSections)

        try {
          const parsedJson = this.parseResolvedJson(resolvedContent)
          result.packageJson = parsedJson
          result.packageConflicts = packageConflicts
          result.unresolved = []
          this.attachLockfileIssues(result, this.parseConflictSides(content))
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
      // Each side is stitched together from a line-based merge, so a comma may
      // be missing or left over at a conflict boundary: parse leniently.
      const result = this.mergeJsonContentsInternal(ourContent, theirContent, baseContent, {lenient: true})
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
  private mergeJsonContentsInternal(
    ourContent: string,
    theirContent: string,
    baseContent?: string,
    parseOptions: {lenient?: boolean} = {}
  ): ResolutionResult {
    const result: ResolutionResult = {
      resolved: false,
      conflicts: [],
      errors: [],
    }

    try {
      const parse: (text: string) => any = parseOptions.lenient ? parseJsonLenient : JSON.parse

      const ourText = this.stripBom(ourContent)
      const theirText = this.stripBom(theirContent)
      const baseText = baseContent !== undefined ? this.stripBom(baseContent) : undefined

      const ourIsBlank = ourText.trim() === ""
      const theirIsBlank = theirText.trim() === ""

      if (ourIsBlank && theirIsBlank) {
        throw new Error("Both documents are empty")
      }

      // A side can be empty (e.g. file added on only one branch): take the other side
      const ourDocument = ourIsBlank ? undefined : parse(ourText)
      const theirDocument = theirIsBlank ? undefined : parse(theirText)

      if (ourDocument === undefined || theirDocument === undefined) {
        const survivor = ourDocument !== undefined ? ourDocument : theirDocument
        if (!this.isPlainObject(survivor)) {
          throw new Error("Expected JSON object documents")
        }
        result.packageJson = survivor as PackageJson
        result.packageConflicts = []
        result.unresolved = []
        result.resolved = true
        return result
      }

      // Empty base (e.g. file added on both branches) means "no common ancestor"
      const baseDocument = baseText !== undefined && baseText.trim() !== "" ? parse(baseText) : undefined

      if (!this.isPlainObject(ourDocument) || !this.isPlainObject(theirDocument)) {
        throw new Error("Expected JSON object documents")
      }

      if (baseDocument !== undefined && !this.isPlainObject(baseDocument)) {
        throw new Error("Expected base document to be a JSON object")
      }

      const context: MergeContext = {
        lockfile: isNpmLockfile(ourDocument) || isNpmLockfile(theirDocument),
        packagesSection: this.isPlainObject(ourDocument.packages) || this.isPlainObject(theirDocument.packages),
      }
      const merged = this.mergeValue([], baseDocument, ourDocument, theirDocument, context)
      result.conflicts = merged.conflicts
      result.packageConflicts = merged.packageConflicts ?? []
      result.unresolved = merged.unresolved ?? []
      result.packageJson = this.finalizeMergedDocument(merged.value)
      this.attachLockfileIssues(result, [ourDocument, theirDocument])
      result.resolved = true
    } catch (error) {
      result.errors.push(error instanceof Error ? error.message : String(error))
    }

    return result
  }

  /**
   * When the merged document is an npm lockfile, record the dependency edges
   * the merge left unsatisfied. Edges that were already broken in one of the
   * input documents are not reported: the merge did not cause them.
   */
  private attachLockfileIssues(result: ResolutionResult, inputs: unknown[]): void {
    const merged = result.packageJson
    if (!isNpmLockfile(merged)) {
      return
    }

    const preexisting = new Set<string>()
    for (const input of inputs) {
      if (isNpmLockfile(input)) {
        for (const issue of validateLockfile(input)) {
          preexisting.add(this.lockfileIssueKey(issue))
        }
      }
    }

    result.lockfileIssues = validateLockfile(merged).filter(issue => !preexisting.has(this.lockfileIssueKey(issue)))
  }

  private lockfileIssueKey(issue: LockfileIssue): string {
    return `${issue.from} ${issue.name} ${issue.spec}`
  }

  /**
   * Best-effort parse of each side of a conflicted document, used to tell
   * merge-introduced lockfile problems from pre-existing ones. Sides that do
   * not parse are simply skipped.
   */
  private parseConflictSides(content: string): unknown[] {
    const documents: unknown[] = []
    for (const side of ["ours", "theirs"] as const) {
      try {
        documents.push(parseJsonLenient(ConflictParser.extractConflictSide(content, side)))
      } catch {
        // Unparseable side: nothing to compare against
      }
    }
    return documents
  }

  /**
   * The merge context of a document whose sides could not be parsed, read
   * from its text since there is no parsed document to inspect.
   */
  private fallbackContext(content: string): MergeContext {
    return {
      lockfile: /"lockfileVersion"\s*:/.test(content),
      packagesSection: /"packages"\s*:\s*\{/.test(content),
    }
  }

  /**
   * Resolve a single conflict block. Throws when it cannot: the caller then
   * fails the whole resolution, rather than lose the block.
   */
  private async resolveConflict(
    conflict: ConflictMarker,
    fullContent: string,
    context: MergeContext,
    packageConflicts: PackageConflict[]
  ): Promise<ResolvedConflict> {
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
      const container = this.fallbackContainer(fieldName, ourData, theirData, fullContent, conflict.start)
      const resolved = this.resolveDependencyConflict(
        fieldName,
        ourData,
        theirData,
        container,
        context,
        packageConflicts
      )

      // Keep the raw conflict content so formatting can tell whether the
      // conflict covered the whole field or only entries inside it
      resolved.originalOurs = conflict.ours
      resolved.originalTheirs = conflict.theirs

      return resolved
    }

    // A conflict spanning several properties or structural lines (a whole
    // package-lock entry, or the version/resolved/integrity lines inside
    // one) cannot be rebuilt property by property without losing data:
    // keep one side verbatim instead.
    if (fieldName.startsWith("node_modules/") || this.isCompoundFragment(conflict)) {
      const enclosing = ConflictParser.enclosingPath(fullContent, conflict.start)
      return this.resolveFragmentVerbatim(fieldName, conflict, enclosing, context, packageConflicts)
    }

    // For simple fields, extract values directly
    const ourValue = this.extractFieldValue(conflict.ours, fieldName)
    const theirValue = this.extractFieldValue(conflict.theirs, fieldName)
    const resolved = this.resolveSimpleConflict(fieldName, ourValue, theirValue, context)

    // Store original conflict content for formatting purposes (to preserve trailing commas)
    resolved.originalOurs = conflict.ours
    resolved.originalTheirs = conflict.theirs

    return resolved
  }

  /**
   * Whether either side of a conflict holds more than a single property:
   * several `"key": value` lines, or structural lines such as `{` and `}`.
   */
  private isCompoundFragment(conflict: ConflictMarker): boolean {
    return [conflict.ours, conflict.theirs].some(side => {
      const lines = side.split("\n").filter(line => line.trim() !== "")
      const keyLines = lines.filter(line => /^\s*"(?:[^"\\]|\\.)*"\s*:/.test(line)).length
      const structuralLines = lines.filter(line => /^\s*[{}[\]],?\s*$/.test(line)).length
      return keyLines > 1 || structuralLines > 0
    })
  }

  /**
   * Resolve a multi-property conflict by taking one side as-is. A version
   * picked for the locked package the conflict covers keeps the side that
   * satisfies it; otherwise, when both sides carry a version, the strategy
   * picks the winner by version; an empty side (block deleted or added on one
   * branch only) loses to the side that still has content; otherwise the
   * strategy picks a side.
   */
  private resolveFragmentVerbatim(
    fieldName: string,
    conflict: ConflictMarker,
    enclosing: string[] | undefined,
    context: MergeContext,
    packageConflicts: PackageConflict[]
  ): ResolvedConflict {
    const ourVersion = this.fragmentVersion(conflict.ours, fieldName)
    const theirVersion = this.fragmentVersion(conflict.theirs, fieldName)
    const entry = this.fragmentEntry(conflict, fieldName, enclosing, context)
    const pick = entry !== undefined ? this.picks.get(entry.ref.name) : undefined

    // The side a picked version selects, when exactly one side satisfies it
    let pickedTheirs: boolean | undefined
    if (entry !== undefined && pick !== undefined) {
      const ourMatches = lockedVersionSatisfies(entry.ours, entry.ref.name, pick)
      const theirMatches = lockedVersionSatisfies(entry.theirs, entry.ref.name, pick)
      if (ourMatches !== theirMatches) {
        pickedTheirs = theirMatches
      }
    }

    const field = enclosing !== undefined ? enclosing.concat(fieldName).join(".") : fieldName
    // What decides when no pick does: the strategy, or keeping ours when it finds no order
    let decidedBy: string = this.options.strategy
    let winnerIsTheirs: boolean
    if (pickedTheirs !== undefined) {
      winnerIsTheirs = pickedTheirs
    } else if (ourVersion !== undefined && theirVersion !== undefined && ourVersion !== theirVersion) {
      const resolution = VersionResolver.resolveVersion(ourVersion, theirVersion, this.options.strategy)
      if (!resolution.comparable) {
        // Versions highest and lowest cannot order (a git URL and a range, say)
        if (this.leavesValuesToUser(context)) {
          context.undecided?.push({field, reason: "not-comparable"})
        }
        decidedBy = "ours"
      }
      winnerIsTheirs = resolution.resolved === theirVersion
    } else if (conflict.ours.trim() === "" || conflict.theirs.trim() === "") {
      winnerIsTheirs = conflict.ours.trim() === ""
    } else {
      // No version to go by: highest and lowest have nothing to compare
      if (this.leavesValuesToUser(context)) {
        context.undecided?.push({field, reason: "not-a-version"})
      }
      winnerIsTheirs = this.options.strategy === "theirs"
    }

    let winner = winnerIsTheirs ? conflict.theirs : conflict.ours
    const loser = winnerIsTheirs ? conflict.ours : conflict.theirs

    // More entries may follow in the surrounding JSON: keep a trailing comma
    // when the other side had one. A superfluous comma is repaired on parse.
    if (winner.trim() !== "" && !/,\s*$/.test(winner) && /,\s*$/.test(loser)) {
      winner = `${winner.replace(/\s*$/, "")},`
    }

    // As in a semantic merge, the pick decided when the entry kept satisfies it
    let resolvedBy = decidedBy
    if (entry !== undefined) {
      const kept = winnerIsTheirs ? entry.theirs : entry.ours
      if (pick !== undefined && lockedVersionSatisfies(kept, entry.ref.name, pick)) {
        resolvedBy = "pick"
      }
      if (entry.ref.listed && !isDeepStrictEqual(entry.ours, entry.theirs)) {
        packageConflicts.push(
          this.packageConflict(
            entry.ref,
            entry.path,
            {
              ours: describeLockEntry(entry.ours),
              theirs: describeLockEntry(entry.theirs),
              resolved: describeLockEntry(kept),
            },
            resolvedBy,
            pick
          )
        )
      }
    }

    const resolved: ResolvedConflict = {
      field: fieldName,
      ourValue: conflict.ours,
      theirValue: conflict.theirs,
      resolvedValue: winner,
      strategy: resolvedBy,
      verbatim: true,
      originalOurs: conflict.ours,
      originalTheirs: conflict.theirs,
    }
    if (entry !== undefined) {
      resolved.package = entry.ref.name
    }
    return resolved
  }

  /**
   * The locked package entry a block-based conflict is about, when both sides
   * have one: either the conflict declares the entry (`"node_modules/x": {`
   * among its lines, as the first entry it holds), or it sits inside the entry
   * (its lines are the entry's version/resolved/integrity fields). Mirrors how
   * fragmentVersion() finds the version that decides the conflict.
   */
  private fragmentEntry(
    conflict: ConflictMarker,
    fieldName: string,
    enclosing: string[] | undefined,
    context: MergeContext
  ): FragmentEntry | undefined {
    if (enclosing === undefined) {
      return undefined
    }

    const ourData = this.parseFragment(conflict.ours)
    const theirData = this.parseFragment(conflict.theirs)
    const declaresEntry =
      isInstallLocation(fieldName) ||
      [ourData, theirData].some(
        data => data !== undefined && typeof data.version !== "string" && this.isPlainObject(data[fieldName])
      )

    const path = declaresEntry ? enclosing.concat(fieldName) : enclosing
    const ref = packageAt(path, context)
    if (ref?.kind !== "lock") {
      return undefined
    }

    const ours = this.fragmentEntryData(ourData, fieldName)
    const theirs = this.fragmentEntryData(theirData, fieldName)
    return ours !== undefined && theirs !== undefined ? {ref, path, ours, theirs} : undefined
  }

  /** One side of a block-based conflict as an object, when it parses as one (parsePartialJson never throws) */
  private parseFragment(side: string): Record<string, any> | undefined {
    const data = side.trim() !== "" ? ConflictParser.parsePartialJson(side) : undefined
    return this.isPlainObject(data) ? data : undefined
  }

  /** The entry a parsed fragment holds: the fragment itself, or the entry it declares */
  private fragmentEntryData(data: Record<string, any> | undefined, fieldName: string): Record<string, any> | undefined {
    if (data === undefined) {
      return undefined
    }
    if (typeof data.version === "string") {
      return data
    }
    const declared = data[fieldName]
    return this.isPlainObject(declared) ? declared : undefined
  }

  /**
   * The package spec an entry of a block-based dependency conflict is, when
   * the object holding the entries is known and is a dependency field.
   */
  private specAt(
    container: string[] | undefined,
    name: string,
    context: MergeContext
  ): {ref: PackageRef; path: string[]} | undefined {
    if (container === undefined) {
      return undefined
    }
    const path = container.concat(name)
    const ref = packageAt(path, context)
    return ref?.kind === "spec" ? {ref, path} : undefined
  }

  /**
   * Path of the object whose entries a block-based dependency conflict holds:
   * the field itself when the conflict declares it, otherwise the object the
   * conflict sits in. Undefined when the surrounding structure is unclear.
   */
  private fallbackContainer(
    fieldName: string,
    ourData: any,
    theirData: any,
    fullContent: string,
    conflictStart: number
  ): string[] | undefined {
    const enclosing = ConflictParser.enclosingPath(fullContent, conflictStart)
    if (enclosing === undefined) {
      return undefined
    }
    const declared = [ourData, theirData].some(data => this.isPlainObject(data) && this.isPlainObject(data[fieldName]))
    return declared ? enclosing.concat(fieldName) : enclosing
  }

  /**
   * Extract the `version` a conflict fragment carries, either directly
   * (`"version": "1.2.3"` among its lines) or inside the single entry it
   * declares (`"node_modules/foo": { "version": "1.2.3", ... }`).
   */
  private fragmentVersion(side: string, fieldName: string): string | undefined {
    if (side.trim() === "") {
      return undefined
    }

    // parsePartialJson never throws
    const data = ConflictParser.parsePartialJson(side)
    if (!this.isPlainObject(data)) {
      return undefined
    }
    if (typeof data.version === "string") {
      return data.version
    }
    const entry = data[fieldName]
    if (this.isPlainObject(entry) && typeof entry.version === "string") {
      return entry.version
    }
    return undefined
  }

  /**
   * Resolve dependency field conflicts (dependencies, devDependencies, etc.).
   * `container` is the path of the object holding the entries, when known: it
   * tells which entries are package specs a picked version applies to.
   */
  private resolveDependencyConflict(
    fieldName: string,
    ourData: any,
    theirData: any,
    container: string[] | undefined,
    context: MergeContext,
    packageConflicts: PackageConflict[]
  ): ResolvedConflict {
    // For dependency conflicts, ourData and theirData should be the parsed dependency objects
    // But they might be individual dependency lines, so we need to handle both cases

    let ourDeps: Record<string, string> = {}
    let theirDeps: Record<string, string> = {}

    // If the data is already an object with the field name, extract it
    if (this.isPlainObject(ourData) && this.isPlainObject(ourData[fieldName])) {
      ourDeps = ourData[fieldName]
    } else if (this.isPlainObject(ourData)) {
      // If it's a direct dependency object
      ourDeps = ourData
    } else {
      // Fall back to simple resolution for non-object data
      const ourValue = typeof ourData === "object" ? JSON.stringify(ourData) : String(ourData)
      const theirValue = typeof theirData === "object" ? JSON.stringify(theirData) : String(theirData)
      return this.resolveSimpleConflict(fieldName, ourValue, theirValue, context)
    }

    if (this.isPlainObject(theirData) && this.isPlainObject(theirData[fieldName])) {
      theirDeps = theirData[fieldName]
    } else if (this.isPlainObject(theirData)) {
      theirDeps = theirData
    }

    // Merge dependencies, resolving version conflicts while preserving order
    const merged: Record<string, string> = {}
    // Entries whose values conflicted in this block, the package specs among them, and how many a pick decided
    let conflicted = 0
    const specs: string[] = []
    let picked = 0

    // First add all our dependencies in their original order
    for (const [packageName, ourVersion] of Object.entries(ourDeps)) {
      merged[packageName] = ourVersion
    }

    // Then add their dependencies that we don't have, maintaining their order
    for (const [packageName, theirVersion] of Object.entries(theirDeps)) {
      if (!(packageName in merged)) {
        merged[packageName] = theirVersion
      } else {
        // Defined, since the package is in merged
        const ourVersion = merged[packageName]
        if (ourVersion !== theirVersion) {
          // Version conflict: a picked version wins, otherwise the strategy decides...
          const spec = this.specAt(container, packageName, context)
          const pick = spec !== undefined ? this.picks.get(spec.ref.name) : undefined
          const entryPath = (container ?? [fieldName]).concat(packageName)
          const resolution =
            pick === undefined
              ? VersionResolver.resolveVersion(ourVersion as string, theirVersion as string, this.options.strategy)
              : undefined
          // ...unless highest or lowest has no order for the values: a script
          // is no version, and a git URL has no order against a range
          if (resolution !== undefined && this.leavesValuesToUser(context)) {
            let reason: UnresolvedReason | undefined
            if (!this.shouldResolveAsVersion(entryPath, ourVersion, theirVersion)) {
              reason = "not-a-version"
            } else if (!resolution.comparable) {
              reason = "not-comparable"
            }
            if (reason !== undefined) {
              context.undecided?.push({field: entryPath.join("."), reason})
              conflicted++
              continue
            }
          }
          const resolvedVersion = pick ?? (resolution as VersionResolution).resolved
          merged[packageName] = resolvedVersion
          conflicted++
          picked += pick !== undefined ? 1 : 0

          if (spec !== undefined) {
            specs.push(spec.ref.name)
            packageConflicts.push(
              this.packageConflict(
                spec.ref,
                spec.path,
                {
                  ours: this.stringifyConflictValue(ourVersion),
                  theirs: this.stringifyConflictValue(theirVersion),
                  resolved: this.stringifyConflictValue(resolvedVersion),
                },
                pick !== undefined ? "pick" : resolution?.comparable === false ? "ours" : this.options.strategy,
                pick
              )
            )
          }
        }
      }
    }

    const resolved: ResolvedConflict = {
      field: fieldName,
      ourValue: JSON.stringify(ourDeps, null, 2),
      theirValue: JSON.stringify(theirDeps, null, 2),
      resolvedValue: JSON.stringify(merged, null, 2),
      strategy: picked > 0 && picked === conflicted ? "pick" : this.options.strategy,
    }
    if (conflicted === 1 && specs.length === 1) {
      resolved.package = specs[0] as string
    }
    return resolved
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

  /** A raw JSON token as the value it stands for, or as its trimmed text when it is not valid JSON */
  private parseJsonToken(token: string): unknown {
    try {
      return JSON.parse(token.trim())
    } catch {
      return token.trim()
    }
  }

  /**
   * Whether a value both branches changed that is not a version is left for
   * the user to decide: in a package.json, with the strategies that only
   * order versions. A lockfile keeps ours, since npm regenerates it from the
   * merged package.json anyway.
   */
  private leavesValuesToUser(context: MergeContext): boolean {
    return !context.lockfile && !SIDE_STRATEGIES.has(this.options.strategy)
  }

  /** Why the block-based merge resolved nothing: the values it would have had to decide, which the strategy cannot */
  private undecidedMessage(undecided: Undecided[]): string {
    const reasons = new Map(undecided.map(entry => [entry.field, entry.reason]))
    const fields = (reason: UnresolvedReason) =>
      [...reasons].filter(([, why]) => why === reason).map(([field]) => field)
    const notVersions = fields("not-a-version")
    const notComparable = fields("not-comparable")

    const clauses: string[] = []
    if (notVersions.length > 0) {
      const verb = notVersions.length === 1 ? "is not a version" : "are not versions"
      clauses.push(`${notVersions.join(", ")} changed on both branches and ${verb}`)
    }
    if (notComparable.length > 0) {
      clauses.push(`${notComparable.join(", ")} changed on both branches to versions that cannot be compared`)
    }
    const them = reasons.size === 1 ? "it" : "them"
    return `${clauses.join(", and ")}, which the ${this.options.strategy} strategy cannot decide: resolve ${them} by hand, or with the ours or theirs strategy`
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
  private resolveSimpleConflict(
    fieldName: string,
    ourValue: string,
    theirValue: string,
    context: MergeContext
  ): ResolvedConflict {
    // Values may be raw JSON tokens; compare their unquoted forms, but keep the
    // winning raw token so string/number/boolean types survive re-serialization.
    const ourComparable = this.unquoteJsonToken(ourValue)
    const theirComparable = this.unquoteJsonToken(theirValue)

    let winnerIsTheirs: boolean
    if (fieldName === "version") {
      const resolution = VersionResolver.resolveVersion(ourComparable, theirComparable, this.options.strategy)
      if (!resolution.comparable && this.leavesValuesToUser(context)) {
        context.undecided?.push({field: fieldName, reason: "not-comparable"})
      }
      winnerIsTheirs = resolution.resolved === theirComparable && ourComparable !== theirComparable
    } else {
      const ours = this.parseJsonToken(ourValue)
      const theirs = this.parseJsonToken(theirValue)
      if (SIDE_STRATEGIES.has(this.options.strategy) || (typeof ours === "number" && typeof theirs === "number")) {
        const resolution = VersionResolver.resolveNonVersion(ours, theirs, this.options.strategy)
        winnerIsTheirs = resolution.resolved === theirs && !isDeepStrictEqual(ours, theirs)
      } else {
        // Not a version: highest and lowest cannot order it (a lockfile keeps ours; npm regenerates it)
        if (this.leavesValuesToUser(context) && !isDeepStrictEqual(ours, theirs)) {
          context.undecided?.push({field: fieldName, reason: "not-a-version"})
        }
        winnerIsTheirs = false
      }
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
    // One side taken as-is: insert it unchanged
    if (resolved.verbatim) {
      return resolved.resolvedValue
    }

    // When we couldn't determine the field, don't invent a key: keep one side verbatim
    if (resolved.field === "unknown") {
      const side = this.options.strategy === "theirs" ? resolved.originalTheirs : resolved.originalOurs
      return side !== undefined ? side : resolved.resolvedValue
    }

    if (this.isDependencyField(resolved.field) || resolved.field === "scripts") {
      // The conflict may cover the whole field (declaration line included) or
      // only entries inside it. Re-emitting the declaration in the latter case
      // would nest the field inside itself, so only wrap when the original
      // conflict content actually declared the field.
      const escapedField = resolved.field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      const declarationPattern = new RegExp(`"${escapedField}"\\s*:`)
      const conflictDeclaresField =
        (resolved.originalOurs !== undefined && declarationPattern.test(resolved.originalOurs)) ||
        (resolved.originalTheirs !== undefined && declarationPattern.test(resolved.originalTheirs)) ||
        (resolved.originalOurs === undefined && resolved.originalTheirs === undefined)

      try {
        const resolvedDeps = JSON.parse(resolved.resolvedValue)
        const lines = []

        if (conflictDeclaresField) {
          lines.push(`  ${JSON.stringify(resolved.field)}: {`)
        }

        // Add each dependency/script, JSON-escaped so quotes inside a script
        // or a non-string value cannot break the document
        const entries = Object.entries(resolvedDeps)
        for (let i = 0; i < entries.length; i++) {
          const entry = entries[i]
          if (entry) {
            const [key, value] = entry
            const isLast = i === entries.length - 1
            const comma = isLast ? "" : ","
            lines.push(`    ${JSON.stringify(key)}: ${JSON.stringify(value)}${comma}`)
          }
        }

        if (conflictDeclaresField) {
          lines.push("  }")
        } else {
          // Entries-only conflicts must preserve a trailing comma when either
          // side had one, since more entries follow in the surrounding JSON
          const originalHadTrailingComma =
            (resolved.originalOurs && resolved.originalOurs.trim().endsWith(",")) ||
            (resolved.originalTheirs && resolved.originalTheirs.trim().endsWith(","))
          const lastLine = lines[lines.length - 1]
          if (originalHadTrailingComma && lastLine) {
            lines[lines.length - 1] = `${lastLine},`
          }
        }

        return lines.join("\n")
      } catch (error) {
        // Fallback to simple formatting
        return `  ${JSON.stringify(resolved.field)}: ${this.formatJsonValue(resolved.resolvedValue)}`
      }
    }

    // For simple values, format as JSON property
    const value = this.formatJsonValue(resolved.resolvedValue)

    // Check if original content had trailing comma - if so, preserve it
    const originalHadTrailingComma =
      (resolved.originalOurs && resolved.originalOurs.trim().endsWith(",")) ||
      (resolved.originalTheirs && resolved.originalTheirs.trim().endsWith(","))

    const comma = originalHadTrailingComma ? "," : ""
    return `  ${JSON.stringify(resolved.field)}: ${value}${comma}`
  }

  /**
   * Parse fallback-resolved content. Block-based resolution can leave a
   * trailing comma before a closing brace or a missing comma between two
   * blocks (common artifacts when a conflicted side ended with or without
   * one), so parse leniently before giving up.
   */
  private parseResolvedJson(content: string): any {
    return parseJsonLenient(content)
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
   * Write a resolved document to a file, formatted like `originalContent`.
   * Values left for the user (the `unresolved` of the same resolution) are
   * written between Git conflict markers, with our value and theirs.
   */
  async writeResolvedPackage(
    packageJson: PackageJson,
    filePath: string,
    originalContent?: string,
    unresolved: UnresolvedConflict[] = []
  ): Promise<void> {
    const content = this.serializeDocument(packageJson, originalContent, unresolved)

    if (this.options.dryRun) {
      this.logger.info(`Would write resolved file to ${filePath}`)
    } else {
      await writeFile(filePath, content, "utf8")
      this.logger.success(`Wrote resolved file to ${filePath}`)
    }
  }

  /**
   * Serialize the document preserving the original file's indentation
   * (tabs, 2 or 4 spaces), line endings (LF/CRLF) and trailing newline.
   */
  private serializeDocument(
    packageJson: PackageJson,
    originalContent?: string,
    unresolved: UnresolvedConflict[] = []
  ): string {
    let indent = "  "
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

    let content =
      unresolved.length > 0
        ? stringifyWithConflicts(packageJson, indent, unresolved)
        : JSON.stringify(packageJson, null, indent)
    if (eol !== "\n") {
      content = content.replace(/\n/g, eol)
    }
    if (trailingNewline) {
      content += eol
    }

    return content
  }

  private mergeValue(
    path: string[],
    baseValue: any,
    ourValue: any,
    theirValue: any,
    context: MergeContext
  ): MergeOutcome {
    if (ourValue === undefined && theirValue === undefined) {
      return {value: undefined, conflicts: []}
    }

    // True three-way merge: a side that did not touch a value never overrides
    // the side that did, whatever the strategy says. The strategy only decides
    // real conflicts, where both sides changed the same value differently —
    // the same rule Git applies with `-X ours` / `-X theirs`.
    if (this.isUnchangedFromBase(ourValue, baseValue)) {
      return {value: theirValue, conflicts: []}
    }

    if (this.isUnchangedFromBase(theirValue, baseValue)) {
      return {value: ourValue, conflicts: []}
    }

    // One branch removed the value, and the other changed it: the base had it,
    // or the branch without it would count as unchanged above
    if (ourValue === undefined || theirValue === undefined) {
      return this.resolveRemoval(path, baseValue, ourValue, theirValue, context)
    }

    if (isDeepStrictEqual(ourValue, theirValue)) {
      return {value: ourValue, conflicts: []}
    }

    // Lockfile package entries must stay internally consistent: version,
    // resolved and integrity describe one artifact and can never be mixed
    // between sides, so entries pointing at different artifacts are resolved
    // as a whole rather than field by field.
    if (
      this.isPlainObject(ourValue) &&
      this.isPlainObject(theirValue) &&
      this.isLockEntryConflict(path, ourValue, theirValue)
    ) {
      return this.mergeLockPackageEntry(path, baseValue, ourValue, theirValue, context)
    }

    if (this.isPlainObject(ourValue) && this.isPlainObject(theirValue)) {
      return this.mergeObjectValues(path, this.asPlainObject(baseValue), ourValue, theirValue, context)
    }

    if (Array.isArray(ourValue) && Array.isArray(theirValue)) {
      return this.mergeArrayValues(path, baseValue, ourValue, theirValue, context)
    }

    return this.resolveLeafConflict(path, baseValue, ourValue, theirValue, context)
  }

  private mergeObjectValues(
    path: string[],
    baseValue: Record<string, any> | undefined,
    ourValue: Record<string, any>,
    theirValue: Record<string, any>,
    context: MergeContext
  ): MergeOutcome {
    const merged: Record<string, any> = {}
    const conflicts: ResolvedConflict[] = []
    const packageConflicts: PackageConflict[] = []
    const unresolved: UnresolvedConflict[] = []
    const keys = this.orderedUnion(Object.keys(ourValue), Object.keys(theirValue), Object.keys(baseValue || {}))

    for (const key of keys) {
      const mergedChild = this.mergeValue(path.concat(key), baseValue?.[key], ourValue[key], theirValue[key], context)
      if (mergedChild.value !== undefined) {
        merged[key] = mergedChild.value
      }
      conflicts.push(...mergedChild.conflicts)
      if (mergedChild.packageConflicts !== undefined) {
        packageConflicts.push(...mergedChild.packageConflicts)
      }
      if (mergedChild.unresolved !== undefined) {
        unresolved.push(...mergedChild.unresolved)
      }
    }

    return {value: merged, conflicts, packageConflicts, unresolved}
  }

  /**
   * Both branches changed a list: mergeValue already kept the changed side of
   * a one-sided change. A list of plain values (keywords, files, os, cpu,
   * workspaces...) merges item by item, as a set: an item either branch added
   * is kept, and an item either branch removed from the common ancestor stays
   * removed. Our order is kept, and each item they added follows the item it
   * comes after in their list (after what we added there). Items of a list of
   * objects have no identity to merge by: such a list is decided as a whole.
   */
  private mergeArrayValues(
    path: string[],
    baseValue: any,
    ourValue: any[],
    theirValue: any[],
    context: MergeContext
  ): MergeOutcome {
    if (!ourValue.every(this.isPrimitiveValue) || !theirValue.every(this.isPrimitiveValue)) {
      return this.resolveLeafConflict(path, baseValue, ourValue, theirValue, context)
    }

    // Without a common ancestor, every item is one a branch added
    const inBase = new Set(Array.isArray(baseValue) ? baseValue : [])
    const inTheirs = new Set(theirValue)
    const merged = ourValue.filter(item => !inBase.has(item) || inTheirs.has(item))

    // Where their next addition goes: after the last of their items placed so far
    let position = 0
    for (const item of theirValue) {
      const index = merged.indexOf(item)
      if (index !== -1) {
        position = Math.max(position, index + 1)
      } else if (!inBase.has(item)) {
        // Added by them: after what we added at the same place
        while (position < merged.length && !inTheirs.has(merged[position])) {
          position++
        }
        merged.splice(position, 0, item)
        position++
      }
    }

    return {value: merged, conflicts: [this.createConflictRecord(path, ourValue, theirValue, merged)]}
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
   * package-lock.json v2/v3 maps install locations to entries under
   * "packages"; every key except "" (the root project) is a package entry,
   * including bundled packages and workspace links that carry no integrity.
   */
  private isLockEntryPath(path: string[]): boolean {
    return path.length === 2 && path[0] === "packages" && path[1] !== ""
  }

  /**
   * Whether two lock entries point at different artifacts. A field missing on
   * one side is not a difference: the other side simply fills it in.
   */
  private isLockEntryConflict(path: string[], ourValue: Record<string, any>, theirValue: Record<string, any>): boolean {
    const looksLikeEntry =
      this.isLockEntryPath(path) || (this.isLockPackageEntry(ourValue) && this.isLockPackageEntry(theirValue))

    return (
      looksLikeEntry &&
      LOCK_ENTRY_IDENTITY_FIELDS.some(
        field =>
          ourValue[field] !== undefined && theirValue[field] !== undefined && ourValue[field] !== theirValue[field]
      )
    )
  }

  /**
   * Resolve a lockfile entry conflict atomically: keep the side whose version
   * wins under the strategy, with all of its correlated fields together. When
   * a version was picked for the package, the side whose locked version
   * satisfies the pick is kept instead (the strategy still decides when both
   * or neither do).
   */
  private mergeLockPackageEntry(
    path: string[],
    baseValue: any,
    ourValue: Record<string, any>,
    theirValue: Record<string, any>,
    context: MergeContext
  ): MergeOutcome {
    let winner: Record<string, any>
    // What decides when no pick does: the strategy, or keeping ours when it finds no order
    let decidedBy: string = this.options.strategy

    if (
      typeof ourValue.version === "string" &&
      typeof theirValue.version === "string" &&
      ourValue.version !== theirValue.version
    ) {
      const resolution = VersionResolver.resolveVersion(ourValue.version, theirValue.version, this.options.strategy)
      winner = resolution.resolved === theirValue.version ? theirValue : ourValue
      if (!resolution.comparable) {
        decidedBy = "ours"
      }
    } else {
      // Same version but a different artifact (another git commit, registry
      // mirror or integrity algorithm): there is no "higher" side, so keep
      // ours unless the strategy explicitly asks for theirs.
      winner = this.options.strategy === "theirs" ? theirValue : ourValue
    }

    const found = packageAt(path, context)
    const ref = found?.kind === "lock" ? found : undefined
    const pick = ref !== undefined ? this.picks.get(ref.name) : undefined
    let resolvedBy = decidedBy
    if (ref !== undefined && pick !== undefined) {
      const ourMatches = lockedVersionSatisfies(ourValue, ref.name, pick)
      const theirMatches = lockedVersionSatisfies(theirValue, ref.name, pick)
      if (ourMatches !== theirMatches) {
        winner = ourMatches ? ourValue : theirValue
      }
      if (ourMatches || theirMatches) {
        resolvedBy = "pick"
      }
    }

    const outcome: MergeOutcome = {
      value: winner,
      conflicts: [this.createConflictRecord(path, ourValue, theirValue, winner, resolvedBy, ref?.name)],
    }
    if (ref?.listed) {
      outcome.packageConflicts = [
        this.packageConflict(
          ref,
          path,
          {
            base: this.isPlainObject(baseValue) ? describeLockEntry(baseValue) : undefined,
            ours: describeLockEntry(ourValue),
            theirs: describeLockEntry(theirValue),
            resolved: describeLockEntry(winner),
          },
          resolvedBy,
          pick
        ),
      ]
    }
    return outcome
  }

  /**
   * Resolve a conflict on a single value. A version picked for the package
   * whose spec the value is wins; otherwise the strategy decides. Highest and
   * lowest only order versions (and numbers): a value of a package.json they
   * have no order for, such as a script or a git URL against a range, is left
   * for the user to decide, while a lockfile keeps ours, since npm regenerates
   * it from package.json anyway.
   */
  private resolveLeafConflict(
    path: string[],
    baseValue: any,
    ourValue: any,
    theirValue: any,
    context: MergeContext
  ): MergeOutcome {
    const found = packageAt(path, context)
    const ref = found?.kind === "spec" ? found : undefined
    const pick = ref !== undefined ? this.picks.get(ref.name) : undefined

    let resolved: any
    let resolvedBy: string = this.options.strategy
    if (pick !== undefined) {
      resolved = pick
      resolvedBy = "pick"
    } else if (this.shouldResolveAsVersion(path, ourValue, theirValue)) {
      const resolution = VersionResolver.resolveVersion(ourValue, theirValue, this.options.strategy)
      if (!resolution.comparable) {
        if (this.leavesValuesToUser(context)) {
          return this.leaveToUser(path, ref, "not-comparable", baseValue, ourValue, theirValue)
        }
        resolvedBy = "ours"
      }
      resolved = resolution.resolved
    } else if (
      SIDE_STRATEGIES.has(this.options.strategy) ||
      (typeof ourValue === "number" && typeof theirValue === "number")
    ) {
      resolved = VersionResolver.resolveNonVersion(ourValue, theirValue, this.options.strategy).resolved
    } else if (this.leavesValuesToUser(context)) {
      return this.leaveToUser(path, ref, "not-a-version", baseValue, ourValue, theirValue)
    } else {
      resolved = ourValue
      resolvedBy = "ours"
    }

    return this.decided(path, ref, {base: baseValue, ours: ourValue, theirs: theirValue, resolved}, resolvedBy, pick)
  }

  /**
   * One branch removed a value that the other changed. A version picked for
   * the package keeps it, at the picked version (for a locked install: when
   * the changed entry is that version). Ours and theirs take their side, the
   * removal included. With highest and lowest:
   * - a dependency stays removed (resolvedBy "removal"), in a package.json and
   *   in the specs of a lockfile's root and workspace entries alike: changing
   *   its version says which version to use, not that it is still needed;
   * - an installed entry of a lockfile keeps the changed side, in case another
   *   package still needs it: npm prunes it when it regenerates the lockfile
   *   if nothing does;
   * - any other value of a package.json is left for the user to decide, while
   *   a lockfile keeps the changed value.
   */
  private resolveRemoval(
    path: string[],
    baseValue: any,
    ourValue: any,
    theirValue: any,
    context: MergeContext
  ): MergeOutcome {
    const ref = packageAt(path, context)
    const pick = ref !== undefined ? this.picks.get(ref.name) : undefined
    const weRemoved = ourValue === undefined
    const changed = weRemoved ? theirValue : ourValue

    let resolved: any
    let resolvedBy: string = this.options.strategy
    if (pick !== undefined && ref?.kind === "spec") {
      resolved = pick
      resolvedBy = "pick"
    } else if (
      pick !== undefined &&
      ref?.kind === "lock" &&
      this.isPlainObject(changed) &&
      lockedVersionSatisfies(changed, ref.name, pick)
    ) {
      resolved = changed
      resolvedBy = "pick"
    } else if (SIDE_STRATEGIES.has(this.options.strategy)) {
      resolved = this.options.strategy === "theirs" ? theirValue : ourValue
    } else if (ref?.kind === "spec") {
      resolved = undefined
      resolvedBy = "removal"
    } else if (this.leavesValuesToUser(context)) {
      return this.leaveToUser(path, ref, "removed", baseValue, ourValue, theirValue)
    } else {
      resolved = changed
      resolvedBy = weRemoved ? "theirs" : "ours"
    }

    return this.decided(path, ref, {base: baseValue, ours: ourValue, theirs: theirValue, resolved}, resolvedBy, pick)
  }

  /**
   * A conflict that was decided: the value kept (undefined when removed), its
   * record, and its package conflict when it is about a listed package.
   */
  private decided(
    path: string[],
    ref: PackageRef | undefined,
    values: ConflictValues,
    resolvedBy: string,
    pick: string | undefined
  ): MergeOutcome {
    const outcome: MergeOutcome = {
      value: values.resolved,
      conflicts: [this.createConflictRecord(path, values.ours, values.theirs, values.resolved, resolvedBy, ref?.name)],
    }
    if (ref?.listed) {
      outcome.packageConflicts = [this.packageConflict(ref, path, this.describeValues(ref, values), resolvedBy, pick)]
    }
    return outcome
  }

  /**
   * A conflict left for the user to decide: the merged document holds our
   * value in its place (nothing, when we removed it). A package spec is still
   * listed among the package conflicts, so that a version can be picked for it.
   */
  private leaveToUser(
    path: string[],
    ref: PackageRef | undefined,
    reason: UnresolvedReason,
    baseValue: any,
    ourValue: any,
    theirValue: any
  ): MergeOutcome {
    const unresolved: UnresolvedConflict = {
      field: this.formatPath(path),
      path,
      reason,
      ours: ourValue,
      theirs: theirValue,
    }
    if (baseValue !== undefined) {
      unresolved.base = baseValue
    }

    const outcome: MergeOutcome = {value: ourValue, conflicts: [], unresolved: [unresolved]}
    if (ref?.listed) {
      const values = {base: baseValue, ours: ourValue, theirs: theirValue, resolved: undefined}
      outcome.packageConflicts = [this.packageConflict(ref, path, this.describeValues(ref, values), "user", undefined)]
    }
    return outcome
  }

  /** How the values of a conflict on a package are shown: null where there is none */
  private describeValues(
    ref: PackageRef,
    values: ConflictValues
  ): {base?: string; ours: string | null; theirs: string | null; resolved: string | null} {
    const describe = (value: any): string | null => {
      if (value === undefined) {
        return null
      }
      return ref.kind === "lock" && this.isPlainObject(value)
        ? describeLockEntry(value)
        : this.stringifyConflictValue(value)
    }
    const base = describe(values.base)
    return {
      ...(base !== null ? {base} : {}),
      ours: describe(values.ours),
      theirs: describe(values.theirs),
      resolved: describe(values.resolved),
    }
  }

  private createConflictRecord(
    path: string[],
    ourValue: any,
    theirValue: any,
    resolvedValue: any,
    strategy: string = this.options.strategy,
    packageName?: string
  ): ResolvedConflict {
    const record: ResolvedConflict = {
      field: this.formatPath(path),
      ourValue: this.stringifyConflictValue(ourValue),
      theirValue: this.stringifyConflictValue(theirValue),
      resolvedValue: this.stringifyConflictValue(resolvedValue),
      strategy,
    }
    if (packageName !== undefined) {
      record.package = packageName
    }
    return record
  }

  /** A package conflict record, with the optional fields only when they are known */
  private packageConflict(
    ref: PackageRef,
    path: string[],
    values: {base?: string | undefined; ours: string | null; theirs: string | null; resolved: string | null},
    resolvedBy: string,
    pick: string | undefined
  ): PackageConflict {
    return {
      name: ref.name,
      kind: ref.kind,
      location: ref.location,
      path,
      ours: values.ours,
      theirs: values.theirs,
      ...(values.base !== undefined ? {base: values.base} : {}),
      resolved: values.resolved,
      resolvedBy,
      ...(pick !== undefined ? {pick} : {}),
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

  /**
   * Whether two conflicting strings are version specs: the "version" field
   * itself, a corepack "packageManager" spec, or any entry of a field that
   * maps package names to ranges (dependencies, engines, requires, ...).
   */
  private shouldResolveAsVersion(path: string[], ourValue: any, theirValue: any): boolean {
    if (typeof ourValue !== "string" || typeof theirValue !== "string") {
      return false
    }

    const currentKey = path[path.length - 1]
    const parentKey = path[path.length - 2]

    if (currentKey === "version" || currentKey === "packageManager") {
      return true
    }

    if (parentKey !== undefined && VERSION_SPEC_PARENT_FIELDS.has(parentKey)) {
      return true
    }

    // Anywhere inside an overrides/resolutions subtree. The current key itself
    // is excluded so a field that merely shares the name (a script called
    // "overrides", say) is not mistaken for a spec.
    return path.slice(0, -1).some(segment => VERSION_SPEC_SUBTREE_FIELDS.has(segment))
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
