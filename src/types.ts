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
}

export interface ResolutionResult {
  resolved: boolean
  conflicts: ResolvedConflict[]
  packageJson?: PackageJson
  errors: string[]
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
