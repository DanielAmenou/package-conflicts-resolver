/**
 * Types and interfaces for the package conflict resolver
 */

export interface PackageJson {
  name?: string
  version?: string
  private?: boolean
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, any>
  optionalDependencies?: Record<string, string>
  engines?: Record<string, string>
  packageManager?: string
  [key: string]: any
}

export interface ConflictMarker {
  start: number
  middle: number
  end: number
  ours: string
  theirs: string
  /** Base content when the conflict uses diff3/zdiff3 style (`|||||||` section) */
  base?: string
  field?: string
}

export interface ResolutionStrategy {
  name: "highest" | "lowest" | "ours" | "theirs"
  description: string
}

export interface ResolvedConflict {
  field: string
  ourValue: string
  theirValue: string
  resolvedValue: string
  strategy: string
  originalOurs?: string
  originalTheirs?: string
  /**
   * When true, `resolvedValue` is one side of the conflict taken verbatim and
   * must be inserted as-is instead of being re-formatted as a JSON property.
   */
  verbatim?: boolean
}

/**
 * A dependency edge in an npm lockfile whose locked version does not satisfy
 * the declared spec. `npm ci` refuses to install from such a lockfile.
 */
export interface LockfileIssue {
  /** Location of the dependent entry inside "packages" ("" is the root project) */
  from: string
  /** Dependency name as declared by the dependent */
  name: string
  /** Declared version spec (range) */
  spec: string
  /** Location of the entry the dependency resolves to, when one was found */
  resolvedPath?: string
  /** Version locked at `resolvedPath`, when one was found */
  version?: string
  kind: "missing" | "invalid"
  message: string
}

export interface ResolutionResult {
  resolved: boolean
  conflicts: ResolvedConflict[]
  packageJson?: PackageJson
  errors: string[]
  /**
   * Only set when the merged document is an npm lockfile: dependency edges that
   * the merged lockfile no longer satisfies. Empty means the lockfile is
   * self-consistent; a non-empty list means it must be regenerated with
   * `npm install --package-lock-only` before `npm ci` will accept it.
   */
  lockfileIssues?: LockfileIssue[]
}

export interface LoggerOptions {
  quiet: boolean
  json: boolean
  verbose: boolean
}

export interface CliOptions {
  strategy: ResolutionStrategy["name"]
  dryRun: boolean
  quiet: boolean
  json: boolean
  verbose: boolean
  regenerateLock: boolean
  file?: string
  /**
   * Merge driver only: accept a merged package-lock.json whose dependency
   * graph is inconsistent instead of leaving the file conflicted for npm.
   */
  allowInconsistentLockfile?: boolean
}

export const RESOLUTION_STRATEGIES: Record<ResolutionStrategy["name"], ResolutionStrategy> = {
  highest: {name: "highest", description: "Use the highest version (default)"},
  lowest: {name: "lowest", description: "Use the lowest version"},
  ours: {name: "ours", description: "Use our version (current branch)"},
  theirs: {name: "theirs", description: "Use their version (incoming branch)"},
}

export const STABLE_PACKAGE_JSON_FIELDS = [
  "name",
  "version",
  "private",
  "scripts",
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "peerDependenciesMeta",
  "optionalDependencies",
  "engines",
  "packageManager",
] as const
