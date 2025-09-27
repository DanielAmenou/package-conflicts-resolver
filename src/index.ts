/**
 * Main entry point for package-conflicts-resolver
 * Exports the public API for programmatic usage
 */

export {PackageResolver} from "./package-resolver.js"
export {ConflictParser} from "./conflict-parser.js"
export {VersionResolver} from "./version-resolver.js"
export {Logger} from "./logger.js"

export * from "./types.js"

// Re-export for convenience
export {RESOLUTION_STRATEGIES, STABLE_PACKAGE_JSON_FIELDS} from "./types.js"
