/**
 * Registry lookups for picked versions.
 *
 * They go through the npm CLI rather than straight to a registry URL, so the
 * project's npm configuration applies exactly as it does for `npm install`:
 * the registry, scoped registries, credentials and proxies set in .npmrc.
 */

import {CommandOutput, runCommand} from "./process.js"
import {isValidPackageName} from "./version-picks.js"

export interface PackageVersions {
  /** Every published version */
  versions: string[]
  /** Dist-tags ("latest", "next", ...) and the versions they point to */
  distTags: Record<string, string>
}

/** Resolves to a package's published versions, or to null when the registry does not have the package */
export type PackageVersionLookup = (name: string) => Promise<PackageVersions | null>

export interface NpmVersionLookupOptions {
  /** Directory npm runs in, so the project's .npmrc applies */
  cwd: string
  /** Give up on a lookup after this long (default: 60 seconds) */
  timeoutMs?: number
}

export const DEFAULT_LOOKUP_TIMEOUT_MS = 60_000

/**
 * npm retries an unreachable registry for over a minute by default. An
 * existence check should fail fast instead, so allow a single short retry.
 */
const RETRY_FLAGS = ["--fetch-retries=1", "--fetch-retry-mintimeout=2000", "--fetch-retry-maxtimeout=5000"]

/**
 * Look packages up with `npm view <name> versions dist-tags --json`.
 */
export function createNpmVersionLookup(options: NpmVersionLookupOptions): PackageVersionLookup {
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOOKUP_TIMEOUT_MS

  return async name => {
    // The name ends up on a command line, through a shell on Windows
    if (!isValidPackageName(name)) {
      throw new Error(`"${name}" is not a valid package name`)
    }

    let output: CommandOutput
    try {
      output = await runCommand("npm", ["view", name, "versions", "dist-tags", "--json", ...RETRY_FLAGS], {
        cwd: options.cwd,
        timeoutMs,
        env: {...process.env, npm_config_update_notifier: "false"},
      })
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      throw new Error(code === "ENOENT" ? "npm was not found on PATH" : `npm view ${(error as Error).message}`)
    }

    return parseNpmViewOutput(output)
  }
}

/**
 * Interpret the output of `npm view <name> versions dist-tags --json`: the
 * versions on success, null when the registry does not have the package
 * (E404), an Error with npm's own explanation for anything else.
 *
 * npm 12 prints an array, with an entry for each manifest it read; earlier
 * versions print a single object. Both are read the same way.
 */
export function parseNpmViewOutput(output: CommandOutput): PackageVersions | null {
  if (output.code !== 0) {
    if (/\bE404\b/.test(output.stdout) || /\bE404\b/.test(output.stderr)) {
      return null
    }
    throw new Error(npmErrorSummary(output) ?? `npm view exited with code ${output.code}`)
  }

  // A package without any published version prints nothing
  if (output.stdout.trim() === "") {
    return {versions: [], distTags: {}}
  }

  let document: unknown
  try {
    document = JSON.parse(output.stdout)
  } catch {
    throw new Error("npm view printed something that is not JSON")
  }
  const entries = Array.isArray(document) ? document : [document]
  if (!entries.every(isPlainObject)) {
    throw new Error("npm view printed an unexpected result")
  }

  // The fields asked for belong to the package, not to one of its versions:
  // every entry should have the same, but nothing is lost should they differ
  const versions = new Set<string>()
  const distTags = new Map<string, string>()
  for (const entry of entries) {
    const listed = typeof entry.versions === "string" ? [entry.versions] : entry.versions
    for (const version of Array.isArray(listed) ? listed : []) {
      if (typeof version === "string") {
        versions.add(version)
      }
    }
    const tags = entry["dist-tags"]
    for (const [tag, version] of isPlainObject(tags) ? Object.entries(tags) : []) {
      if (typeof version === "string" && !distTags.has(tag)) {
        distTags.set(tag, version)
      }
    }
  }
  return {versions: [...versions], distTags: Object.fromEntries(distTags)}
}

/**
 * npm's explanation of a failure: the "summary" of the JSON error that
 * `--json` prints, or else the most telling "npm error" line.
 */
function npmErrorSummary(output: CommandOutput): string | undefined {
  for (const text of [output.stdout, output.stderr]) {
    try {
      const parsed = JSON.parse(text)
      const summary = isPlainObject(parsed) && isPlainObject(parsed.error) ? parsed.error.summary : undefined
      if (typeof summary === "string" && summary.trim() !== "") {
        return summary.trim()
      }
    } catch {
      // not JSON
    }
  }

  return output.stderr
    .split(/\r?\n/)
    .map(line => line.replace(/^npm (?:error|ERR!)\s*/, "").trim())
    .find(line => line !== "" && !/^(?:code|errno|syscall|path)\b|^A complete log of this run/.test(line))
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
