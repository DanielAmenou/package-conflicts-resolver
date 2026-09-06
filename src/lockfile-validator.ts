/**
 * Consistency check for merged npm lockfiles.
 *
 * Merging two lockfiles entry by entry can produce a document that is valid
 * JSON but describes an impossible dependency graph: the root may require
 * `foo@1.2.0` while `node_modules/foo` is locked at 1.5.0, or the winning
 * version of a package may need a transitive dependency that only the losing
 * side carried. `npm ci` rejects such lockfiles ("package.json and
 * package-lock.json are not in sync"), so every merged lockfile is checked
 * here and callers decide whether to regenerate it or leave it conflicted.
 *
 * The check walks every dependency edge in `packages` (lockfile v2/v3) using
 * Node's resolution order — the dependent's own node_modules first, then each
 * parent folder's — follows workspace symlinks, understands `npm:` aliases and
 * skips specs that are not semver ranges (git URLs, file: paths, dist-tags).
 * Lockfile v1 files (npm 6) have no `packages` section and are not checked.
 */

import * as semver from "semver"
import {LockfileIssue} from "./types.js"

/** Fields of a lockfile entry that declare dependency edges npm will install */
const EDGE_FIELDS = ["dependencies", "devDependencies", "optionalDependencies"] as const

/** Fields of the root package.json that declare dependency edges npm will install */
const ROOT_EDGE_FIELDS = ["dependencies", "devDependencies", "optionalDependencies"] as const

interface ResolvedEntry {
  location: string
  entry: Record<string, any>
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/**
 * Whether a parsed JSON document is an npm lockfile (package-lock.json or
 * npm-shrinkwrap.json) rather than a package.json.
 */
export function isNpmLockfile(document: unknown): document is Record<string, any> {
  return (
    isPlainObject(document) &&
    typeof document.lockfileVersion === "number" &&
    (isPlainObject(document.packages) || isPlainObject(document.dependencies))
  )
}

/**
 * Turn a dependency spec into a semver range, or null when the spec cannot be
 * checked against a version (git URLs, file: paths, dist-tags, workspace:
 * protocol, ...). `npm:` aliases return the aliased package name as well.
 */
function parseSpec(spec: string): {range: string; alias?: string} | null {
  let text = spec.trim()
  let alias: string | undefined

  if (text.startsWith("npm:")) {
    const target = text.slice("npm:".length)
    // "npm:@scope/name@^1.0.0" — the version separator is the last "@"
    const separator = target.lastIndexOf("@")
    if (separator > 0) {
      alias = target.slice(0, separator)
      text = target.slice(separator + 1)
    } else {
      alias = target
      text = "*"
    }
  }

  if (text === "") {
    text = "*"
  }

  const range = semver.validRange(text, {includePrerelease: true})
  if (range === null) {
    return null
  }

  return alias !== undefined ? {range, alias} : {range}
}

/**
 * Parent folder in Node's module resolution order:
 *   node_modules/a/node_modules/b -> node_modules/a
 *   node_modules/a                -> "" (root)
 *   packages/workspace            -> "" (root)
 */
function parentLocation(location: string): string {
  const index = location.lastIndexOf("/node_modules/")
  return index >= 0 ? location.slice(0, index) : ""
}

/**
 * Find the entry that `name` resolves to when required from `from`, following
 * Node's lookup order and workspace symlinks (`link: true` entries).
 */
export function resolveLockfileDependency(
  packages: Record<string, any>,
  from: string,
  name: string
): ResolvedEntry | null {
  let location = from

  for (;;) {
    const candidate = location === "" ? `node_modules/${name}` : `${location}/node_modules/${name}`
    const entry = packages[candidate]

    if (isPlainObject(entry)) {
      if (entry.link === true) {
        const target = typeof entry.resolved === "string" ? packages[entry.resolved] : undefined
        return isPlainObject(target) ? {location: entry.resolved, entry: target} : {location: candidate, entry}
      }
      return {location: candidate, entry}
    }

    if (location === "") {
      return null
    }
    location = parentLocation(location)
  }
}

function describe(from: string): string {
  return from === "" ? "the root project" : from
}

function checkEdge(
  packages: Record<string, any>,
  from: string,
  name: string,
  spec: string,
  optional: boolean
): LockfileIssue | null {
  const parsed = parseSpec(spec)
  if (parsed === null) {
    return null // not a semver spec: nothing to compare against
  }

  const target = resolveLockfileDependency(packages, from, name)
  if (target === null) {
    if (optional) {
      return null // optional dependencies may legitimately be absent
    }
    return {
      from,
      name,
      spec,
      kind: "missing",
      message: `${describe(from)} requires ${name}@${spec} but no entry for it exists`,
    }
  }

  const version = target.entry.version
  if (typeof version !== "string" || semver.valid(version) === null) {
    return null // links without a version, bundled placeholders, ...: cannot judge
  }

  if (parsed.alias !== undefined && typeof target.entry.name === "string" && target.entry.name !== parsed.alias) {
    return {
      from,
      name,
      spec,
      resolvedPath: target.location,
      version,
      kind: "invalid",
      message: `${describe(from)} requires ${name}@${spec} but ${target.location} is ${target.entry.name}@${version}`,
    }
  }

  if (!semver.satisfies(version, parsed.range, {includePrerelease: true})) {
    return {
      from,
      name,
      spec,
      resolvedPath: target.location,
      version,
      kind: "invalid",
      message: `${describe(from)} requires ${name}@${spec} but ${target.location} is ${version}`,
    }
  }

  return null
}

/**
 * Report every dependency edge of an npm lockfile that its locked versions do
 * not satisfy. When the project's package.json is given, the root's edges are
 * taken from it (the source of truth `npm ci` compares against) instead of
 * from the lockfile's own root entry.
 *
 * Returns an empty list for lockfiles without a `packages` section
 * (lockfileVersion 1), which cannot be checked.
 */
export function validateLockfile(lockfile: Record<string, any>, packageJson?: Record<string, any>): LockfileIssue[] {
  const packages = lockfile.packages
  if (!isPlainObject(packages)) {
    return []
  }

  const issues: LockfileIssue[] = []

  for (const [location, entry] of Object.entries(packages)) {
    if (!isPlainObject(entry) || entry.link === true || entry.extraneous === true) {
      continue
    }

    const isRoot = location === ""
    const source = isRoot && isPlainObject(packageJson) ? packageJson : entry
    const fields = isRoot ? ROOT_EDGE_FIELDS : EDGE_FIELDS

    for (const field of fields) {
      const declared = source[field]
      if (!isPlainObject(declared)) {
        continue
      }

      for (const [name, spec] of Object.entries(declared)) {
        if (typeof spec !== "string") {
          continue
        }
        const issue = checkEdge(packages, location, name, spec, field === "optionalDependencies")
        if (issue) {
          issues.push(issue)
        }
      }
    }
  }

  return issues
}

/**
 * Human-readable one-line descriptions, capped so a badly broken lockfile does
 * not flood the terminal.
 */
export function formatLockfileIssues(issues: LockfileIssue[], limit: number = 10): string[] {
  const lines = issues.slice(0, limit).map(issue => issue.message)
  if (issues.length > limit) {
    lines.push(`... and ${issues.length - limit} more`)
  }
  return lines
}
