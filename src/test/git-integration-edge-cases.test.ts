/**
 * Setup, verify and uninstall away from the happy path: outside a repository,
 * without git, with files the tool cannot write, and with a configuration that
 * is partial or points at another tool. Every case runs with a throwaway
 * global Git configuration, so nothing touches the developer's or the CI
 * runner's own.
 */

import {strict as assert} from "assert"
import {test, describe} from "node:test"
import {chmod, mkdir, readFile, rm, writeFile} from "fs/promises"
import {delimiter, join} from "node:path"
import {run, runCli, RunResult, withTempDir} from "./cli-harness.js"

// Stubbed executables need a POSIX shell, and PATH is not swapped reliably on Windows
const SKIP_ON_WINDOWS = process.platform === "win32" ? "stubbed executables need a POSIX shell" : false

// Running as root defeats permission-based tests
const SKIP_AS_ROOT =
  typeof process.getuid === "function" && process.getuid() === 0 ? "permission checks are meaningless as root" : false

const ENTRIES = [
  "package.json merge=package-conflicts-resolver",
  "package-lock.json merge=package-conflicts-resolver",
  "npm-shrinkwrap.json merge=package-conflicts-resolver",
] as const

const DRIVER_KEY = "merge.package-conflicts-resolver.driver"
const NAME_KEY = "merge.package-conflicts-resolver.name"
const DRIVER = "npx package-conflicts-resolver merge-driver %A %O %B"

interface Repo {
  dir: string
  cli(args: string[], env?: Record<string, string>): Promise<RunResult>
  git(args: string[]): Promise<RunResult>
  /** A new directory holding executable shell scripts, by name (for PATH) */
  stubs(scripts: Record<string, string>): Promise<string>
}

/**
 * Run `fn` in a fresh Git repository, or with `init: false` in a plain folder
 * that Git cannot mistake for part of an enclosing repository.
 */
async function withRepo<T>(fn: (repo: Repo) => Promise<T>, {init = true} = {}): Promise<T> {
  return withTempDir(async root => {
    const dir = join(root, "project")
    await mkdir(dir)
    const globalConfig = join(root, "gitconfig")
    await writeFile(globalConfig, "", "utf8")
    const env = {
      GIT_CONFIG_GLOBAL: globalConfig,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CEILING_DIRECTORIES: root,
      HOME: root,
    }
    const git = (args: string[]) => run("git", args, dir, env)
    if (init) {
      await git(["init", "-b", "main"])
    }

    let bins = 0
    return fn({
      dir,
      cli: (args, extraEnv = {}) => runCli(args, dir, {...env, ...extraEnv}),
      git,
      async stubs(scripts) {
        const bin = join(root, `bin-${bins++}`)
        await mkdir(bin)
        for (const [name, body] of Object.entries(scripts)) {
          await writeFile(join(bin, name), `#!/bin/sh\n${body}\n`, "utf8")
          await chmod(join(bin, name), 0o755)
        }
        return bin
      },
    })
  })
}

const output = (result: RunResult) => `${result.stdout}\n${result.stderr}`

describe("setup that cannot finish", () => {
  test("outside a Git repository it fails with a single, unprefixed reason", async () => {
    await withRepo(
      async repo => {
        const result = await repo.cli(["setup"])
        assert.equal(result.code, 1)
        assert.match(result.stderr, /❌ Failed to setup Git integration: git config failed with exit code \d+/)
        assert.doesNotMatch(
          result.stderr,
          /Failed to setup Git integration: Failed/,
          "the reason is not prefixed twice"
        )
        await assert.rejects(readFile(join(repo.dir, ".gitattributes"), "utf8"), ".gitattributes must not be written")
      },
      {init: false}
    )
  })

  test("a missing git executable is reported", {skip: SKIP_ON_WINDOWS}, async () => {
    await withRepo(async repo => {
      const result = await repo.cli(["setup"], {PATH: await repo.stubs({})})
      assert.equal(result.code, 1)
      assert.match(result.stderr, /❌ Failed to setup Git integration: spawn git ENOENT/)
    })
  })

  test("failing to set the driver's display name does not fail setup", {skip: SKIP_ON_WINDOWS}, async () => {
    await withRepo(async repo => {
      // A git that accepts every command except setting the name
      const bin = await repo.stubs({git: `case "$*" in *${NAME_KEY}*) exit 1 ;; esac\nexit 0`})

      const result = await repo.cli(["setup"], {PATH: bin})
      assert.equal(result.code, 0, output(result))
      assert.match(result.stdout, /Git merge driver configured locally/)
      assert.match(result.stdout, /Setup complete/)
    })
  })
})

describe("setup and .gitattributes", () => {
  test("appends its entries on a new line when the file does not end with one", async () => {
    await withRepo(async repo => {
      await writeFile(join(repo.dir, ".gitattributes"), "*.png binary", "utf8")

      const result = await repo.cli(["setup"])
      assert.equal(result.code, 0, output(result))
      assert.match(result.stdout, /Updated \.gitattributes file/)
      assert.equal(
        await readFile(join(repo.dir, ".gitattributes"), "utf8"),
        ["*.png binary", ...ENTRIES, ""].join("\n")
      )
    })
  })

  test("a .gitattributes it cannot write is reported with the lines to add by hand", async () => {
    await withRepo(async repo => {
      await mkdir(join(repo.dir, ".gitattributes"))

      const result = await repo.cli(["setup"])
      assert.equal(result.code, 0, `the merge driver itself is configured: ${output(result)}`)
      assert.match(result.stderr, /Could not setup \.gitattributes automatically/)
      assert.match(result.stdout, /Please manually add these lines to your \.gitattributes file/)
      for (const entry of ENTRIES) {
        assert(result.stdout.includes(`  ${entry}`), `should list: ${entry}`)
      }
      assert.equal((await repo.git(["config", "--local", DRIVER_KEY])).code, 0)
    })
  })
})

describe("verify flags each problem", () => {
  test("a local driver that runs another tool", async () => {
    await withRepo(async repo => {
      await repo.git(["config", "--local", DRIVER_KEY, "some-other-tool %A"])
      await writeFile(join(repo.dir, ".gitattributes"), ENTRIES.join("\n") + "\n", "utf8")

      const result = await repo.cli(["verify"])
      assert.equal(result.code, 1)
      assert.match(result.stdout, /Git merge driver is configured \(local\) but may be incorrect/)
      assert.match(result.stdout, /Driver: some-other-tool %A/)
    })
  })

  test("an incomplete .gitattributes, naming each missing entry", async () => {
    await withRepo(async repo => {
      await repo.cli(["setup"])
      const [packageJson, packageLock] = ENTRIES

      await writeFile(join(repo.dir, ".gitattributes"), `${packageJson}\n`, "utf8")
      const withoutLock = await repo.cli(["verify"])
      assert.equal(withoutLock.code, 1)
      assert.match(withoutLock.stdout, /\.gitattributes is incomplete/)
      assert(withoutLock.stdout.includes(`Missing: ${packageLock}`), withoutLock.stdout)
      assert(!withoutLock.stdout.includes(`Missing: ${packageJson}`), withoutLock.stdout)

      await writeFile(join(repo.dir, ".gitattributes"), `${packageLock}\n`, "utf8")
      const withoutManifest = await repo.cli(["verify"])
      assert.equal(withoutManifest.code, 1)
      assert(withoutManifest.stdout.includes(`Missing: ${packageJson}`), withoutManifest.stdout)
      assert(!withoutManifest.stdout.includes(`Missing: ${packageLock}`), withoutManifest.stdout)
    })
  })

  test("npx missing from PATH", {skip: SKIP_ON_WINDOWS}, async () => {
    await withRepo(async repo => {
      await repo.cli(["setup"])
      // `which` finds nothing, while git stays reachable
      const bin = await repo.stubs({which: "exit 1"})

      const result = await repo.cli(["verify"], {PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`})
      assert.equal(result.code, 1)
      assert.match(result.stdout, /Git merge driver is configured \(local\)/)
      assert.match(result.stdout, /\.gitattributes is configured correctly/)
      assert.match(result.stdout, /npx not found in PATH/)
    })
  })

  test("a missing git executable", {skip: SKIP_ON_WINDOWS}, async () => {
    await withRepo(async repo => {
      const result = await repo.cli(["verify"], {PATH: await repo.stubs({})})
      assert.equal(result.code, 1)
      assert.match(result.stdout, /Failed to check local git config/)
      assert.match(result.stdout, /npx not found in PATH/)
      assert.match(result.stdout, /Setup verification failed/)
    })
  })
})

describe("uninstall away from the happy path", () => {
  test("--global with no global configuration says so and succeeds", async () => {
    await withRepo(async repo => {
      const result = await repo.cli(["uninstall", "--global", "--force"])
      assert.equal(result.code, 0, output(result))
      assert.match(result.stdout, /No global Git merge driver configuration found to remove/)
      assert.doesNotMatch(result.stdout, /Failed to remove/)
    })
  })

  test("--global with only a local configuration leaves it alone and says how to remove it", async () => {
    await withRepo(async repo => {
      await repo.cli(["setup"])

      const result = await repo.cli(["uninstall", "--global", "--force"])
      assert.equal(result.code, 0, output(result))
      assert.match(result.stdout, /Only local configuration found/)
      assert.equal((await repo.git(["config", "--local", DRIVER_KEY])).code, 0, "the local driver must stay")
      assert.match(await readFile(join(repo.dir, ".gitattributes"), "utf8"), /package-conflicts-resolver/)
    })
  })

  test("a driver configured without a display name", async () => {
    await withRepo(async repo => {
      await repo.cli(["setup"])
      await repo.git(["config", "--local", "--unset", NAME_KEY])

      const result = await repo.cli(["uninstall", "--force"])
      assert.equal(result.code, 0, output(result))
      assert.match(result.stdout, /Removed merge driver configuration/)
      assert.match(result.stdout, /Merge driver name was not set/)
    })
  })

  test("a .gitattributes without entries of this tool is left untouched", async () => {
    await withRepo(async repo => {
      await repo.git(["config", "--local", DRIVER_KEY, DRIVER])
      await writeFile(join(repo.dir, ".gitattributes"), "*.md text\n", "utf8")

      const result = await repo.cli(["uninstall", "--force"])
      assert.equal(result.code, 0, output(result))
      assert.match(result.stdout, /No package-conflicts-resolver entries found in \.gitattributes/)
      assert.equal(await readFile(join(repo.dir, ".gitattributes"), "utf8"), "*.md text\n")
    })
  })

  test("a missing .gitattributes is nothing to clean up", async () => {
    await withRepo(async repo => {
      await repo.git(["config", "--local", DRIVER_KEY, DRIVER])

      const result = await repo.cli(["uninstall", "--force"])
      assert.equal(result.code, 0, output(result))
      assert.match(result.stdout, /\.gitattributes file does not exist \(nothing to clean up\)/)
      assert.notEqual((await repo.git(["config", "--local", DRIVER_KEY])).code, 0, "the driver must be removed")
    })
  })

  test("a .gitattributes it cannot read fails the uninstall with a single, unprefixed reason", async () => {
    await withRepo(async repo => {
      await repo.cli(["setup"])
      await rm(join(repo.dir, ".gitattributes"))
      await mkdir(join(repo.dir, ".gitattributes"))

      const result = await repo.cli(["uninstall", "--force"])
      assert.equal(result.code, 1)
      assert.match(result.stdout, /❌ Failed to clean \.gitattributes: \S/)
      assert.doesNotMatch(result.stdout, /Failed to clean \.gitattributes: Failed/, "the reason is not prefixed twice")
      assert.match(result.stdout, /Uninstallation completed with errors/)
      assert.notEqual((await repo.git(["config", "--local", DRIVER_KEY])).code, 0, "the driver is still removed")
    })
  })

  test("a Git config it cannot write fails the uninstall", {skip: SKIP_ON_WINDOWS || SKIP_AS_ROOT}, async () => {
    await withRepo(async repo => {
      await repo.cli(["setup"])
      const gitDir = join(repo.dir, ".git")
      await chmod(gitDir, 0o555) // git cannot create .git/config.lock

      try {
        const result = await repo.cli(["uninstall", "--force"])
        assert.equal(result.code, 1)
        assert.match(result.stdout, /Failed to remove merge driver configuration \(exit code \d+\)/)
        assert.match(result.stdout, /Uninstallation completed with errors/)
      } finally {
        await chmod(gitDir, 0o755)
      }
      assert.equal((await repo.git(["config", "--local", DRIVER_KEY])).code, 0, "the driver is still configured")
    })
  })

  test("without git there is no configuration it can find to remove", {skip: SKIP_ON_WINDOWS}, async () => {
    await withRepo(async repo => {
      const bin = await repo.stubs({})
      for (const args of [
        ["uninstall", "--force"],
        ["uninstall", "--global", "--force"],
      ]) {
        const result = await repo.cli(args, {PATH: bin})
        assert.equal(result.code, 0, output(result))
        assert.match(result.stdout, /No (global )?Git merge driver configuration found to remove/)
      }
    })
  })
})
