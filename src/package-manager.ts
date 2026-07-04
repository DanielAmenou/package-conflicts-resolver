/**
 * Package manager detection and lockfile registry.
 *
 * The tool merges JSON lockfiles (npm) itself. For other package managers it
 * delegates to the manager's own tooling: yarn, pnpm and bun all resolve
 * conflicted lockfiles automatically during install, so reimplementing their
 * formats here would only risk producing incorrect dependency graphs.
 */

import {access, readFile} from "fs/promises"
import {join} from "node:path"

export type PackageManagerName = "npm" | "yarn" | "pnpm" | "bun"

export interface LockfileInfo {
  /** Lockfile name, e.g. "package-lock.json" */
  name: string
  /** Package manager that owns this lockfile */
  packageManager: PackageManagerName
  /** Whether the file is JSON and can be merged semantically by this tool */
  jsonMergeable: boolean
  /** Command that safely updates the lockfile without installing node_modules */
  safeRegenCommand?: {command: string; args: string[]}
  /** Command to suggest when the tool cannot fix the lockfile itself */
  manualCommand: string
}

export const LOCKFILES: readonly LockfileInfo[] = [
  {
    name: "package-lock.json",
    packageManager: "npm",
    jsonMergeable: true,
    safeRegenCommand: {command: "npm", args: ["install", "--package-lock-only"]},
    manualCommand: "npm install --package-lock-only",
  },
  {
    name: "npm-shrinkwrap.json",
    packageManager: "npm",
    jsonMergeable: true,
    safeRegenCommand: {command: "npm", args: ["install", "--package-lock-only"]},
    manualCommand: "npm install --package-lock-only",
  },
  {
    name: "pnpm-lock.yaml",
    packageManager: "pnpm",
    jsonMergeable: false,
    // pnpm resolves conflicted pnpm-lock.yaml files automatically
    safeRegenCommand: {command: "pnpm", args: ["install", "--lockfile-only"]},
    manualCommand: "pnpm install --lockfile-only",
  },
  {
    name: "yarn.lock",
    packageManager: "yarn",
    jsonMergeable: false,
    // No lockfile-only mode that works across yarn classic and Berry, but
    // both resolve conflicted yarn.lock files automatically during install.
    manualCommand: "yarn install",
  },
  {
    name: "bun.lock",
    packageManager: "bun",
    jsonMergeable: false,
    manualCommand: "bun install",
  },
  {
    name: "bun.lockb",
    packageManager: "bun",
    jsonMergeable: false,
    manualCommand: "bun install",
  },
]

/**
 * Return the lockfiles that exist in the given directory (registry order)
 */
export async function findLockfiles(dir: string): Promise<LockfileInfo[]> {
  const found: LockfileInfo[] = []

  for (const lockfile of LOCKFILES) {
    try {
      await access(join(dir, lockfile.name))
      found.push(lockfile)
    } catch {
      // Lockfile doesn't exist
    }
  }

  return found
}

/**
 * Detect the project's package manager: the "packageManager" field (corepack)
 * is the most explicit signal, then lockfile presence, then npm as default.
 */
export async function detectPackageManager(dir: string): Promise<PackageManagerName> {
  try {
    const packageJson = JSON.parse(await readFile(join(dir, "package.json"), "utf8"))
    const field = typeof packageJson.packageManager === "string" ? packageJson.packageManager : ""
    const match = field.match(/^(npm|yarn|pnpm|bun)@/)
    if (match && match[1]) {
      return match[1] as PackageManagerName
    }
  } catch {
    // No package.json or invalid JSON: fall through to lockfile detection
  }

  const lockfiles = await findLockfiles(dir)
  const first = lockfiles[0]
  return first ? first.packageManager : "npm"
}
