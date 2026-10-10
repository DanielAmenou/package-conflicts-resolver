/**
 * Main entry point for package-conflicts-resolver
 * Exports the public API for programmatic usage
 */

export {PackageResolver} from "./package-resolver.js"
export {ConflictParser} from "./conflict-parser.js"
export {VersionResolver} from "./version-resolver.js"
export {Logger} from "./logger.js"
export {LOCKFILES, findLockfiles, detectPackageManager} from "./package-manager.js"
export type {PackageManagerName, LockfileInfo} from "./package-manager.js"
export {isNpmLockfile, validateLockfile, formatLockfileIssues, resolveLockfileDependency} from "./lockfile-validator.js"
export {parseJsonLenient} from "./json-repair.js"
export {
  classifyVersionSpec,
  findPickProblems,
  isValidPackageName,
  lockedVersionSatisfies,
  normalizeVersionPicks,
  parseVersionPick,
  parseVersionPicks,
  verifyVersionPicks,
} from "./version-picks.js"
export type {
  FilePackageConflict,
  PickProblem,
  PickVerification,
  VerifyPicksOptions,
  VersionPick,
  VersionSpec,
  VersionSpecType,
} from "./version-picks.js"
export {createNpmVersionLookup, parseNpmViewOutput} from "./registry.js"
export type {NpmVersionLookupOptions, PackageVersionLookup, PackageVersions} from "./registry.js"
export {formatConflictReport, reportFile} from "./conflict-report.js"
export type {ConflictReport, ConflictReportFile, OtherConflict} from "./conflict-report.js"

export * from "./types.js"

// Re-export for convenience
export {RESOLUTION_STRATEGIES, STABLE_PACKAGE_JSON_FIELDS} from "./types.js"
