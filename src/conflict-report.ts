/**
 * The report `--list` prints: the conflicted packages of each file with our,
 * their and (when known) the common ancestor's version, and the version the
 * resolution keeps — chosen by the strategy, or picked with `--pick` — or
 * that it leaves for the user to decide.
 */

import {PackageConflict, ResolutionResult, ResolvedConflict, UnresolvedConflict, UnresolvedReason} from "./types.js"

/** A conflict on something other than a package version ("version", "scripts.test", ...) */
export interface OtherConflict {
  field: string
  ours: string
  theirs: string
  resolved: string
}

/** A value resolving leaves for the user to decide (see UnresolvedConflict) */
export interface UnresolvedField {
  field: string
  /** JSON path of the value */
  path: string[]
  /** Why the strategy does not decide it */
  reason: UnresolvedReason
  /** Our value (a string as it is, anything else as JSON): null when our branch removed it */
  ours: string | null
  /** Their value: null when their branch removed it */
  theirs: string | null
  /** The common ancestor's value, when it is known and had one */
  base?: string
}

export interface ConflictReportFile {
  /** The file, as the user named it */
  file: string
  /** Whether the file's conflicts could be analyzed */
  analyzed: boolean
  /** Conflicted package versions, sorted by package name */
  packages: PackageConflict[]
  /** Every other conflict, resolved by the strategy */
  otherConflicts: OtherConflict[]
  /**
   * Values the strategy cannot decide: resolving leaves them between conflict
   * markers for the user. Package specs among them are in `packages` too.
   */
  unresolved: UnresolvedField[]
  /** Why the file could not be analyzed */
  reason?: string
}

export interface ConflictReport {
  /** The strategy that decides every conflict no version was picked for */
  strategy: string
  files: ConflictReportFile[]
}

const DEPENDENCY_FIELDS = new Set(["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"])

/** Longest value shown in the "Also conflicted" summary */
const MAX_SUMMARY_VALUE = 40

/** How the table shows a value a branch removed */
const REMOVED = "(removed)"

/**
 * The report entry for a file from the result of resolving its conflicts.
 */
export function reportFile(file: string, result: ResolutionResult): ConflictReportFile {
  if (!result.resolved) {
    return {file, analyzed: false, packages: [], otherConflicts: [], unresolved: [], reason: result.errors.join(", ")}
  }

  return {
    file,
    analyzed: true,
    packages: [...(result.packageConflicts ?? [])].sort(comparePackageConflicts),
    otherConflicts: result.conflicts.filter(isOtherConflict).map(conflict => ({
      field: conflict.field,
      ours: conflict.ourValue,
      theirs: conflict.theirValue,
      resolved: conflict.resolvedValue,
    })),
    unresolved: (result.unresolved ?? []).map(unresolvedField),
  }
}

/** How a value left for the user is reported: its values as strings, null for a side that removed it */
export function unresolvedField(conflict: UnresolvedConflict): UnresolvedField {
  return {
    field: conflict.field,
    path: conflict.path,
    reason: conflict.reason,
    ours: conflict.ours === undefined ? null : describeValue(conflict.ours),
    theirs: conflict.theirs === undefined ? null : describeValue(conflict.theirs),
    ...(conflict.base !== undefined ? {base: describeValue(conflict.base)} : {}),
  }
}

/** A value as the report shows it: a string as it is, anything else as JSON */
function describeValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value)
}

/**
 * The report entry for a conflicted file this tool does not analyze (yarn,
 * pnpm and bun lockfiles, which their package manager resolves).
 */
export function unanalyzedFile(file: string, reason: string): ConflictReportFile {
  return {file, analyzed: false, packages: [], otherConflicts: [], unresolved: [], reason}
}

/**
 * Conflicts that are not about a package version. Block-based (fallback)
 * conflicts on a whole dependency field or on lockfile entries are about
 * package versions even when they cover several packages at once.
 */
function isOtherConflict(conflict: ResolvedConflict): boolean {
  return (
    conflict.package === undefined &&
    !DEPENDENCY_FIELDS.has(conflict.field) &&
    !/(?:^|[./])node_modules\//.test(conflict.field)
  )
}

/** Declared specs are listed before the locked installs of the same package */
const KIND_ORDER: Record<PackageConflict["kind"], number> = {spec: 0, lock: 1}

/** By package name, then kind, then location */
function comparePackageConflicts(a: PackageConflict, b: PackageConflict): number {
  return compareText(a.name, b.name) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || compareText(a.location, b.location)
}

/** Locale-independent ordering, so the report reads the same on every machine */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * The human-readable report, one string per line.
 */
export function formatConflictReport(report: ConflictReport): string[] {
  const lines: string[] = []

  if (report.files.length === 0) {
    return ["✅ No conflicted packages: no file has Git conflict markers"]
  }

  for (const file of report.files) {
    if (!file.analyzed) {
      lines.push(`⚠️  ${file.file} has conflicts that could not be analyzed: ${file.reason}`, "")
      continue
    }

    // A package can conflict in several places (a spec and its locked install): count it once
    const count = new Set(file.packages.map(conflict => conflict.name)).size
    const summary =
      count === 0
        ? "no conflicted packages"
        : `${count} conflicted package${count === 1 ? "" : "s"} (strategy: ${report.strategy})`
    lines.push(`📋 ${file.file}: ${summary}`)

    if (file.packages.length > 0) {
      lines.push("", ...formatTable(file.packages).map(line => `   ${line}`))
    }
    if (file.otherConflicts.length > 0) {
      const others = file.otherConflicts.map(
        conflict =>
          `${displayField(conflict.field)} (ours ${shorten(conflict.ours)}, theirs ${shorten(conflict.theirs)} → ${shorten(conflict.resolved)})`
      )
      lines.push("", `   Also conflicted: ${others.join(", ")}`)
    }
    // The package specs among them are in the table already
    const inTable = new Set(file.packages.map(conflict => pathKey(conflict.path)))
    const open = file.unresolved.filter(conflict => !inTable.has(pathKey(conflict.path)))
    if (open.length > 0) {
      const side = (value: string | null) => (value === null ? "removed" : shorten(value))
      const fields = open.map(
        conflict => `${conflict.field} (ours ${side(conflict.ours)}, theirs ${side(conflict.theirs)})`
      )
      lines.push("", `   Left for you to decide: ${fields.join(", ")}`)
    }
    lines.push("")
  }

  const packages = report.files.flatMap(file => file.packages)
  // Preferably a package left for the user, or one that stays removed: a pick decides it, or keeps it
  const example =
    packages.find(conflict => conflict.resolvedBy === "user") ??
    packages.find(conflict => conflict.resolvedBy === "removal") ??
    packages.find(conflict => conflict.kind === "spec") ??
    packages[0]
  const exampleVersion = example !== undefined ? (example.theirs ?? example.ours) : null
  if (example !== undefined && exampleVersion !== null && !packages.some(conflict => conflict.pick !== undefined)) {
    lines.push(
      `Choose the version of a package with --pick <name>@<version>, for example --pick ${example.name}@${exampleVersion}`
    )
  }
  if (packages.some(conflict => conflict.resolvedBy === "removal")) {
    lines.push(
      "A dependency one branch removed stays removed, without the other branch's change: pick a version to keep it"
    )
  }
  if (report.files.some(file => file.unresolved.length > 0)) {
    lines.push(
      "Values left for you to decide stay between conflict markers when resolving, unless you use --strategy ours or --strategy theirs (or --pick, for a package)"
    )
  }

  return lines
}

function pathKey(path: string[]): string {
  return JSON.stringify(path)
}

function formatTable(packages: PackageConflict[]): string[] {
  const showBase = packages.some(conflict => conflict.base !== undefined)
  const header = ["Package", "Where", "Ours", "Theirs", ...(showBase ? ["Base"] : []), "Resolved"]
  const rows = packages.map(conflict => [
    conflict.name,
    conflict.location,
    conflict.ours ?? REMOVED,
    conflict.theirs ?? REMOVED,
    ...(showBase ? [conflict.base ?? "-"] : []),
    resolution(conflict),
  ])

  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map(row => (row[column] as string).length))
  )
  const render = (cells: string[]) =>
    cells.map((cell, column) => (column === cells.length - 1 ? cell : cell.padEnd(widths[column] as number))).join("  ")

  return [render(header), ...rows.map(render)]
}

/** The resolved value, marked when a pick chose it or could not be applied, or when the user decides */
function resolution(conflict: PackageConflict): string {
  if (conflict.resolvedBy === "user") {
    return "(left for you)"
  }
  const resolved = conflict.resolved ?? REMOVED
  if (conflict.resolvedBy === "pick") {
    return `${resolved} (picked)`
  }
  if (conflict.pick !== undefined) {
    return `${resolved} (${conflict.pick} is on neither side)`
  }
  return resolved
}

/**
 * A conflict's field as people read it: the lockfile's root entry (the empty
 * key under "packages", which joins into "packages..") is "root", as in the
 * Where column.
 */
function displayField(field: string): string {
  return field.startsWith("packages..") ? `root › ${field.slice("packages..".length)}` : field
}

function shorten(value: string): string {
  return value.length > MAX_SUMMARY_VALUE ? `${value.slice(0, MAX_SUMMARY_VALUE - 1)}…` : value
}
