#!/usr/bin/env node

/**
 * CLI entry point for package-conflicts-resolver
 */

import {Command} from "commander"
import {spawn} from "node:child_process"
import {readFileSync} from "node:fs"
import {basename, dirname, join, relative, resolve, sep} from "node:path"
import {createInterface} from "node:readline"
import {readFile, access, writeFile} from "fs/promises"
import {ConflictParser} from "./conflict-parser.js"
import {PackageResolver} from "./package-resolver.js"
import {Logger} from "./logger.js"
import {isGitMergeOutput, listUnmerged, onBothBranches, readMergeVersions} from "./git.js"
import {compareWithVersions} from "./merge-versions.js"
import {LOCKFILES, LockfileInfo, PackageManagerName, findLockfiles, resolveSafeRegenCommand} from "./package-manager.js"
import {formatLockfileIssues, isNpmLockfile, validateLockfile} from "./lockfile-validator.js"
import {spawnCommand} from "./process.js"
import {createNpmVersionLookup} from "./registry.js"
import {findPickProblems, parseVersionPicks, verifyVersionPicks} from "./version-picks.js"
import {findLockfileDir, matchesWorkspace, workspacePatterns} from "./workspaces.js"
import {
  ConflictReport,
  ConflictReportFile,
  formatConflictReport,
  reportFile,
  unanalyzedFile,
  unresolvedField,
} from "./conflict-report.js"
import {
  RESOLUTION_STRATEGIES,
  CliOptions,
  LockfileIssue,
  MergeVersions,
  PackageConflict,
  PackageJson,
  ResolutionResult,
  UnresolvedConflict,
} from "./types.js"

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

/** Exit code of `git config --unset` when the key is not set */
const GIT_CONFIG_KEY_NOT_SET = 5

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
 * Collect the values of a repeatable option
 */
function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value]
}

/**
 * Render a spawnable command as the string a user would type
 */
function formatCommand(cmd: {command: string; args: string[]}): string {
  return [cmd.command, ...cmd.args].join(" ")
}

/**
 * The folder whose lockfiles lock the target's dependencies: the target's own
 * folder, or the root of the workspace it is a member of.
 */
interface LockLocation {
  dir: string
  /** The folder as a path from the current one, when it is not the target's own folder */
  place?: string
}

async function locateLockfiles(dir: string, targetIsPackageJson: boolean): Promise<LockLocation> {
  const lockDir = targetIsPackageJson ? await findLockfileDir(dir) : dir
  return lockDir === dir ? {dir} : {dir: lockDir, place: relative(process.cwd(), lockDir) || "."}
}

/** A lockfile as messages name it: by its name next to the target, by its path from the current folder elsewhere */
function lockfileLabel(lock: LockLocation, name: string): string {
  return lock.place === undefined || lock.place === "." ? name : join(lock.place, name)
}

/** A command for the user to run, with the folder to run it in when that is neither the target's nor the current one */
function commandHint(lock: LockLocation, command: string): string {
  return lock.place === undefined || lock.place === "." ? `"${command}"` : `"${command}" in ${lock.place}`
}

/**
 * The versions of a conflicted file in Git's index, to resolve its content
 * from (see PackageResolver.resolveConflicts). When reading its values does
 * not show the content to be Git's merge of them, Git is asked whether it is
 * exactly that merge, line for line (see isGitMergeOutput).
 */
async function indexVersions(filePath: string, content: string): Promise<MergeVersions | undefined> {
  const versions = await readMergeVersions(filePath)
  if (versions === undefined || compareWithVersions(content, versions) === "follows") {
    return versions
  }
  return (await isGitMergeOutput(filePath, content)) ? {...versions, writtenByGit: true} : versions
}

/**
 * Run a lockfile command (e.g. "npm install --package-lock-only").
 * Resolves to false when the command fails or is not installed.
 *
 * When `quiet`, the command's output is discarded. It must never be piped
 * without being read: a pipe holds about 64 KB, and a package manager that
 * prints more (a verbose loglevel, a long ERESOLVE report, many deprecation
 * warnings) would block on the full pipe forever, and this command with it.
 */
function runLockfileCommand(cmd: {command: string; args: string[]}, cwd: string, quiet: boolean): Promise<boolean> {
  return new Promise(resolvePromise => {
    const child = spawnCommand(cmd.command, cmd.args, {stdio: quiet ? "ignore" : "inherit", cwd})
    child.on("close", code => resolvePromise(code === 0))
    child.on("error", () => resolvePromise(false))
  })
}

/**
 * Exit with `code` once everything written to stdout and stderr is flushed.
 *
 * process.exit() alone drops output that is still queued: on POSIX, writes to
 * a pipe are asynchronous, so whatever did not fit in the pipe buffer (64 KB)
 * is lost, cutting a large `--list --json` report short on its way to `jq` or
 * a CI log. The returned promise never settles: callers `return` it.
 */
async function flushAndExit(code: number): Promise<never> {
  await Promise.all([flushStream(process.stdout), flushStream(process.stderr)])
  process.exit(code)
}

/** Resolve once a stream has written out everything queued so far, or failed (its reader went away) */
function flushStream(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise(resolve => {
    stream.once("error", () => resolve())
    // Writes complete in order, so the callback of an empty write runs after every earlier one
    stream.write("", () => resolve())
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
    .option("-q, --quiet", "Suppress output except warnings and errors", false)
    .option("-j, --json", "Output in JSON format", false)
    .option("-v, --verbose", "Enable verbose logging", false)
    .option("--no-regenerate-lock", "Skip package-lock.json regeneration")
    .option("-l, --list", "List the conflicted packages with our and their versions, without changing anything", false)
    .option(
      "-p, --pick <name@version>",
      "Resolve a conflicted package to this version instead of using the strategy (repeatable)",
      collect
    )
    .option("--no-version-check", "Do not check that picked versions exist in the registry")
    .action(async (file: string, options: any) => {
      const cliOptions: CliOptions = {
        strategy: options.strategy,
        dryRun: options.dryRun,
        quiet: options.quiet,
        json: options.json,
        verbose: options.verbose,
        regenerateLock: options.regenerateLock,
        file,
        list: options.list,
        versionCheck: options.versionCheck,
      }

      // Validate strategy
      if (!Object.keys(RESOLUTION_STRATEGIES).includes(cliOptions.strategy)) {
        console.error(`❌ Invalid strategy: ${cliOptions.strategy}`)
        console.error(`Available strategies: ${Object.keys(RESOLUTION_STRATEGIES).join(", ")}`)
        return flushAndExit(1)
      }

      // Validate picked versions (their existence is checked once the conflicts are known)
      const {picks, errors} = parseVersionPicks(options.pick ?? [])
      if (errors.length > 0) {
        for (const error of errors) {
          console.error(`❌ Invalid --pick: ${error}`)
        }
        return flushAndExit(1)
      }
      if (Object.keys(picks).length > 0) {
        cliOptions.picks = picks
      }

      try {
        await resolvePackageConflicts(cliOptions)
      } catch (error) {
        console.error(`❌ Failed to resolve conflicts: ${error instanceof Error ? error.message : String(error)}`)
        return flushAndExit(1)
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
          // Preserve the current file's indentation and line endings; values left
          // for the user to decide are written between conflict markers
          const unresolved = result.unresolved ?? []
          await resolver.writeResolvedPackage(result.packageJson, current, currentContent, unresolved)

          // A dependency one branch removed stays removed: say whose change that dropped
          for (const conflict of droppedChanges(result)) {
            console.error(`package-conflicts-resolver: ${describeDroppedChange(conflict)}`)
          }

          // Those values are the user's to decide: a non-zero exit makes Git stop
          // before it commits the merge, with only them between markers
          if (unresolved.length > 0) {
            const them = unresolved.length === 1 ? "it" : "them"
            const pick = hasPickableConflicts(result) ? "--pick <package>@<version> or " : ""
            console.error(
              `package-conflicts-resolver: left ${countValues(unresolved)} between conflict markers for you to decide:`
            )
            for (const conflict of unresolved) {
              console.error(`  - ${describeUnresolved(conflict)}`)
            }
            console.error(
              `package-conflicts-resolver: everything else is merged. Edit ${them}, or run package-conflicts-resolver ${pick}--strategy ours (or theirs) on the file.`
            )
            return flushAndExit(1)
          }

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
            return flushAndExit(1)
          }

          return flushAndExit(0) // Success
        } else {
          // Non-zero exit tells Git the file is still conflicted
          console.error(`package-conflicts-resolver: could not auto-resolve merge: ${result.errors.join(", ")}`)
          return flushAndExit(1)
        }
      } catch (error) {
        console.error(
          `package-conflicts-resolver: merge driver failed: ${error instanceof Error ? error.message : String(error)}`
        )
        return flushAndExit(1) // Error
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
        return flushAndExit(1)
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
        return flushAndExit(1)
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
        return flushAndExit(1)
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
    return flushAndExit(1)
  }

  // Read file content
  const content = await readFile(filePath, "utf8")
  const targetIsPackageJson = basename(resolve(filePath)) === "package.json"
  const dir = dirname(resolve(filePath))
  const lock = await locateLockfiles(dir, targetIsPackageJson)

  // --list and --pick look at every conflict before anything is written
  if (options.list || options.picks !== undefined) {
    await checkBeforeResolving(filePath, content, options, lock)
  }

  const targetHasConflicts = ConflictParser.hasConflicts(content)
  let resolvedTarget = false
  let packageJsonDocument: PackageJson | undefined
  // Values of the target the strategy cannot decide, left for the user
  let unresolved: UnresolvedConflict[] = []
  // Whether package specs are among them, which a version picked for the package decides
  let pickable = false
  // Dependencies of the target one branch removed while the other changed them: they stay removed
  let dropped: PackageConflict[] = []
  const inconsistent: InconsistentLockfile[] = []

  if (targetHasConflicts) {
    if (!options.quiet && !options.json) {
      console.log(`🔧 Found Git conflict markers in ${filePath}, proceeding with resolution...`)
    }

    // Create resolver and resolve conflicts, from the versions in Git's index when the file is still Git's merge of them
    const resolver = new PackageResolver(options)
    const result = await resolver.resolveConflicts(content, await indexVersions(filePath, content))

    if (!result.resolved) {
      console.error(`❌ Failed to resolve conflicts: ${result.errors.join(", ")}`)
      return flushAndExit(1)
    }

    if (result.packageJson) {
      // Write resolved package.json (preserving original indentation/line endings),
      // with conflict markers around the values left for the user to decide
      unresolved = result.unresolved ?? []
      pickable = hasPickableConflicts(result)
      dropped = droppedChanges(result)
      await resolver.writeResolvedPackage(result.packageJson, filePath, content, unresolved)
      resolvedTarget = true

      if (targetIsPackageJson) {
        packageJsonDocument = result.packageJson
      } else if (isNpmLockfile(result.packageJson)) {
        // The target is a lockfile itself: check it against the package.json next to it
        const issues = lockfileIssuesFor(result.packageJson, result.lockfileIssues, await readSiblingPackageJson(dir))
        if (issues.length > 0) {
          inconsistent.push({name: basename(filePath), issues})
        }
      }
    }
  } else if (targetIsPackageJson) {
    packageJsonDocument = parsePackageJson(content)
  }

  // What the root entry of a lockfile is checked against: the package.json next to it, which is the target (as it
  // was just merged) unless the lockfile is at the root of the target's workspace
  const packageJsonForLock = async () =>
    targetIsPackageJson && lock.place === undefined ? packageJsonDocument : readSiblingPackageJson(lock.dir)

  // Package managers cannot read a package.json that still has conflict
  // markers: lockfiles are not regenerated until the user has decided
  const lockOptions: CliOptions = unresolved.length > 0 ? {...options, regenerateLock: false} : options

  // When the target is a package.json, also resolve its conflicted
  // lockfiles: Git conflicts often hit only the lockfile even when
  // package.json merges cleanly.
  let lockStatus: LockResolutionStatus = {
    resolved: 0,
    failed: [],
    inconsistent: [],
    regenerated: new Set(),
    merged: new Set(),
  }
  if (targetIsPackageJson) {
    lockStatus = await resolveCompanionLockfiles(lock, lockOptions, await packageJsonForLock())
  }
  inconsistent.push(...lockStatus.inconsistent)

  // npm lockfiles without conflict markers that Git still lists as conflicted: the merge driver merged them, and
  // left them for npm to regenerate
  const unmerged = await listUnmerged(lock.dir)
  const pending = await findPendingLockfiles(
    lock,
    targetIsPackageJson
      ? LOCKFILES.filter(lockfile => lockfile.jsonMergeable && !lockStatus.merged.has(lockfile.name))
      : LOCKFILES.filter(lockfile => lockfile.jsonMergeable && lockfile.name === basename(filePath) && !resolvedTarget),
    unmerged
  )

  if (!targetHasConflicts && lockStatus.resolved === 0 && lockStatus.failed.length === 0 && pending.length === 0) {
    const targetUnmerged = unmerged.has(relative(lock.dir, resolve(filePath)).split(sep).join("/"))
    if (!options.quiet) {
      if (options.json) {
        console.log(
          JSON.stringify({
            level: "info",
            message: `No Git conflict markers found in ${filePath}`,
            data: {conflicts: 0, ...(targetUnmerged ? {unmerged: true} : {})},
            timestamp: new Date().toISOString(),
          })
        )
      } else if (targetUnmerged) {
        console.log(`✅ No Git conflict markers found in ${filePath}`)
        console.log(`\nℹ️  Git still lists ${filePath} as conflicted.`)
        console.log(`   Check that it has the changes of both branches, then run: git add ${filePath}`)
      } else {
        console.log(`✅ No Git conflict markers found in ${filePath}`)
        console.log(`\nℹ️  If you expected automatic conflict resolution during Git merge:`)
        console.log(`   1. Run: package-conflicts-resolver setup`)
        console.log(`   2. Run: package-conflicts-resolver verify`)
        console.log(`   3. Ensure conflicts happen in package.json or package-lock.json`)
      }
    }
    return flushAndExit(0)
  }

  if (!options.quiet && !options.json) {
    for (const lockfile of pending) {
      console.log(`🔧 ${lockfile.name} has no conflict markers, but Git still lists it as conflicted`)
    }
  }

  // Regenerate lockfiles so they are consistent with the merged package.json
  let regenerated = new Set<string>(lockStatus.regenerated)
  if (
    (resolvedTarget || lockStatus.resolved > 0 || lockStatus.failed.length > 0 || pending.length > 0) &&
    lockOptions.regenerateLock &&
    !options.dryRun
  ) {
    // ...once no other package.json they are made from has conflict markers left
    const conflicted = await conflictedManifests(lock, unmerged, resolve(filePath))
    if (conflicted.length > 0) {
      await reportRegenerationWaiting(lock, conflicted, options)
    } else {
      regenerated = await regenerateLockfiles(lock, options, lockStatus.regenerated)
    }
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
  } else {
    // Not regenerated: a lockfile Git still lists as conflicted is checked as it is
    for (const lockfile of pending) {
      const introduced = introducedIssues(lockfile.document, await readMergeVersions(lockfile.path))
      const issues = lockfileIssuesFor(lockfile.document, introduced, await packageJsonForLock())
      if (issues.length > 0) {
        inconsistent.push({name: lockfile.name, issues, merged: true})
      } else if (!options.quiet && !options.json) {
        console.log(`✅ ${lockfile.name} is consistent: run "git add" on it to mark it as resolved`)
      }
    }
  }

  // Non-npm lockfiles already printed their package manager's instructions
  // when they were detected; npm lockfiles get theirs here, after regeneration
  // had its chance.
  for (const entry of failed.filter(entry => entry.packageManager === "npm")) {
    console.error(`❌ ${entry.name} still has Git conflict markers.`)
    console.error(
      `   Run ${commandHint(lock, entry.manualCommand)} (npm resolves conflicted lockfiles itself), or delete ${entry.name} and run it again to recreate the file.`
    )
  }

  if (inconsistent.length > 0) {
    reportInconsistentLockfiles(inconsistent, options, lock)
  }

  if (dropped.length > 0) {
    reportDroppedChanges(filePath, dropped, options)
  }

  if (unresolved.length > 0) {
    await reportUnresolved(filePath, unresolved, pickable, options, lock)
  }

  const exitWithError = failed.length > 0 || (inconsistent.length > 0 && !options.dryRun) || unresolved.length > 0
  return flushAndExit(exitWithError ? 1 : 0)
}

/** "a value", or "3 values" */
function countValues(unresolved: UnresolvedConflict[]): string {
  return unresolved.length === 1 ? "a value" : `${unresolved.length} values`
}

/** A value left for the user, and why: "scripts.build: both branches changed it, and it is not a version" */
function describeUnresolved(conflict: UnresolvedConflict): string {
  switch (conflict.reason) {
    case "removed":
      return conflict.ours === undefined
        ? `${conflict.field}: our branch removed it, their branch changed it`
        : `${conflict.field}: their branch removed it, our branch changed it`
    case "not-comparable":
      return `${conflict.field}: both branches changed it, to versions that cannot be compared (${String(conflict.ours)} and ${String(conflict.theirs)})`
    default:
      return `${conflict.field}: both branches changed it, and it is not a version`
  }
}

/**
 * Dependencies of a package.json that one branch removed while the other
 * changed them: they stay removed, and that change is dropped. None for a
 * lockfile, which follows package.json.
 */
function droppedChanges(result: ResolutionResult): PackageConflict[] {
  if (isNpmLockfile(result.packageJson)) {
    return []
  }
  return (result.packageConflicts ?? []).filter(conflict => conflict.resolvedBy === "removal")
}

/** "dependencies.lodash: our branch removed it, their change to ^4.17.21 was dropped" */
function describeDroppedChange(conflict: PackageConflict): string {
  const field = conflict.path.join(".")
  return conflict.ours === null
    ? `${field}: our branch removed it, their change to ${conflict.theirs} was dropped`
    : `${field}: their branch removed it, our change to ${conflict.ours} was dropped`
}

/** Tell the user which dependencies stayed removed, and whose change that dropped */
function reportDroppedChanges(filePath: string, dropped: PackageConflict[], options: CliOptions): void {
  const one = dropped.length === 1
  const stay = options.dryRun ? "would stay" : one ? "stays" : "stay"
  const lines = [
    `${one ? "A dependency" : `${dropped.length} dependencies`} one branch removed ${stay} removed in ${filePath}, without the other branch's ${one ? "change" : "changes"}:`,
    ...dropped.map(conflict => `   - ${describeDroppedChange(conflict)}`),
    `   ${one ? "Add it back if it is still needed." : "Add back any that are still needed."}`,
  ]

  const logger = new Logger({quiet: options.quiet, json: options.json, verbose: options.verbose})
  logger.warn(lines.join("\n"), {
    droppedChanges: dropped.map(conflict => ({
      field: conflict.path.join("."),
      package: conflict.name,
      removedBy: conflict.ours === null ? "ours" : "theirs",
      change: conflict.ours ?? conflict.theirs,
      base: conflict.base,
    })),
  })
}

/** Whether package specs are among the values left for the user: picking a version decides those */
function hasPickableConflicts(result: ResolutionResult): boolean {
  return (result.packageConflicts ?? []).some(conflict => conflict.resolvedBy === "user")
}

/**
 * Tell the user which values of the target were left for them to decide, and
 * how to finish: they stay between conflict markers, and lockfiles wait.
 */
async function reportUnresolved(
  filePath: string,
  unresolved: UnresolvedConflict[],
  pickable: boolean,
  options: CliOptions,
  lock: LockLocation
): Promise<void> {
  const them = unresolved.length === 1 ? "it" : "them"
  const lines = [
    `${options.dryRun ? "Would leave" : "Left"} ${countValues(unresolved)} between conflict markers in ${filePath} for you to decide:`,
    ...unresolved.map(conflict => `   - ${describeUnresolved(conflict)}`),
    `   Everything else is merged. Edit ${them}, or run again with ${pickable ? "--pick <package>@<version>, " : ""}--strategy ours or --strategy theirs.`,
  ]
  const lockfiles = options.regenerateLock && !options.dryRun ? await findLockfiles(lock.dir) : []
  if (lockfiles.length > 0) {
    lines.push(
      `   Lockfiles were not regenerated: once ${filePath} is decided, run ${manualCommands(lock, lockfiles)}.`
    )
  }

  const logger = new Logger({quiet: options.quiet, json: options.json, verbose: options.verbose})
  logger.warn(lines.join("\n"), {unresolved: unresolved.map(unresolvedField)})
}

/**
 * Run before resolving when packages are listed or versions picked: resolve
 * every conflicted file in memory to learn which packages conflict, then
 * either print them (--list, which ends the command) or validate the picks.
 * Invalid picks end the command before any file is written.
 */
async function checkBeforeResolving(
  filePath: string,
  content: string,
  options: CliOptions,
  lock: LockLocation
): Promise<void> {
  const dir = dirname(resolve(filePath))
  const {files, failed} = await analyzeConflicts(filePath, content, options, lock)
  const check = options.picks !== undefined ? await checkPicks(options.picks, files, options, dir) : undefined

  if (options.list) {
    const report: ConflictReport = {strategy: options.strategy, files}
    if (options.json) {
      console.log(JSON.stringify(report))
    } else {
      for (const line of formatConflictReport(report)) {
        console.log(line)
      }
    }
    for (const warning of check?.warnings ?? []) {
      console.warn(`⚠️  ${warning}`)
    }
    for (const error of check?.errors ?? []) {
      console.error(`❌ ${error}`)
    }
    return flushAndExit(failed || (check?.errors.length ?? 0) > 0 ? 1 : 0)
  }

  // A target that cannot be resolved fails exactly like it does without picks
  const target = files.find(file => file.file === filePath)
  if (target !== undefined && !target.analyzed) {
    console.error(`❌ Failed to resolve conflicts: ${target.reason}`)
    return flushAndExit(1)
  }

  const logger = new Logger({quiet: options.quiet, json: options.json, verbose: options.verbose})
  // check is always set here: without --list this only runs for --pick
  const {errors, warnings, verified} = check as PickCheck
  for (const warning of warnings) {
    logger.warn(warning)
  }
  if (errors.length > 0) {
    for (const error of errors) {
      console.error(`❌ ${error}`)
    }
    console.error("   No file was changed.")
    return flushAndExit(1)
  }

  for (const message of verified) {
    logger.success(message)
  }
  if (options.versionCheck === false) {
    logger.info("Picked versions were not checked against the registry (--no-version-check)")
  }

  // A picked version that neither branch locked gets locked by npm, from the picked spec
  if (options.regenerateLock && !options.dryRun) {
    const conflicts = files.flatMap(file => file.packages.map(conflict => ({...conflict, file: file.file})))
    const pickedSpecs = new Set(conflicts.filter(c => c.kind === "spec" && c.resolvedBy === "pick").map(c => c.name))
    for (const conflict of conflicts) {
      const topLevel = conflict.location === `node_modules/${conflict.name}`
      if (topLevel && conflict.resolvedBy !== "pick" && pickedSpecs.has(conflict.name)) {
        logger.info(
          `${conflict.name}@${conflict.pick} is not locked on either branch of ${conflict.file}; npm locks it when regenerating the lockfile`
        )
      }
    }
  }
}

/**
 * Resolve, in memory only, every conflicted file the command works on: the
 * target, plus the conflicted lockfiles of a package.json target.
 * Nothing is written or printed. `failed` tells whether a file this tool
 * merges could not be resolved.
 */
async function analyzeConflicts(
  filePath: string,
  content: string,
  options: CliOptions,
  lock: LockLocation
): Promise<{files: ConflictReportFile[]; failed: boolean}> {
  const files: ConflictReportFile[] = []
  let failed = false
  const analyze = async (file: string, path: string, text: string) => {
    const resolver = new PackageResolver({...options, silent: true})
    const result = await resolver.resolveConflicts(text, await indexVersions(path, text))
    failed = failed || !result.resolved
    files.push(reportFile(file, result))
  }

  if (ConflictParser.hasConflicts(content)) {
    await analyze(filePath, filePath, content)
  }

  if (basename(resolve(filePath)) === "package.json") {
    for (const lockfile of LOCKFILES) {
      const lockPath = join(lock.dir, lockfile.name)
      let lockContent: string
      try {
        lockContent = await readFile(lockPath, "utf8")
      } catch {
        continue // Lockfile doesn't exist
      }
      if (!ConflictParser.hasConflicts(lockContent)) {
        continue
      }
      if (lockfile.jsonMergeable) {
        await analyze(lockfileLabel(lock, lockfile.name), lockPath, lockContent)
      } else {
        const reason = `${lockfile.packageManager} resolves it when you run ${commandHint(lock, lockfile.manualCommand)}`
        files.push(unanalyzedFile(lockfileLabel(lock, lockfile.name), reason))
      }
    }
  }

  return {files, failed}
}

interface PickCheck {
  errors: string[]
  /** Picks that could not be checked and are used as given */
  warnings: string[]
  /** Picks found in the registry */
  verified: string[]
}

/**
 * Check every pick: its package must be conflicted and the pick must apply
 * to at least one of the conflicts, and its version must exist (unless
 * --no-version-check). Versions are only looked up for picks that apply.
 */
async function checkPicks(
  picks: Record<string, string>,
  files: ConflictReportFile[],
  options: CliOptions,
  dir: string
): Promise<PickCheck> {
  const conflicts = files.flatMap(file => file.packages.map(conflict => ({...conflict, file: file.file})))
  const problems = findPickProblems(picks, conflicts)
  const check: PickCheck = {errors: problems.map(problem => problem.message), warnings: [], verified: []}

  const applicable = Object.fromEntries(
    Object.entries(picks).filter(([name]) => !problems.some(problem => problem.name === name))
  )
  if (options.versionCheck === false || Object.keys(applicable).length === 0) {
    return check
  }

  const lookup = createNpmVersionLookup({cwd: dir})
  for (const verification of await verifyVersionPicks(applicable, {lookup, cwd: dir})) {
    if (verification.status === "error") {
      check.errors.push(verification.message)
    } else if (verification.status === "unverified") {
      check.warnings.push(verification.message)
    } else {
      check.verified.push(verification.message)
    }
  }
  return check
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
  /** The file was merged before this run: the merge driver's work, which Git still lists as conflicted */
  merged?: boolean
}

interface LockResolutionStatus {
  resolved: number
  /** Lockfiles that still contain conflict markers */
  failed: FailedLockfile[]
  /** Merged npm lockfiles whose dependency graph is not satisfiable */
  inconsistent: InconsistentLockfile[]
  /** Package managers whose regeneration command already ran */
  regenerated: Set<string>
  /** Names of the npm lockfiles this run merged */
  merged: Set<string>
}

/** An npm lockfile without conflict markers that Git still lists as conflicted */
interface PendingLockfile {
  /** The file, as messages name it */
  name: string
  path: string
  document: Record<string, any>
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
function lockfileIssuesFor(
  merged: PackageJson | undefined,
  introduced: LockfileIssue[] | undefined,
  packageJson: PackageJson | undefined
): LockfileIssue[] {
  if (!merged || !isNpmLockfile(merged)) {
    return []
  }

  const issues = new Map<string, LockfileIssue>()

  for (const issue of introduced ?? []) {
    issues.set(issueKey(issue), issue)
  }
  if (packageJson) {
    for (const issue of validateLockfile(merged, packageJson)) {
      if (issue.from === "") {
        issues.set(issueKey(issue), issue)
      }
    }
  }

  return [...issues.values()]
}

function issueKey(issue: LockfileIssue): string {
  return `${issue.from} ${issue.name} ${issue.spec}`
}

/**
 * The unsatisfied edges of a merged lockfile that neither branch's version of
 * it already had: the ones its merge introduced. Every unsatisfied edge when
 * the versions are not known.
 */
function introducedIssues(merged: Record<string, any>, versions: MergeVersions | undefined): LockfileIssue[] {
  const before = new Set<string>()
  for (const text of versions !== undefined ? [versions.ours, versions.theirs] : []) {
    const document = parsePackageJson(text)
    if (isNpmLockfile(document)) {
      for (const issue of validateLockfile(document)) {
        before.add(issueKey(issue))
      }
    }
  }
  return validateLockfile(merged).filter(issue => !before.has(issueKey(issue)))
}

/**
 * The npm lockfiles among `candidates` that have no conflict markers although
 * Git still lists them as unmerged, with a version on both branches. That is
 * how the merge driver leaves a lockfile it merged into an inconsistent
 * dependency graph: for npm to regenerate. A lockfile one branch deleted is
 * not among them: whether it should exist is not for npm to decide.
 */
async function findPendingLockfiles(
  lock: LockLocation,
  candidates: LockfileInfo[],
  unmerged: Map<string, Set<number>>
): Promise<PendingLockfile[]> {
  const pending: PendingLockfile[] = []
  for (const lockfile of candidates) {
    if (!onBothBranches(unmerged.get(lockfile.name))) {
      continue
    }
    const path = join(lock.dir, lockfile.name)
    let content: string
    try {
      content = await readFile(path, "utf8")
    } catch {
      continue // Deleted from the work tree
    }
    const document = ConflictParser.hasConflicts(content) ? undefined : parsePackageJson(content)
    if (isNpmLockfile(document)) {
      pending.push({name: lockfileLabel(lock, lockfile.name), path, document})
    }
  }
  return pending
}

/**
 * The package.json files a package manager reads to make the lockfiles, other
 * than the target, that Git lists as unmerged and that still have conflict
 * markers: the one next to the lockfiles, and the ones of its workspaces. A
 * package manager cannot read them, so regenerating has to wait for them.
 */
async function conflictedManifests(
  lock: LockLocation,
  unmerged: Map<string, Set<number>>,
  target: string
): Promise<string[]> {
  const candidates = [...unmerged.keys()].filter(path => path === "package.json" || path.endsWith("/package.json"))
  if (candidates.length === 0) {
    return []
  }

  const workspaces = await workspacePatterns(lock.dir)
  const conflicted: string[] = []
  for (const path of candidates) {
    const folder = path.split("/").slice(0, -1)
    const absolute = join(lock.dir, ...folder, "package.json")
    if (absolute === target || (folder.length > 0 && !matchesWorkspace(workspaces, folder.join("/")))) {
      continue
    }
    try {
      if (ConflictParser.hasConflicts(await readFile(absolute, "utf8"))) {
        conflicted.push(relative(process.cwd(), absolute))
      }
    } catch {
      // Deleted from the work tree: nothing for a package manager to trip over
    }
  }
  return conflicted
}

/** The commands that regenerate lockfiles, for the user to run: "npm install --package-lock-only" and "yarn install" */
function manualCommands(lock: LockLocation, lockfiles: LockfileInfo[]): string {
  return [...new Set(lockfiles.map(lockfile => commandHint(lock, lockfile.manualCommand)))].join(" and ")
}

/** Tell the user that lockfiles were not regenerated because other package.json files are still conflicted */
async function reportRegenerationWaiting(lock: LockLocation, conflicted: string[], options: CliOptions): Promise<void> {
  const lockfiles = await findLockfiles(lock.dir)
  if (lockfiles.length === 0) {
    return // Lockless project: nothing was waiting to be regenerated
  }
  const one = conflicted.length === 1
  const logger = new Logger({quiet: options.quiet, json: options.json, verbose: options.verbose})
  logger.warn(
    `Lockfiles were not regenerated: ${conflicted.join(", ")} still ${one ? "has" : "have"} conflicts. Once ${one ? "it is" : "they are"} resolved, run ${manualCommands(lock, lockfiles)}.`,
    {conflicted}
  )
}

function reportInconsistentLockfiles(entries: InconsistentLockfile[], options: CliOptions, lock: LockLocation): void {
  for (const {name, issues, merged} of entries) {
    const noun = issues.length === 1 ? "dependency" : "dependencies"
    if (options.dryRun) {
      if (options.quiet) continue
      console.warn(
        merged
          ? `⚠️  ${name} has ${issues.length} unsatisfied ${noun}; regenerating it with npm fixes this:`
          : `⚠️  ${name} would be merged with ${issues.length} unsatisfied ${noun}; regenerating it with npm fixes this:`
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
        `   \`npm ci\` would reject this lockfile. Run ${commandHint(lock, "npm install --package-lock-only")} to regenerate ${name}.`
      )
    }
  }
}

/**
 * Resolve conflicts in the lockfiles of a package.json: the ones next to it,
 * or at the root of its workspace. JSON lockfiles (npm) are merged
 * semantically; other package managers' lockfiles are delegated to the
 * manager itself, which resolves conflicted lockfiles automatically.
 * `packageJsonDocument` is the package.json next to the lockfiles.
 */
async function resolveCompanionLockfiles(
  lock: LockLocation,
  options: CliOptions,
  packageJsonDocument?: PackageJson
): Promise<LockResolutionStatus> {
  const dir = lock.dir
  const status: LockResolutionStatus = {
    resolved: 0,
    failed: [],
    inconsistent: [],
    regenerated: new Set(),
    merged: new Set(),
  }

  for (const lockfile of LOCKFILES) {
    const lockPath = join(dir, lockfile.name)
    const name = lockfileLabel(lock, lockfile.name)

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
      console.log(`🔧 Found Git conflict markers in ${name}, resolving...`)
    }

    // npm lockfiles are JSON: merge them semantically
    if (lockfile.jsonMergeable) {
      const resolver = new PackageResolver({...options, file: lockPath})
      const result = await resolver.resolveConflicts(lockContent, await indexVersions(lockPath, lockContent))

      if (result.resolved && result.packageJson) {
        await resolver.writeResolvedPackage(result.packageJson, lockPath, lockContent)
        status.resolved++
        status.merged.add(lockfile.name)

        const issues = lockfileIssuesFor(result.packageJson, result.lockfileIssues, packageJsonDocument)
        if (issues.length > 0) {
          status.inconsistent.push({name, issues})
        }
      } else {
        status.failed.push({
          name,
          path: lockPath,
          packageManager: lockfile.packageManager,
          manualCommand: lockfile.manualCommand,
        })
        console.error(`❌ Could not auto-resolve ${name}: ${result.errors.join(", ")}`)
      }
      continue
    }

    // yarn/pnpm/bun lockfiles: delegate to the package manager
    if (options.dryRun) {
      if (!options.quiet && !options.json) {
        console.log(`ℹ Would resolve ${name} by running ${commandHint(lock, lockfile.manualCommand)}`)
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
          console.log(`✅ Resolved ${name} via "${formatCommand(safeRegenCommand)}"`)
        }
        continue
      }
    }

    status.failed.push({
      name,
      path: lockPath,
      packageManager: lockfile.packageManager,
      manualCommand: lockfile.manualCommand,
    })
    console.error(`❌ ${name} has Git conflicts that this tool does not merge directly.`)
    console.error(
      `   Run ${commandHint(lock, lockfile.manualCommand)} — ${lockfile.packageManager} resolves conflicted lockfiles automatically.`
    )
    console.error(`   If that fails, delete ${name} and run "${lockfile.manualCommand}" to recreate it.`)
  }

  return status
}

/**
 * Regenerate existing lockfiles with their own package manager so they stay
 * consistent with the merged package.json. Never creates a lockfile for a
 * package manager the project doesn't use. Returns the package managers whose
 * lockfile was regenerated successfully (including the ones passed in).
 */
async function regenerateLockfiles(
  lock: LockLocation,
  options: CliOptions,
  alreadyRegenerated: Set<string>
): Promise<Set<string>> {
  const regenerated = new Set<string>(alreadyRegenerated)
  const lockfiles = await findLockfiles(lock.dir)
  if (lockfiles.length === 0) {
    return regenerated // Lockless project: nothing to regenerate
  }

  // Progress goes through the logger so `--json` keeps stdout machine-readable
  const logger = new Logger({quiet: options.quiet, json: options.json, verbose: options.verbose})
  const handled = new Set<string>(alreadyRegenerated)

  for (const lockfile of lockfiles) {
    if (handled.has(lockfile.packageManager)) continue
    handled.add(lockfile.packageManager)

    const name = lockfileLabel(lock, lockfile.name)
    const safeRegenCommand = await resolveSafeRegenCommand(lock.dir, lockfile)
    if (!safeRegenCommand) {
      logger.info(`Run ${commandHint(lock, lockfile.manualCommand)} to update ${name} after this merge.`)
      continue
    }

    logger.info(`Regenerating ${name} with ${lockfile.packageManager}...`)
    // The package manager's own output would corrupt --json stdout
    const ok = await runLockfileCommand(safeRegenCommand, lock.dir, options.quiet || options.json)
    if (ok) {
      regenerated.add(lockfile.packageManager)
      logger.success(`Regenerated ${name}`)
    } else if (!options.quiet) {
      logger.warn(`Failed to regenerate ${name}`)
      logger.info(`You may need to run ${commandHint(lock, lockfile.manualCommand)} manually`)
    }
  }

  return regenerated
}

/**
 * Setup Git integration
 */
async function setupGitIntegration(global: boolean, skipGitattributes: boolean = false): Promise<void> {
  const scope = global ? "--global" : "--local"

  // Setup merge driver (a failure is reported by the setup command)
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

  // The name only labels the driver in Git's messages: setup succeeds even if setting it fails
  await new Promise<void>(resolve => {
    const done = () => resolve()
    nameProcess.on("close", done)
    nameProcess.on("error", done)
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
    return flushAndExit(1)
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
  if (global && !hasGlobal) {
    if (hasLocal) {
      console.log("ℹ️  Only local configuration found. Run without --global to remove it.")
      console.log("   Or run: package-conflicts-resolver uninstall")
    } else {
      console.log("ℹ️  No global Git merge driver configuration found to remove.")
    }
    return
  }

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
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    })

    const answer = await new Promise<string>(resolve => {
      let settled = false
      const settle = (value: string) => {
        if (settled) return
        settled = true
        resolve(value)
      }
      rl.question("", answer => {
        // settle before close(): rl.close() fires the "close" listener
        // synchronously, and the answer must win that race
        settle(answer.toLowerCase())
        rl.close()
      })
      // stdin may end without an answer (hooks, CI): treat EOF as "no" so the
      // command cannot hang waiting for input that will never come. A real
      // answer settles first, so this only fires when none was given.
      rl.on("close", () => settle(""))
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
        if (code === 0 || code === GIT_CONFIG_KEY_NOT_SET) {
          // The key is gone either way
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
        } else if (code === GIT_CONFIG_KEY_NOT_SET) {
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
    return flushAndExit(1)
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
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error // reported by the caller
    }
    console.log("✅ .gitattributes file does not exist (nothing to clean up)")
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
    return flushAndExit(1)
  })
}
