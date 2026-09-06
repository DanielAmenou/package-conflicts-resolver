#!/usr/bin/env node

/**
 * CLI entry point for package-conflicts-resolver
 */

import {Command} from "commander"
import {spawn} from "node:child_process"
import {readFileSync} from "node:fs"
import {basename, dirname, join, resolve} from "node:path"
import {readFile, access} from "fs/promises"
import {ConflictParser} from "./conflict-parser.js"
import {PackageResolver} from "./package-resolver.js"
import {LOCKFILES, PackageManagerName, findLockfiles, resolveSafeRegenCommand} from "./package-manager.js"
import {formatLockfileIssues, isNpmLockfile, validateLockfile} from "./lockfile-validator.js"
import {RESOLUTION_STRATEGIES, CliOptions, LockfileIssue, PackageJson, ResolutionResult} from "./types.js"

const IS_WINDOWS = process.platform === "win32"

/**
 * .gitattributes entries managed by setup/verify/uninstall. Only JSON files
 * the merge driver can actually merge are routed to it; yarn/pnpm/bun
 * lockfiles are resolved by their own package manager during install.
 */
const GITATTRIBUTES_ENTRIES = [
  "package.json merge=package-conflicts-resolver",
  "package-lock.json merge=package-conflicts-resolver",
  "npm-shrinkwrap.json merge=package-conflicts-resolver",
]

/**
 * Read the tool version from its own package.json (single source of truth)
 */
function getToolVersion(): string {
  try {
    const packageJson = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"))
    return typeof packageJson.version === "string" ? packageJson.version : "0.0.0"
  } catch {
    return "0.0.0"
  }
}

/**
 * Spawn a command cross-platform. On Windows, package manager CLIs are .cmd
 * shims and require a shell to execute (plain spawn fails with EINVAL on Node 20+).
 */
function spawnCommand(command: string, args: string[], options: Parameters<typeof spawn>[2] = {}) {
  const needsShell = IS_WINDOWS && ["npm", "npx", "yarn", "pnpm", "bun"].includes(command)
  return spawn(command, args, {...options, shell: needsShell})
}

/**
 * Render a spawnable command as the string a user would type
 */
function formatCommand(cmd: {command: string; args: string[]}): string {
  return [cmd.command, ...cmd.args].join(" ")
}

/**
 * Run a lockfile command (e.g. "npm install --package-lock-only").
 * Resolves to false when the command fails or is not installed.
 */
function runLockfileCommand(cmd: {command: string; args: string[]}, cwd: string, quiet: boolean): Promise<boolean> {
  return new Promise(resolvePromise => {
    const child = spawnCommand(cmd.command, cmd.args, {stdio: quiet ? "pipe" : "inherit", cwd})
    child.on("close", code => resolvePromise(code === 0))
    child.on("error", () => resolvePromise(false))
  })
}

async function main() {
  const program = new Command()

  program
    .name("package-conflicts-resolver")
    .description("Automatically resolve conflicts in package.json and package-lock.json files")
    .version(getToolVersion())

  program
    .argument("[file]", "Path to package.json file", "package.json")
    .option(
      "-s, --strategy <strategy>",
      `Resolution strategy: ${Object.keys(RESOLUTION_STRATEGIES).join(", ")}`,
      "highest"
    )
    .option("-d, --dry-run", "Show what would be done without making changes", false)
    .option("-q, --quiet", "Suppress output except errors", false)
    .option("-j, --json", "Output in JSON format", false)
    .option("-v, --verbose", "Enable verbose logging", false)
    .option("--no-regenerate-lock", "Skip package-lock.json regeneration")
    .action(async (file: string, options: any) => {
      const cliOptions: CliOptions = {
        strategy: options.strategy,
        dryRun: options.dryRun,
        quiet: options.quiet,
        json: options.json,
        verbose: options.verbose,
        regenerateLock: options.regenerateLock,
        file,
      }

      // Validate strategy
      if (!Object.keys(RESOLUTION_STRATEGIES).includes(cliOptions.strategy)) {
        console.error(`❌ Invalid strategy: ${cliOptions.strategy}`)
        console.error(`Available strategies: ${Object.keys(RESOLUTION_STRATEGIES).join(", ")}`)
        process.exit(1)
      }

      try {
        await resolvePackageConflicts(cliOptions)
      } catch (error) {
        console.error(`❌ Failed to resolve conflicts: ${error instanceof Error ? error.message : String(error)}`)
        process.exit(1)
      }
    })

  // Git merge driver subcommand
  program
    .command("merge-driver")
    .description("Run as Git merge driver (called by Git)")
    .argument("<current>", "Current version file path")
    .argument("<base>", "Base version file path")
    .argument("<other>", "Other version file path")
    .option("-s, --strategy <strategy>", "Resolution strategy", "highest")
    .option(
      "--allow-inconsistent-lockfile",
      "Accept a merged package-lock.json whose dependency graph is inconsistent instead of leaving it conflicted for npm",
      false
    )
    .action(async (current: string, base: string, other: string, options: any) => {
      try {
        // Fall back to the default strategy on invalid input: a merge driver
        // should never hard-fail because of a bad flag
        const strategy = Object.keys(RESOLUTION_STRATEGIES).includes(options.strategy) ? options.strategy : "highest"

        const [currentContent, baseContent, otherContent] = await Promise.all([
          readFile(current, "utf8"),
          readFile(base, "utf8"),
          readFile(other, "utf8"),
        ])

        const cliOptions: CliOptions = {
          strategy,
          dryRun: false,
          quiet: true,
          json: false,
          verbose: false,
          regenerateLock: true,
          file: current,
          allowInconsistentLockfile: Boolean(options.allowInconsistentLockfile),
        }

        const resolver = new PackageResolver(cliOptions)
        const result = await resolver.mergeJsonContents(baseContent, currentContent, otherContent)

        if (result.resolved && result.packageJson) {
          // Preserve the current file's indentation and line endings
          await resolver.writeResolvedPackage(result.packageJson, current, currentContent)

          // A merged lockfile can be valid JSON yet describe a dependency graph
          // npm refuses to install (`npm ci` fails with "not in sync"). The
          // merge driver cannot regenerate it here — package.json is merged
          // after the lockfile — so leave the file conflicted: Git keeps the
          // merged content in the worktree and the user regenerates it.
          const issues = result.lockfileIssues ?? []
          if (issues.length > 0 && !cliOptions.allowInconsistentLockfile) {
            const noun = issues.length === 1 ? "dependency" : "dependencies"
            console.error(
              `package-conflicts-resolver: merged lockfile is not consistent (${issues.length} unsatisfied ${noun}):`
            )
            for (const line of formatLockfileIssues(issues)) {
              console.error(`  - ${line}`)
            }
            console.error(
              'package-conflicts-resolver: leaving the lockfile marked as conflicted. Run "npm install --package-lock-only" once the merge finishes, then "git add" the lockfile.'
            )
            console.error(
              "package-conflicts-resolver: (add --allow-inconsistent-lockfile to the merge driver command to accept such merges)"
            )
            process.exit(1)
          }

          process.exit(0) // Success
        } else {
          // Non-zero exit tells Git the file is still conflicted
          console.error(`package-conflicts-resolver: could not auto-resolve merge: ${result.errors.join(", ")}`)
          process.exit(1)
        }
      } catch (error) {
        console.error(
          `package-conflicts-resolver: merge driver failed: ${error instanceof Error ? error.message : String(error)}`
        )
        process.exit(1) // Error
      }
    })

  // Setup subcommand for Git integration
  program
    .command("setup")
    .description("Setup Git integration (merge driver and hooks)")
    .option("--global", "Setup globally for all repositories", false)
    .option("--skip-gitattributes", "Skip automatic .gitattributes setup", false)
    .action(async (options: any) => {
      try {
        await setupGitIntegration(options.global, options.skipGitattributes)
      } catch (error) {
        console.error(`❌ Failed to setup Git integration: ${error instanceof Error ? error.message : String(error)}`)
        process.exit(1)
      }
    })

  // Verify subcommand to check setup
  program
    .command("verify")
    .description("Verify that Git integration is setup correctly")
    .action(async () => {
      try {
        await verifySetup()
      } catch (error) {
        console.error(`❌ Verification failed: ${error instanceof Error ? error.message : String(error)}`)
        process.exit(1)
      }
    })

  // Uninstall subcommand to remove Git integration
  program
    .command("uninstall")
    .description("Remove Git integration (merge driver and .gitattributes)")
    .option("--global", "Remove global Git integration", false)
    .option("--force", "Force removal without confirmation", false)
    .action(async (options: any) => {
      try {
        await uninstallGitIntegration(options.global, options.force)
      } catch (error) {
        console.error(
          `❌ Failed to uninstall Git integration: ${error instanceof Error ? error.message : String(error)}`
        )
        process.exit(1)
      }
    })

  await program.parseAsync()
}

/**
 * Main conflict resolution logic
 */
async function resolvePackageConflicts(options: CliOptions): Promise<void> {
  const filePath = options.file || "package.json"

  // Check if file exists
  try {
    await access(filePath)
  } catch {
    console.error(`❌ File not found: ${filePath}`)
    process.exit(1)
  }

  // Read file content
  const content = await readFile(filePath, "utf8")
  const targetHasConflicts = ConflictParser.hasConflicts(content)
  const targetIsPackageJson = basename(resolve(filePath)) === "package.json"
  const dir = dirname(resolve(filePath))
  let resolvedTarget = false
  let packageJsonDocument: PackageJson | undefined
  const inconsistent: InconsistentLockfile[] = []

  if (targetHasConflicts) {
    if (!options.quiet && !options.json) {
      console.log(`🔧 Found Git conflict markers in ${filePath}, proceeding with resolution...`)
    }

    // Create resolver and resolve conflicts
    const resolver = new PackageResolver(options)
    const result = await resolver.resolveConflicts(content)

    if (!result.resolved) {
      console.error(`❌ Failed to resolve conflicts: ${result.errors.join(", ")}`)
      process.exit(1)
    }

    if (result.packageJson) {
      // Write resolved package.json (preserving original indentation/line endings)
      await resolver.writeResolvedPackage(result.packageJson, filePath, content)
      resolvedTarget = true

      if (targetIsPackageJson) {
        packageJsonDocument = result.packageJson
      } else if (isNpmLockfile(result.packageJson)) {
        // The target is a lockfile itself: check it against the package.json next to it
        const issues = lockfileIssuesFor(result, await readSiblingPackageJson(dir))
        if (issues.length > 0) {
          inconsistent.push({name: basename(filePath), issues})
        }
      }
    }
  } else if (targetIsPackageJson) {
    packageJsonDocument = parsePackageJson(content)
  }

  // When the target is a package.json, also resolve conflicted sibling
  // lockfiles: Git conflicts often hit only the lockfile even when
  // package.json merges cleanly.
  let lockStatus: LockResolutionStatus = {resolved: 0, failed: [], inconsistent: [], regenerated: new Set()}
  if (targetIsPackageJson) {
    lockStatus = await resolveCompanionLockfiles(filePath, options, packageJsonDocument)
  }
  inconsistent.push(...lockStatus.inconsistent)

  if (!targetHasConflicts && lockStatus.resolved === 0 && lockStatus.failed.length === 0) {
    if (!options.quiet) {
      if (options.json) {
        console.log(
          JSON.stringify({
            level: "info",
            message: `No Git conflict markers found in ${filePath}`,
            data: {conflicts: 0},
            timestamp: new Date().toISOString(),
          })
        )
      } else {
        console.log(`✅ No Git conflict markers found in ${filePath}`)
        console.log(`\nℹ️  If you expected automatic conflict resolution during Git merge:`)
        console.log(`   1. Run: package-conflicts-resolver setup`)
        console.log(`   2. Run: package-conflicts-resolver verify`)
        console.log(`   3. Ensure conflicts happen in package.json or package-lock.json`)
      }
    }
    process.exit(0)
    return
  }

  // Regenerate lockfiles so they are consistent with the merged package.json
  let regenerated = new Set<string>(lockStatus.regenerated)
  if (
    (resolvedTarget || lockStatus.resolved > 0 || lockStatus.failed.length > 0) &&
    options.regenerateLock &&
    !options.dryRun
  ) {
    regenerated = await regenerateLockfiles(dir, options.quiet, lockStatus.regenerated)
  }

  // npm rewrites its lockfile from package.json while regenerating: that heals
  // an inconsistent dependency graph and even conflict markers, which npm
  // resolves on its own.
  let failed = lockStatus.failed
  if (regenerated.has("npm")) {
    const stillFailed: FailedLockfile[] = []
    for (const entry of failed) {
      if (ConflictParser.hasConflicts(await readFile(entry.path, "utf8"))) {
        stillFailed.push(entry)
      } else if (!options.quiet && !options.json) {
        console.log(`✅ ${entry.name} was regenerated by npm and no longer has conflicts`)
      }
    }
    failed = stillFailed
    inconsistent.length = 0 // every inconsistent entry is an npm lockfile
  }

  // Non-npm lockfiles already printed their package manager's instructions
  // when they were detected; npm lockfiles get theirs here, after regeneration
  // had its chance.
  for (const entry of failed.filter(entry => entry.packageManager === "npm")) {
    console.error(`❌ ${entry.name} still has Git conflict markers.`)
    console.error(
      `   Run "${entry.manualCommand}" (npm resolves conflicted lockfiles itself), or delete ${entry.name} and run it again to recreate the file.`
    )
  }

  if (inconsistent.length > 0) {
    reportInconsistentLockfiles(inconsistent, options)
  }

  const exitWithError = failed.length > 0 || (inconsistent.length > 0 && !options.dryRun)
  process.exit(exitWithError ? 1 : 0)
}

interface FailedLockfile {
  name: string
  path: string
  packageManager: PackageManagerName
  manualCommand: string
}

interface InconsistentLockfile {
  name: string
  issues: LockfileIssue[]
}

interface LockResolutionStatus {
  resolved: number
  /** Lockfiles that still contain conflict markers */
  failed: FailedLockfile[]
  /** Merged npm lockfiles whose dependency graph is not satisfiable */
  inconsistent: InconsistentLockfile[]
  /** Package managers whose regeneration command already ran */
  regenerated: Set<string>
}

/**
 * Parse a package.json for lockfile validation; undefined when it is not
 * valid JSON (e.g. it still carries conflict markers).
 */
function parsePackageJson(content: string): PackageJson | undefined {
  try {
    const parsed = JSON.parse(content.charCodeAt(0) === 0xfeff ? content.slice(1) : content)
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

async function readSiblingPackageJson(dir: string): Promise<PackageJson | undefined> {
  try {
    return parsePackageJson(await readFile(join(dir, "package.json"), "utf8"))
  } catch {
    return undefined
  }
}

/**
 * Dependency edges a merged npm lockfile does not satisfy: the ones the merge
 * introduced inside the lockfile, plus the root's edges checked against the
 * project's package.json when it is available (what `npm ci` compares first).
 */
function lockfileIssuesFor(result: ResolutionResult, packageJson: PackageJson | undefined): LockfileIssue[] {
  const merged = result.packageJson
  if (!merged || !isNpmLockfile(merged)) {
    return []
  }

  const issues = new Map<string, LockfileIssue>()
  const key = (issue: LockfileIssue) => `${issue.from} ${issue.name} ${issue.spec}`

  for (const issue of result.lockfileIssues ?? []) {
    issues.set(key(issue), issue)
  }
  if (packageJson) {
    for (const issue of validateLockfile(merged, packageJson)) {
      if (issue.from === "") {
        issues.set(key(issue), issue)
      }
    }
  }

  return [...issues.values()]
}

function reportInconsistentLockfiles(entries: InconsistentLockfile[], options: CliOptions): void {
  for (const {name, issues} of entries) {
    const noun = issues.length === 1 ? "dependency" : "dependencies"
    if (options.dryRun) {
      if (options.quiet) continue
      console.warn(
        `⚠️  ${name} would be merged with ${issues.length} unsatisfied ${noun}; regenerating it with npm fixes this:`
      )
    } else {
      console.error(
        `❌ ${name} was merged but its dependency graph is not consistent (${issues.length} unsatisfied ${noun}):`
      )
    }
    for (const line of formatLockfileIssues(issues)) {
      console.error(`   - ${line}`)
    }
    if (!options.dryRun) {
      console.error(
        `   \`npm ci\` would reject this lockfile. Run "npm install --package-lock-only" to regenerate ${name}.`
      )
    }
  }
}

/**
 * Resolve conflicts in lockfiles that live next to the given package.json.
 * JSON lockfiles (npm) are merged semantically; other package managers'
 * lockfiles are delegated to the manager itself, which resolves conflicted
 * lockfiles automatically.
 */
async function resolveCompanionLockfiles(
  packageJsonPath: string,
  options: CliOptions,
  packageJsonDocument?: PackageJson
): Promise<LockResolutionStatus> {
  const dir = dirname(resolve(packageJsonPath))
  const status: LockResolutionStatus = {resolved: 0, failed: [], inconsistent: [], regenerated: new Set()}

  for (const lockfile of LOCKFILES) {
    const lockPath = join(dir, lockfile.name)

    let lockContent: string
    try {
      lockContent = await readFile(lockPath, "utf8")
    } catch {
      continue // Lockfile doesn't exist
    }

    if (!ConflictParser.hasConflicts(lockContent)) {
      continue
    }

    if (!options.quiet && !options.json) {
      console.log(`🔧 Found Git conflict markers in ${lockfile.name}, resolving...`)
    }

    // npm lockfiles are JSON: merge them semantically
    if (lockfile.jsonMergeable) {
      const resolver = new PackageResolver({...options, file: lockPath})
      const result = await resolver.resolveConflicts(lockContent)

      if (result.resolved && result.packageJson) {
        await resolver.writeResolvedPackage(result.packageJson, lockPath, lockContent)
        status.resolved++

        const issues = lockfileIssuesFor(result, packageJsonDocument)
        if (issues.length > 0) {
          status.inconsistent.push({name: lockfile.name, issues})
        }
      } else {
        status.failed.push({
          name: lockfile.name,
          path: lockPath,
          packageManager: lockfile.packageManager,
          manualCommand: lockfile.manualCommand,
        })
        console.error(`❌ Could not auto-resolve ${lockfile.name}: ${result.errors.join(", ")}`)
      }
      continue
    }

    // yarn/pnpm/bun lockfiles: delegate to the package manager
    if (options.dryRun) {
      if (!options.quiet && !options.json) {
        console.log(`ℹ Would resolve ${lockfile.name} by running "${lockfile.manualCommand}"`)
      }
      status.resolved++
      continue
    }

    const safeRegenCommand = await resolveSafeRegenCommand(dir, lockfile)
    if (safeRegenCommand && options.regenerateLock) {
      const ran = await runLockfileCommand(safeRegenCommand, dir, options.quiet)
      const stillConflicted = ran ? ConflictParser.hasConflicts(await readFile(lockPath, "utf8")) : true

      if (ran && !stillConflicted) {
        status.resolved++
        status.regenerated.add(lockfile.packageManager)
        if (!options.quiet && !options.json) {
          console.log(`✅ Resolved ${lockfile.name} via "${formatCommand(safeRegenCommand)}"`)
        }
        continue
      }
    }

    status.failed.push({
      name: lockfile.name,
      path: lockPath,
      packageManager: lockfile.packageManager,
      manualCommand: lockfile.manualCommand,
    })
    console.error(`❌ ${lockfile.name} has Git conflicts that this tool does not merge directly.`)
    console.error(
      `   Run "${lockfile.manualCommand}" — ${lockfile.packageManager} resolves conflicted lockfiles automatically.`
    )
    console.error(`   If that fails, delete ${lockfile.name} and run "${lockfile.manualCommand}" to recreate it.`)
  }

  return status
}

/**
 * Regenerate existing lockfiles with their own package manager so they stay
 * consistent with the merged package.json. Never creates a lockfile for a
 * package manager the project doesn't use. Returns the package managers whose
 * lockfile was regenerated successfully (including the ones passed in).
 */
async function regenerateLockfiles(dir: string, quiet: boolean, alreadyRegenerated: Set<string>): Promise<Set<string>> {
  const regenerated = new Set<string>(alreadyRegenerated)
  const lockfiles = await findLockfiles(dir)
  if (lockfiles.length === 0) {
    return regenerated // Lockless project: nothing to regenerate
  }

  const handled = new Set<string>(alreadyRegenerated)

  for (const lockfile of lockfiles) {
    if (handled.has(lockfile.packageManager)) continue
    handled.add(lockfile.packageManager)

    const safeRegenCommand = await resolveSafeRegenCommand(dir, lockfile)
    if (safeRegenCommand) {
      if (!quiet) {
        console.log(`ℹ Regenerating ${lockfile.name} with ${lockfile.packageManager}...`)
      }
      const ok = await runLockfileCommand(safeRegenCommand, dir, quiet)
      if (ok) {
        regenerated.add(lockfile.packageManager)
        if (!quiet) console.log(`✅ Regenerated ${lockfile.name}`)
      } else if (!quiet) {
        console.warn(`⚠️ Failed to regenerate ${lockfile.name}`)
        console.log(`ℹ You may need to run "${lockfile.manualCommand}" manually`)
      }
    } else if (!quiet) {
      console.log(`ℹ Run "${lockfile.manualCommand}" to update ${lockfile.name} after this merge.`)
    }
  }

  return regenerated
}

/**
 * Setup Git integration
 */
async function setupGitIntegration(global: boolean, skipGitattributes: boolean = false): Promise<void> {
  const scope = global ? "--global" : "--local"

  try {
    // Setup merge driver
    const gitProcess = spawn("git", [
      "config",
      scope,
      "merge.package-conflicts-resolver.driver",
      "npx package-conflicts-resolver merge-driver %A %O %B",
    ])

    await new Promise<void>((resolve, reject) => {
      gitProcess.on("close", code => {
        if (code === 0) {
          resolve()
        } else {
          reject(new Error(`git config failed with exit code ${code}`))
        }
      })
      gitProcess.on("error", reject)
    })

    // Set merge driver name for better git messages
    const nameProcess = spawn("git", [
      "config",
      scope,
      "merge.package-conflicts-resolver.name",
      "Automatic package.json conflict resolver",
    ])

    await new Promise<void>((resolve, reject) => {
      nameProcess.on("close", code => {
        if (code === 0) {
          resolve()
        } else {
          // Don't fail if name setting fails
          resolve()
        }
      })
      nameProcess.on("error", () => resolve())
    })

    console.log(`✅ Git merge driver configured ${global ? "globally" : "locally"}`)

    if (!global && !skipGitattributes) {
      // Try to setup .gitattributes automatically
      await setupGitattributes()
    } else if (global) {
      console.log(`\n⚠️  Global setup complete, but you still need to add .gitattributes to each repository:`)
      console.log(`\nAdd this to your .gitattributes file in each project:`)
      for (const entry of GITATTRIBUTES_ENTRIES) {
        console.log(`  ${entry}`)
      }
      console.log(`\nOr run 'package-conflicts-resolver setup' (without --global) in each repository.`)
    }

    console.log(`\n✅ Setup complete! Run 'package-conflicts-resolver verify' to test the configuration.`)
  } catch (error) {
    throw new Error(`Failed to setup Git integration: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Setup or update .gitattributes file
 */
async function setupGitattributes(): Promise<void> {
  try {
    const gitattributesPath = ".gitattributes"
    const requiredLines = GITATTRIBUTES_ENTRIES

    let content = ""
    let fileExists = false

    // Try to read existing .gitattributes
    try {
      content = await readFile(gitattributesPath, "utf8")
      fileExists = true
    } catch {
      // File doesn't exist, will create it
    }

    // Check if all required lines exist
    const lines = content.split("\n")
    const missingLines = requiredLines.filter(requiredLine => !lines.some(line => line.trim() === requiredLine))

    if (missingLines.length > 0) {
      const {writeFile} = await import("fs/promises")

      // Preserve original content and append missing lines
      let newContent = content
      if (newContent && !newContent.endsWith("\n")) {
        newContent += "\n"
      }

      // Add missing lines
      for (const missingLine of missingLines) {
        newContent += missingLine + "\n"
      }

      await writeFile(gitattributesPath, newContent, "utf8")
      console.log(`✅ ${fileExists ? "Updated" : "Created"} .gitattributes file`)
      console.log(`   Added: ${missingLines.join(", ")}`)
    } else {
      console.log(`✅ .gitattributes already configured correctly`)
    }
  } catch (error) {
    console.warn(
      `⚠️  Could not setup .gitattributes automatically: ${error instanceof Error ? error.message : String(error)}`
    )
    console.log(`\nPlease manually add these lines to your .gitattributes file:`)
    for (const entry of GITATTRIBUTES_ENTRIES) {
      console.log(`  ${entry}`)
    }
  }
}

/**
 * Verify Git integration setup
 */
async function verifySetup(): Promise<void> {
  console.log("🔍 Verifying Git integration setup...\n")

  let hasErrors = false

  // Check git config (both local and global)
  try {
    // Check local config first
    const localProcess = spawn("git", ["config", "--local", "merge.package-conflicts-resolver.driver"], {
      stdio: ["pipe", "pipe", "pipe"],
    })

    const localChunks: Buffer[] = []
    localProcess.stdout.on("data", chunk => localChunks.push(chunk))

    await new Promise<void>(resolve => {
      localProcess.on("close", code => {
        if (code === 0) {
          const driver = Buffer.concat(localChunks).toString().trim()
          if (driver.includes("package-conflicts-resolver merge-driver")) {
            console.log("✅ Git merge driver is configured (local)")
            console.log(`   Driver: ${driver}`)
          } else {
            console.log("⚠️  Git merge driver is configured (local) but may be incorrect:")
            console.log(`   Driver: ${driver}`)
            hasErrors = true
          }
          resolve()
        } else {
          // Local config doesn't exist, check global config
          const globalProcess = spawn("git", ["config", "--global", "merge.package-conflicts-resolver.driver"], {
            stdio: ["pipe", "pipe", "pipe"],
          })

          const globalChunks: Buffer[] = []
          globalProcess.stdout.on("data", chunk => globalChunks.push(chunk))

          globalProcess.on("close", globalCode => {
            if (globalCode === 0) {
              const driver = Buffer.concat(globalChunks).toString().trim()
              if (driver.includes("package-conflicts-resolver merge-driver")) {
                console.log("✅ Git merge driver is configured (global)")
                console.log(`   Driver: ${driver}`)
                console.log("   ℹ️  Global config affects all repositories")
              } else {
                console.log("⚠️  Git merge driver is configured (global) but may be incorrect:")
                console.log(`   Driver: ${driver}`)
                hasErrors = true
              }
            } else {
              console.log("❌ Git merge driver is NOT configured")
              console.log("   Run: package-conflicts-resolver setup")
              hasErrors = true
            }
            resolve()
          })

          globalProcess.on("error", () => {
            console.log("❌ Failed to check global git config")
            hasErrors = true
            resolve()
          })
        }
      })
      localProcess.on("error", () => {
        console.log("❌ Failed to check local git config")
        hasErrors = true
        resolve()
      })
    })
  } catch (error) {
    console.log("❌ Failed to check git config")
    hasErrors = true
  }

  // Check .gitattributes (only relevant for local setup)
  try {
    const content = await readFile(".gitattributes", "utf8")
    const lines = content.split("\n")

    const hasEntry = (entry: string) => lines.some(line => line.trim() === entry)
    const hasPackageJson = hasEntry("package.json merge=package-conflicts-resolver")
    const hasPackageLock = hasEntry("package-lock.json merge=package-conflicts-resolver")
    const hasShrinkwrap = hasEntry("npm-shrinkwrap.json merge=package-conflicts-resolver")

    if (hasPackageJson && hasPackageLock) {
      console.log("✅ .gitattributes is configured correctly")
      if (!hasShrinkwrap) {
        // Older setups didn't add the shrinkwrap entry; suggest, don't fail
        console.log("   ℹ️  Optional: add 'npm-shrinkwrap.json merge=package-conflicts-resolver'")
        console.log("      (re-running 'package-conflicts-resolver setup' adds it)")
      }
    } else {
      console.log("⚠️  .gitattributes is incomplete:")
      if (!hasPackageJson) console.log("   Missing: package.json merge=package-conflicts-resolver")
      if (!hasPackageLock) console.log("   Missing: package-lock.json merge=package-conflicts-resolver")
      console.log("   Run: package-conflicts-resolver setup")
      hasErrors = true
    }
  } catch {
    console.log("⚠️  .gitattributes file not found")
    console.log("   ℹ️  .gitattributes is only needed for local repository setup")
  }

  // Check if package-conflicts-resolver is accessible
  try {
    const which = spawnCommand(IS_WINDOWS ? "where" : "which", ["npx"], {stdio: ["pipe", "pipe", "pipe"]})
    await new Promise<void>((resolve, reject) => {
      which.on("close", code => {
        if (code === 0) {
          console.log("✅ npx is available")
        } else {
          console.log("⚠️  npx not found in PATH")
          hasErrors = true
        }
        resolve()
      })
      which.on("error", () => {
        console.log("⚠️  npx not found in PATH")
        hasErrors = true
        resolve()
      })
    })
  } catch {
    console.log("⚠️  Could not verify npx availability")
  }

  console.log()
  if (hasErrors) {
    console.log("❌ Setup verification failed. Please fix the issues above.")
    console.log("\nTo fix, run: package-conflicts-resolver setup")
    process.exit(1)
  } else {
    console.log("✅ All checks passed! Git integration is set up correctly.")
    console.log("\nThe tool will now automatically resolve conflicts in package.json")
    console.log("and package-lock.json during Git merges.")
  }
}

/**
 * Uninstall Git integration
 */
async function uninstallGitIntegration(global: boolean, force: boolean): Promise<void> {
  const scope = global ? "--global" : "--local"

  console.log(`🗑️  Uninstalling Git integration ${global ? "globally" : "locally"}...`)

  // Check what configurations exist
  let hasLocal = false
  let hasGlobal = false

  try {
    // Check local config
    const localCheck = spawn("git", ["config", "--local", "merge.package-conflicts-resolver.driver"], {
      stdio: ["pipe", "pipe", "pipe"],
    })
    await new Promise<void>(resolve => {
      localCheck.on("close", code => {
        hasLocal = code === 0
        resolve()
      })
      localCheck.on("error", () => resolve())
    })

    // Check global config
    const globalCheck = spawn("git", ["config", "--global", "merge.package-conflicts-resolver.driver"], {
      stdio: ["pipe", "pipe", "pipe"],
    })
    await new Promise<void>(resolve => {
      globalCheck.on("close", code => {
        hasGlobal = code === 0
        resolve()
      })
      globalCheck.on("error", () => resolve())
    })
  } catch {
    // Ignore errors when checking
  }

  // Provide informative message about what will be removed
  if (global && hasLocal) {
    console.log("⚠️  This will remove the global Git configuration.")
    console.log("   The local repository configuration will remain unchanged.")
  } else if (!global && hasGlobal && !hasLocal) {
    console.log("ℹ️  Only global configuration found. Use --global to remove it.")
    console.log("   Or run: package-conflicts-resolver uninstall --global")
    return
  } else if (!global && !hasLocal && !hasGlobal) {
    console.log("ℹ️  No Git merge driver configuration found to remove.")
    return
  }

  if (!force) {
    console.log("\n⚠️  This will:")
    console.log("   • Remove Git merge driver configuration")
    if (!global) {
      console.log("   • Remove package-conflicts-resolver entries from .gitattributes")
    }
    console.log("\nProceed? (y/N)")

    // Simple confirmation - in a real implementation you might want to use a library like inquirer
    const {createInterface} = await import("readline")
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    })

    const answer = await new Promise<string>(resolve => {
      rl.question("", answer => {
        rl.close()
        resolve(answer.toLowerCase())
      })
    })

    if (!["y", "yes"].includes(answer)) {
      console.log("❌ Uninstallation cancelled.")
      return
    }
  }

  let hasErrors = false

  // Remove Git merge driver configuration
  try {
    console.log("\n🔧 Removing Git merge driver configuration...")

    // Remove the driver command
    const driverProcess = spawn("git", ["config", "--unset", scope, "merge.package-conflicts-resolver.driver"])
    await new Promise<void>((resolve, reject) => {
      driverProcess.on("close", code => {
        if (code === 0 || code === 1) {
          // 1 means the key didn't exist, which is fine
          console.log("✅ Removed merge driver configuration")
          resolve()
        } else {
          console.log(`❌ Failed to remove merge driver configuration (exit code ${code})`)
          hasErrors = true
          resolve()
        }
      })
      driverProcess.on("error", () => {
        console.log("❌ Failed to remove merge driver configuration")
        hasErrors = true
        resolve()
      })
    })

    // Remove the driver name (optional, don't fail if it doesn't exist)
    const nameProcess = spawn("git", ["config", "--unset", scope, "merge.package-conflicts-resolver.name"])
    await new Promise<void>(resolve => {
      nameProcess.on("close", code => {
        if (code === 0) {
          console.log("✅ Removed merge driver name")
        } else if (code === 1) {
          // Key didn't exist, which is fine
          console.log("✅ Merge driver name was not set")
        }
        resolve()
      })
      nameProcess.on("error", () => resolve()) // Ignore errors for optional cleanup
    })
  } catch (error) {
    console.log(`❌ Failed to remove Git merge driver: ${error instanceof Error ? error.message : String(error)}`)
    hasErrors = true
  }

  // Remove entries from .gitattributes (only for local uninstall)
  if (!global) {
    try {
      console.log("\n📝 Cleaning up .gitattributes file...")
      await cleanupGitattributes()
    } catch (error) {
      console.log(`❌ Failed to clean .gitattributes: ${error instanceof Error ? error.message : String(error)}`)
      hasErrors = true
    }
  }

  console.log()
  if (hasErrors) {
    console.log("❌ Uninstallation completed with errors. Some components may not have been removed.")
    process.exit(1)
  } else {
    console.log("✅ Git integration successfully uninstalled!")
    if (!global) {
      console.log("\nTo verify removal, run: package-conflicts-resolver verify")
    }
  }
}

/**
 * Remove package-conflicts-resolver entries from .gitattributes file
 */
async function cleanupGitattributes(): Promise<void> {
  const gitattributesPath = ".gitattributes"
  const entriesToRemove = GITATTRIBUTES_ENTRIES

  try {
    const content = await readFile(gitattributesPath, "utf8")
    const lines = content.split("\n")
    const filteredLines = lines.filter(line => {
      const trimmedLine = line.trim()
      return !entriesToRemove.includes(trimmedLine)
    })

    if (filteredLines.length !== lines.length) {
      const {writeFile} = await import("fs/promises")
      await writeFile(gitattributesPath, filteredLines.join("\n"), "utf8")

      const removedCount = lines.length - filteredLines.length
      console.log(`✅ Removed ${removedCount} package-conflicts-resolver entries from .gitattributes`)

      // Check if file is now empty and offer to remove it
      if (filteredLines.join("\n").trim() === "") {
        console.log("ℹ️  .gitattributes file is now empty.")
        console.log("   You may want to remove it if it's no longer needed.")
      }
    } else {
      console.log("✅ No package-conflicts-resolver entries found in .gitattributes")
    }
  } catch (error) {
    if ((error as any).code === "ENOENT") {
      console.log("✅ .gitattributes file does not exist (nothing to clean up)")
    } else {
      throw new Error(`Failed to clean .gitattributes: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

// Handle unhandled promise rejections
process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection:", reason)
  process.exit(1)
})

// Handle uncaught exceptions
process.on("uncaughtException", error => {
  console.error("Uncaught Exception:", error.message)
  process.exit(1)
})

if (require.main === module) {
  main().catch(error => {
    console.error("Fatal error:", error.message)
    process.exit(1)
  })
}
