#!/usr/bin/env node

/**
 * CLI entry point for package-conflicts-resolver
 */

import {Command} from "commander"
import {readFile, access} from "fs/promises"
import {spawn} from "child_process"
import {PackageResolver} from "./package-resolver.js"
import {RESOLUTION_STRATEGIES, CliOptions} from "./types.js"

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
      console.log(`  package.json merge=package-conflicts-resolver`)
      console.log(`  package-lock.json merge=package-conflicts-resolver`)
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
    const requiredLines = [
      "package.json merge=package-conflicts-resolver",
      "package-lock.json merge=package-conflicts-resolver",
    ]

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
    console.log(`  package.json merge=package-conflicts-resolver`)
    console.log(`  package-lock.json merge=package-conflicts-resolver`)
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

    const hasPackageJson = lines.some(line => line.trim() === "package.json merge=package-conflicts-resolver")
    const hasPackageLock = lines.some(line => line.trim() === "package-lock.json merge=package-conflicts-resolver")

    if (hasPackageJson && hasPackageLock) {
      console.log("✅ .gitattributes is configured correctly")
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
    const which = spawn("which", ["npx"], {stdio: ["pipe", "pipe", "pipe"]})
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
  const entriesToRemove = [
    "package.json merge=package-conflicts-resolver",
    "package-lock.json merge=package-conflicts-resolver",
  ]

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
