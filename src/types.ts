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
  /** Name of the package whose version this conflict is about, when it is about one */
  package?: string
}

/**
 * Why a value was left for the user to decide:
 * - "not-a-version": both branches changed it, and it is not a version (a
 *   script, the description, a boolean, an object...)
 * - "not-comparable": both branches changed a version spec, to specs that
 *   have no order (a git URL and a range, two dist-tags, two file: paths...)
 * - "removed": one branch removed it, and the other changed it. Never a
 *   dependency: a dependency one branch removed stays removed (see
 *   PackageConflict.resolvedBy).
 */
export type UnresolvedReason = "not-a-version" | "not-comparable" | "removed"

/**
 * A value of a package.json that the highest and lowest strategies cannot
 * decide (see UnresolvedReason): they only order versions, and have no order
 * for this value, or no way to tell whether it should still exist. It is
 * left for the user to decide: the merged document holds our value in its
 * place (nothing, when our branch removed it), and writeResolvedPackage()
 * writes Git conflict markers around the property, with both values. The
 * ours and theirs strategies, or a version picked for the package, decide it
 * like any other conflict.
 */
export interface UnresolvedConflict {
  /** The value's path joined with dots, like ResolvedConflict.field ("scripts.build") */
  field: string
  /** JSON path of the value */
  path: string[]
  /** Why the strategy did not decide it */
  reason: UnresolvedReason
  /** Our value: undefined when our branch removed it */
  ours: unknown
  /** Their value: undefined when their branch removed it */
  theirs: unknown
  /** The common ancestor's value, when it is known and had one */
  base?: unknown
}

/**
 * A package whose version both branches changed, to different values.
 */
export interface PackageConflict {
  /** Package name, e.g. "lodash" or "@types/node" */
  name: string
  /**
   * - "spec": a dependency range the project declares (package.json, or the
   *   root and workspace entries of a lockfile)
   * - "lock": an installed package of an npm lockfile, locked to an exact version
   */
  kind: "spec" | "lock"
  /**
   * Where the conflict is: the dependency field of a package.json spec
   * ("devDependencies"), the entry and field of a lockfile spec
   * ("root › dependencies", "packages/app › dependencies"), or the install
   * location of a locked package ("node_modules/lodash")
   */
  location: string
  /** JSON path of the conflicting value inside the document */
  path: string[]
  /** Our spec or locked version: null when our branch removed it */
  ours: string | null
  /** Their spec or locked version: null when their branch removed it */
  theirs: string | null
  /** The common ancestor's value, when it is known (merge driver, diff3/zdiff3 markers) */
  base?: string
  /** The value the resolution kept: null when it removed it, or left it for the user to decide */
  resolved: string | null
  /**
   * What chose `resolved`:
   * - the strategy's name;
   * - "pick", for a version the user picked;
   * - "user", for a value left for the user to decide (it is among the
   *   resolution's `unresolved` too);
   * - "removal", for a dependency one branch removed while the other changed
   *   it: with highest and lowest it stays removed (`resolved` is null), and
   *   the other branch's change is dropped;
   * - in a lockfile, "ours" or "theirs" when the strategy could not decide and
   *   the side kept was the default: ours when the versions have no order, the
   *   changed side for an installed entry the other branch removed.
   */
  resolvedBy: string
  /** The version picked for this package, when there is one — even if it could not be applied here */
  pick?: string
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
  /**
   * Conflicts on package versions, one per conflicting value: the dependency
   * specs of package.json (and of a lockfile's root and workspace entries) and
   * the installed packages of an npm lockfile. Set whenever conflicts were
   * resolved; also lists the values `picks` decided.
   */
  packageConflicts?: PackageConflict[]
  /**
   * Values left for the user to decide (see UnresolvedConflict). Set whenever
   * conflicts were resolved. The document still counts as `resolved`, with
   * our value in place of each of these (or nothing, where our branch removed
   * it): pass them to writeResolvedPackage() so that the file gets conflict
   * markers instead.
   */
  unresolved?: UnresolvedConflict[]
}

export interface LoggerOptions {
  quiet: boolean
  json: boolean
  verbose: boolean
  /** Print nothing at all, warnings and errors included */
  silent?: boolean
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
  /**
   * Versions picked for specific packages (package name -> version or range).
   * A picked package's conflicts are resolved to that version instead of by
   * the strategy; every other conflict still uses the strategy.
   */
  picks?: Record<string, string>
  /** CLI: list the conflicted packages instead of resolving them */
  list?: boolean
  /** CLI: check that picked versions exist in the registry (default true) */
  versionCheck?: boolean
  /** Print nothing at all, warnings and errors included (for analysis passes) */
  silent?: boolean
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
