#!/usr/bin/env node

/**
 * CLI entry point for package-conflicts-resolver
 */

import {Command} from "commander"
import {readFile, access} from "fs/promises"
import {spawn} from "child_process"
import {promisify} from "util"
import {PackageResolver} from "./package-resolver.js"
import {Logger} from "./logger.js"
import {RESOLUTION_STRATEGIES, CliOptions} from "./types.js"

const execAsync = promisify(spawn)

async function main() {
  const program = new Command()

  program
    .name("package-conflicts-resolver")
    .description("Automatically resolve conflicts in package.json and package-lock.json files")
    .version("0.1.0")

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
    .option("--no-regenerate-lock", "Skip package-lock.json regeneration", false)
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
    .action(async (current: string, base: string, other: string, options: any) => {
      try {
        const content = await readFile(current, "utf8")

        const cliOptions: CliOptions = {
          strategy: options.strategy,
          dryRun: false,
          quiet: true,
          json: false,
          verbose: false,
          regenerateLock: true,
          file: current,
        }

        const resolver = new PackageResolver(cliOptions)
        const result = await resolver.resolveConflicts(content)

        if (result.resolved && result.packageJson) {
          await resolver.writeResolvedPackage(result.packageJson, current)
          process.exit(0) // Success
        } else {
          process.exit(1) // Conflict not resolved
        }
      } catch (error) {
        process.exit(1) // Error
      }
    })

  // Setup subcommand for Git integration
  program
    .command("setup")
    .description("Setup Git integration (merge driver and hooks)")
    .option("--global", "Setup globally for all repositories", false)
    .action(async (options: any) => {
      try {
        await setupGitIntegration(options.global)
      } catch (error) {
        console.error(`❌ Failed to setup Git integration: ${error instanceof Error ? error.message : String(error)}`)
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

  // Check if file has conflicts
  if (!content.includes("<<<<<<< HEAD")) {
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
        console.log(`ℹ️ No Git conflict markers found in ${filePath}`)
      }
    }
    process.exit(0)
    return
  }

  if (!options.quiet && !options.json) {
    console.log(`🔧 Found Git conflict markers, proceeding with resolution...`)
  }

  // Create resolver and resolve conflicts
  const resolver = new PackageResolver(options)
  const result = await resolver.resolveConflicts(content)

  if (!result.resolved) {
    console.error(`❌ Failed to resolve conflicts: ${result.errors.join(", ")}`)
    process.exit(1)
  }

  if (result.packageJson) {
    // Write resolved package.json
    await resolver.writeResolvedPackage(result.packageJson, filePath)

    // Regenerate package-lock.json if requested
    if (options.regenerateLock && !options.dryRun) {
      await regeneratePackageLock(options.quiet)
    }
  }

  process.exit(0)
}

/**
 * Regenerate package-lock.json using npm install
 */
async function regeneratePackageLock(quiet: boolean): Promise<void> {
  if (!quiet) {
    console.log("ℹ Regenerating package-lock.json...")
  }

  try {
    const npmProcess = spawn("npm", ["install", "--package-lock-only"], {
      stdio: quiet ? "pipe" : "inherit",
    })

    await new Promise<void>((resolve, reject) => {
      npmProcess.on("close", code => {
        if (code === 0) {
          if (!quiet) {
            console.log("✅ Successfully regenerated package-lock.json")
          }
          resolve()
        } else {
          reject(new Error(`npm install failed with exit code ${code}`))
        }
      })

      npmProcess.on("error", reject)
    })
  } catch (error) {
    if (!quiet) {
      console.warn(
        `⚠️ Failed to regenerate package-lock.json: ${error instanceof Error ? error.message : String(error)}`
      )
      console.log('ℹ You may need to run "npm install" manually')
    }
  }
}

/**
 * Setup Git integration
 */
async function setupGitIntegration(global: boolean): Promise<void> {
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

    if (!global) {
      console.log("ℹ To complete setup, add this to your .gitattributes file:")
      console.log("package.json merge=package-conflicts-resolver")
      console.log("package-lock.json merge=package-conflicts-resolver")
    }
  } catch (error) {
    throw new Error(`Failed to setup Git integration: ${error instanceof Error ? error.message : String(error)}`)
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

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error("Fatal error:", error.message)
    process.exit(1)
  })
}
