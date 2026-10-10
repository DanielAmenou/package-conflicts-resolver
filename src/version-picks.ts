/**
 * Versions picked by the user for specific conflicted packages
 * (`--pick lodash@4.17.21`).
 *
 * A pick replaces the resolution strategy for one package:
 * - a conflict on a dependency spec of the package (package.json, and the
 *   root and workspace entries of a lockfile) resolves to the picked spec,
 *   written exactly as given;
 * - a conflict on an installed entry of the package in an npm lockfile keeps
 *   the side whose locked version satisfies the pick.
 * Every other conflict is still decided by the strategy.
 *
 * Picks are checked before anything is written: their syntax here, whether
 * each picked package is conflicted at all (findPickProblems), and whether the
 * picked version exists (verifyVersionPicks).
 */

import {access} from "fs/promises"
import {homedir} from "node:os"
import {resolve} from "node:path"
import {maxSatisfying, satisfies, valid, validRange} from "semver"
import type {PackageVersionLookup, PackageVersions} from "./registry.js"
import {PackageConflict} from "./types.js"

export interface VersionPick {
  name: string
  spec: string
}

/**
 * - "version": an exact version ("4.17.21")
 * - "range": a semver range ("^4.17.0", "1.x", ">=2 <3")
 * - "alias": an npm alias ("npm:lodash@^4.17.0")
 * - "tag": a dist-tag ("latest", "next")
 * - "file": a local folder or tarball ("file:../lib", "link:../lib", "./lib")
 * - "git": a git repository ("github:user/repo#v1", "git+ssh://...", "user/repo")
 * - "url": a tarball URL ("https://example.com/pkg.tgz")
 * - "protocol": another package manager's protocol ("workspace:*", "catalog:", "portal:../lib")
 */
export type VersionSpecType = "version" | "range" | "alias" | "tag" | "file" | "git" | "url" | "protocol"

export interface VersionSpec {
  type: VersionSpecType
  /** For "version", "range" and an "alias" with a version: the range versions are checked against */
  range?: string
  /** For "alias": the aliased package */
  target?: string
  /** For "file": the local path */
  path?: string
}

/** npm package names: an optional @scope/, then URL-safe characters (legacy names may use uppercase) */
const PACKAGE_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i
const MAX_NAME_LENGTH = 214

const FILE_PROTOCOL = /^(?:file|link):/i
const LOCAL_PATH = /^(?:\.{1,2}(?:[\\/]|$)|~[\\/]|[\\/]|[a-zA-Z]:[\\/])/
const URL_PROTOCOL = /^https?:\/\//i
const GIT_PROTOCOL = /^(?:git\+[a-z]+:|git:|github:|gitlab:|bitbucket:|gist:)/i
/** scp-like git address: git@github.com:user/repo.git */
const GIT_SCP = /^[^@\s/]+@[^:\s/]+:\S+$/
/** GitHub shortcut: user/repo, user/repo#ref */
const GIT_SHORTCUT = /^[^@\s:/][^\s:/]*\/[^\s:/#]+(?:#\S*)?$/
const OTHER_PROTOCOL = /^[a-z][a-z0-9+.-]*:/i
/** What an invalid version or range starts with, as opposed to a dist-tag */
const VERSION_LIKE = /^(?:[0-9=<>~^]|v[0-9])/

export function isValidPackageName(name: string): boolean {
  return name.length <= MAX_NAME_LENGTH && PACKAGE_NAME.test(name)
}

/**
 * Split "name@spec" at the "@" that follows the name, so scoped names
 * ("@types/node@20") and alias specs ("my-lodash@npm:lodash@4") split right.
 * The spec is undefined when there is no "@" after the name.
 */
function splitNameAndSpec(text: string): {name: string; spec?: string} {
  const at = text.indexOf("@", text.startsWith("@") ? 1 : 0)
  return at === -1 ? {name: text} : {name: text.slice(0, at), spec: text.slice(at + 1)}
}

/**
 * What kind of dependency spec a string is, or null when it is none.
 * Follows npm's rules closely enough to tell registry versions, which can be
 * checked, from everything else.
 */
export function classifyVersionSpec(spec: string): VersionSpec | null {
  const text = spec.trim()
  if (text === "") {
    return null
  }

  if (text.startsWith("npm:")) {
    return classifyAlias(text.slice("npm:".length))
  }
  if (FILE_PROTOCOL.test(text)) {
    return {type: "file", path: text.replace(FILE_PROTOCOL, "")}
  }
  if (LOCAL_PATH.test(text)) {
    return {type: "file", path: text}
  }
  if (URL_PROTOCOL.test(text)) {
    return {type: "url"}
  }
  if (GIT_PROTOCOL.test(text) || GIT_SCP.test(text) || GIT_SHORTCUT.test(text)) {
    return {type: "git"}
  }
  if (OTHER_PROTOCOL.test(text)) {
    return {type: "protocol"}
  }
  // Strict parsing: loose ranges silently drop what they do not understand ("1.2.3 oops" is "1.2.3")
  if (valid(text) !== null) {
    return {type: "version", range: text}
  }
  if (validRange(text) !== null) {
    return {type: "range", range: text}
  }
  // A tag never looks like a version, and npm rejects tags that need escaping in a URL
  return !VERSION_LIKE.test(text) && encodeURIComponent(text) === text ? {type: "tag"} : null
}

/** "npm:<name>@<version or range>": only registry versions can be aliased */
function classifyAlias(target: string): VersionSpec | null {
  const {name, spec} = splitNameAndSpec(target)
  if (!isValidPackageName(name)) {
    return null
  }
  if (spec === undefined || spec.trim() === "") {
    return {type: "alias", target: name}
  }
  const inner = classifyVersionSpec(spec)
  if (inner?.type === "version" || inner?.type === "range") {
    return {type: "alias", target: name, range: inner.range as string}
  }
  return inner?.type === "tag" ? {type: "alias", target: name} : null
}

/**
 * Parse one `--pick` value: "<name>@<version or range>". Throws an Error that
 * explains what is wrong with it.
 *
 * Versions, ranges and npm aliases are accepted, as are file:, git, URL and
 * other protocol specs. Dist-tags are not: "latest" says nothing about which
 * version gets installed, so it cannot select a locked version.
 */
export function parseVersionPick(input: string): VersionPick {
  const text = input.trim()
  const {name, spec} = splitNameAndSpec(text)

  if (spec === undefined) {
    return fail(`"${input}" is not <name>@<version> (for example lodash@4.17.21)`)
  }
  if (!isValidPackageName(name)) {
    return fail(`"${name}" is not a valid package name`)
  }
  const version = spec.trim()
  if (version === "") {
    return fail(`"${input}" has no version after the "@" (for example ${name}@1.2.3)`)
  }

  const classified = classifyVersionSpec(version)
  if (classified === null) {
    return fail(`${name}@${version}: "${version}" is not a valid version or range`)
  }
  if (classified.type === "tag") {
    return fail(
      `${name}@${version}: "${version}" is a dist-tag; pick a version or a range instead (for example ${name}@1.2.3 or ${name}@^1.2.3)`
    )
  }
  if (classified.type === "alias" && classified.range === undefined) {
    return fail(
      `${name}@${version}: an npm: alias needs a version or a range (for example ${name}@npm:${classified.target}@1.2.3)`
    )
  }

  return {name, spec: version}
}

function fail(message: string): never {
  throw new Error(message)
}

/**
 * Parse every `--pick` value. Picking the same version twice is fine; picking
 * two different versions for one package is an error. All problems are
 * collected so they can be reported together.
 */
export function parseVersionPicks(inputs: readonly string[]): {picks: Record<string, string>; errors: string[]} {
  const picks = new Map<string, string>()
  const errors: string[] = []

  for (const input of inputs) {
    let pick: VersionPick
    try {
      pick = parseVersionPick(input)
    } catch (error) {
      errors.push((error as Error).message)
      continue
    }

    const previous = picks.get(pick.name)
    if (previous !== undefined && previous !== pick.spec) {
      errors.push(`${pick.name} is picked twice, as ${previous} and as ${pick.spec}`)
      continue
    }
    picks.set(pick.name, pick.spec)
  }

  return {picks: Object.fromEntries(picks), errors}
}

/**
 * Validate picks handed to the API (package name -> spec) with the same rules
 * as `--pick`. Throws on the first invalid pick.
 */
export function normalizeVersionPicks(picks: Readonly<Record<string, string>> | undefined): Map<string, string> {
  const normalized = new Map<string, string>()

  for (const [name, spec] of Object.entries(picks ?? {})) {
    if (!isValidPackageName(name)) {
      throw new Error(`"${name}" is not a valid package name`)
    }
    if (typeof spec !== "string") {
      throw new TypeError(`The version picked for ${name} must be a string`)
    }
    // A valid name has no "@" past its scope, so this splits back into name and spec
    normalized.set(name, parseVersionPick(`${name}@${spec}`).spec)
  }

  return normalized
}

/**
 * Whether an installed lockfile entry satisfies a picked spec: its locked
 * version matches the picked version or range, and it installs the package
 * the pick means — the aliased package for an npm: alias, the package itself
 * otherwise. File, git, URL and protocol specs cannot be matched to a locked
 * version.
 */
export function lockedVersionSatisfies(entry: Record<string, any>, packageName: string, spec: string): boolean {
  const picked = classifyVersionSpec(spec)
  if (picked?.range === undefined) {
    return false
  }

  let version: unknown = entry.version
  let lockedName = typeof entry.name === "string" ? entry.name : packageName
  // npm 6 lockfiles record an aliased install's version as "npm:<name>@<version>"
  if (typeof version === "string" && version.startsWith("npm:")) {
    const aliased = splitNameAndSpec(version.slice("npm:".length))
    lockedName = aliased.name
    version = aliased.spec
  }
  if (typeof version !== "string") {
    return false
  }

  const wantedName = picked.type === "alias" ? picked.target : packageName
  return lockedName === wantedName && satisfies(version, picked.range)
}

export interface PickProblem {
  name: string
  spec: string
  message: string
}

/** A package conflict, with the file it was found in when there are several */
export type FilePackageConflict = PackageConflict & {file?: string}

/**
 * Picks that cannot do anything: the package is not conflicted at all, or it
 * is only conflicted in installed lockfile entries and neither side of them
 * is the picked version (a lockfile entry for a third version cannot be
 * produced without running npm). `conflicts` are the package conflicts of a
 * resolution that already applied the picks.
 */
export function findPickProblems(
  picks: Readonly<Record<string, string>>,
  conflicts: readonly FilePackageConflict[]
): PickProblem[] {
  const problems: PickProblem[] = []
  const conflictedNames = [...new Set(conflicts.map(conflict => conflict.name))].sort()

  for (const [name, spec] of Object.entries(picks)) {
    const own = conflicts.filter(conflict => conflict.name === name)

    if (own.length === 0) {
      problems.push({name, spec, message: notConflictedMessage(name, conflictedNames)})
    } else if (!own.some(conflict => conflict.resolvedBy === "pick")) {
      const sides = own
        .map(conflict => {
          const where = conflict.file !== undefined ? `${conflict.file} ${conflict.location}` : conflict.location
          return `${where}: ours ${conflict.ours}, theirs ${conflict.theirs}`
        })
        .join("; ")
      problems.push({
        name,
        spec,
        message: `${name}@${spec} cannot be applied: ${name} is only conflicted in installed lockfile entries, and neither side matches ${spec} (${sides}). Pick one of those versions, or resolve the conflicts first and then run "npm install ${name}@${spec}".`,
      })
    }
  }

  return problems
}

function notConflictedMessage(name: string, conflictedNames: string[]): string {
  if (conflictedNames.length === 0) {
    return `${name} is not conflicted: no package has conflicting versions`
  }

  const suggestion = closestName(name, conflictedNames)
  const shown = conflictedNames.slice(0, 10).join(", ")
  const more = conflictedNames.length > 10 ? `, and ${conflictedNames.length - 10} more` : ""
  return `${name} is not conflicted${suggestion !== undefined ? ` (did you mean ${suggestion}?)` : ""}. Conflicted packages: ${shown}${more}`
}

/** The conflicted package a mistyped name most likely meant */
function closestName(name: string, candidates: string[]): string | undefined {
  let best: string | undefined
  let bestDistance = Infinity
  for (const candidate of candidates) {
    const distance = editDistance(name.toLowerCase(), candidate.toLowerCase())
    if (distance < bestDistance) {
      best = candidate
      bestDistance = distance
    }
  }
  return bestDistance <= Math.max(1, Math.floor(name.length / 3)) ? best : undefined
}

/** Levenshtein distance */
function editDistance(a: string, b: string): number {
  let previous = Array.from({length: b.length + 1}, (_, index) => index)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    for (let j = 1; j <= b.length; j++) {
      const substitution = (previous[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1)
      current.push(Math.min((previous[j] as number) + 1, (current[j - 1] as number) + 1, substitution))
    }
    previous = current
  }
  return previous[b.length] as number
}

export interface PickVerification {
  name: string
  spec: string
  /**
   * - "ok": the version exists in the registry, or the local path exists
   * - "unverified": a git, URL or protocol spec, which cannot be checked; it is used as given
   * - "error": the version does not exist, or the check itself failed
   */
  status: "ok" | "unverified" | "error"
  message: string
  /** For registry specs: the highest published version the spec matches */
  version?: string
}

export interface VerifyPicksOptions {
  /** Finds a package's published versions (see createNpmVersionLookup) */
  lookup: PackageVersionLookup
  /** Directory relative file: specs are resolved from (the project's) */
  cwd: string
}

/**
 * Check that every picked version exists: registry versions and ranges
 * against the package's published versions (one lookup per package), file:
 * specs against the file system.
 */
export async function verifyVersionPicks(
  picks: Readonly<Record<string, string>>,
  options: VerifyPicksOptions
): Promise<PickVerification[]> {
  const lookups = new Map<string, Promise<PackageVersions | null>>()
  const lookup = (name: string): Promise<PackageVersions | null> => {
    let pending = lookups.get(name)
    if (pending === undefined) {
      pending = Promise.resolve().then(() => options.lookup(name))
      lookups.set(name, pending)
    }
    return pending
  }

  return Promise.all(Object.entries(picks).map(([name, spec]) => verifyPick(name, spec, lookup, options.cwd)))
}

async function verifyPick(
  name: string,
  spec: string,
  lookup: (name: string) => Promise<PackageVersions | null>,
  cwd: string
): Promise<PickVerification> {
  const picked = classifyVersionSpec(spec)
  const result = (status: PickVerification["status"], message: string, version?: string): PickVerification =>
    version !== undefined ? {name, spec, status, message, version} : {name, spec, status, message}

  if (picked === null) {
    return result("error", `${name}@${spec}: "${spec}" is not a valid version or range`)
  }

  if (picked.type === "file") {
    const path = expandPath(picked.path as string, cwd)
    try {
      await access(path)
      return result("ok", `${name}@${spec}: ${path} exists`)
    } catch {
      return result("error", `${name}@${spec}: ${path} does not exist`)
    }
  }

  if (picked.type === "git" || picked.type === "url" || picked.type === "protocol") {
    return result(
      "unverified",
      `${name}@${spec} is not a registry version, so it cannot be checked; it is used as given`
    )
  }

  if (picked.range === undefined) {
    return result("error", `${name}@${spec}: dist-tags cannot be picked; pick a version or a range`)
  }

  const registryName = picked.type === "alias" ? (picked.target as string) : name
  let published: PackageVersions | null
  try {
    published = await lookup(registryName)
  } catch (error) {
    return result(
      "error",
      `${name}@${spec}: could not check the registry (${error instanceof Error ? error.message : String(error)}). Pass --no-version-check to skip this check.`
    )
  }

  if (published === null) {
    return result("error", `${name}@${spec}: there is no package named ${registryName} in the registry`)
  }

  const exact = valid(picked.range) !== null
  const match = maxSatisfying(published.versions, picked.range)
  if (match !== null) {
    return result("ok", `${name}@${spec} exists in the registry${exact ? "" : ` (newest match: ${match})`}`, match)
  }

  const latest = published.distTags.latest
  const hint = latest !== undefined ? ` (latest is ${latest})` : ""
  return result(
    "error",
    exact
      ? `${name}@${spec} does not exist in the registry${hint}`
      : `${name}@${spec} matches no published version${hint}`
  )
}

/** Resolve a file: spec's path like npm does: relative to the project, "~" being the home folder */
function expandPath(path: string, cwd: string): string {
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return resolve(homedir(), path.slice(2))
  }
  return resolve(cwd, path)
}
