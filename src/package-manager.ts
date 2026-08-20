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
    // Yarn classic has no lockfile-only mode; Berry does (`--mode update-lockfile`).
    // Both resolve conflicted yarn.lock files automatically during install, so
    // the safe command is resolved per-project via resolveSafeRegenCommand().
    manualCommand: "yarn install",
  },
  {
    name: "bun.lock",
    packageManager: "bun",
    jsonMergeable: false,
    // bun.lock (text lockfile) only exists on bun >= 1.2, which also supports
    // --lockfile-only, so the safe command is always available for this file.
    safeRegenCommand: {command: "bun", args: ["install", "--lockfile-only"]},
    manualCommand: "bun install --lockfile-only",
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
 * Detect whether a project uses Yarn Berry (v2+): the "packageManager" field
 * is the most explicit signal, then the presence of Berry's .yarnrc.yml.
 * Yarn classic (v1) projects use .yarnrc (no extension) instead.
 */
export async function isYarnBerry(dir: string): Promise<boolean> {
  try {
    const packageJson = JSON.parse(await readFile(join(dir, "package.json"), "utf8"))
    const field = typeof packageJson.packageManager === "string" ? packageJson.packageManager : ""
    const match = field.match(/^yarn@(\d+)/)
    if (match && match[1]) {
      return parseInt(match[1], 10) >= 2
    }
  } catch {
    // No package.json or invalid JSON: fall through to .yarnrc.yml detection
  }

  try {
    await access(join(dir, ".yarnrc.yml"))
    return true
  } catch {
    return false
  }
}

/**
 * Resolve the command that safely updates a lockfile without installing
 * node_modules, taking the project's setup into account. Yarn Berry supports
 * `--mode update-lockfile`; Yarn classic has no equivalent, so it returns
 * undefined and callers fall back to the manual command.
 */
export async function resolveSafeRegenCommand(
  dir: string,
  lockfile: LockfileInfo
): Promise<{command: string; args: string[]} | undefined> {
  if (lockfile.packageManager === "yarn") {
    return (await isYarnBerry(dir)) ? {command: "yarn", args: ["install", "--mode", "update-lockfile"]} : undefined
  }
  return lockfile.safeRegenCommand
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
