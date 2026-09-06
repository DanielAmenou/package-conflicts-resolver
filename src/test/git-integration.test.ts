/**
 * Git integration end-to-end tests: run setup/verify/uninstall against a real
 * temporary Git repository, and drive an actual `git merge` through the
 * configured merge driver.
 */

import {strict as assert} from "assert"
import {test, describe} from "node:test"
import {spawn} from "node:child_process"
import {mkdtemp, readFile, writeFile, rm} from "fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"

const CLI_PATH = join(__dirname, "..", "cli.js")

interface RunResult {
  code: number | null
  stdout: string
  stderr: string
}

function run(command: string, args: string[], cwd: string, stdin?: string): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {cwd, stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"]})
    let stdout = ""
    let stderr = ""
    child.stdout?.on("data", chunk => (stdout += chunk))
    child.stderr?.on("data", chunk => (stderr += chunk))
    child.on("error", reject)
    child.on("close", code => resolvePromise({code, stdout, stderr}))
    if (stdin !== undefined && child.stdin) {
      child.stdin.write(stdin)
      child.stdin.end()
    }
  })
}

const runCli = (args: string[], cwd: string, stdin?: string) => run(process.execPath, [CLI_PATH, ...args], cwd, stdin)
const runGit = (args: string[], cwd: string) => run("git", args, cwd)

async function withGitRepo<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pcr-git-"))
  try {
    await runGit(["init", "-b", "main"], dir)
    // Local identity so commits work regardless of the host's git config
    await runGit(["config", "user.name", "Test"], dir)
    await runGit(["config", "user.email", "test@example.com"], dir)
    return await fn(dir)
  } finally {
    await rm(dir, {recursive: true, force: true})
  }
}

async function commitAll(dir: string, message: string): Promise<void> {
  await runGit(["add", "-A"], dir)
  const result = await runGit(["commit", "-m", message], dir)
  assert.equal(result.code, 0, result.stderr)
}

const EXPECTED_ENTRIES = [
  "package.json merge=package-conflicts-resolver",
  "package-lock.json merge=package-conflicts-resolver",
  "npm-shrinkwrap.json merge=package-conflicts-resolver",
]

describe("setup command", () => {
  test("configures the merge driver and creates .gitattributes", async () => {
    await withGitRepo(async dir => {
      const result = await runCli(["setup"], dir)
      assert.equal(result.code, 0, result.stderr)

      const driver = await runGit(["config", "--local", "merge.package-conflicts-resolver.driver"], dir)
      assert.equal(driver.code, 0, "merge driver must be configured")
      assert(driver.stdout.includes("package-conflicts-resolver merge-driver"))

      const attributes = await readFile(join(dir, ".gitattributes"), "utf8")
      for (const entry of EXPECTED_ENTRIES) {
        assert(attributes.includes(entry), `missing entry: ${entry}`)
      }
    })
  })

  test("preserves existing .gitattributes content and only appends missing lines", async () => {
    await withGitRepo(async dir => {
      await writeFile(join(dir, ".gitattributes"), "*.png binary\npackage.json merge=package-conflicts-resolver\n")

      const result = await runCli(["setup"], dir)
      assert.equal(result.code, 0, result.stderr)

      const attributes = await readFile(join(dir, ".gitattributes"), "utf8")
      assert(attributes.startsWith("*.png binary\n"), "existing content must be preserved")
      for (const entry of EXPECTED_ENTRIES) {
        assert(attributes.includes(entry), `missing entry: ${entry}`)
      }
      // The pre-existing package.json line must not be duplicated
      const packageJsonLines = attributes
        .split("\n")
        .filter(line => line.trim() === "package.json merge=package-conflicts-resolver")
      assert.equal(packageJsonLines.length, 1, "existing entry must not be duplicated")
    })
  })

  test("is idempotent: a second run does not duplicate entries", async () => {
    await withGitRepo(async dir => {
      await runCli(["setup"], dir)
      const first = await readFile(join(dir, ".gitattributes"), "utf8")

      const result = await runCli(["setup"], dir)
      assert.equal(result.code, 0, result.stderr)
      assert.equal(await readFile(join(dir, ".gitattributes"), "utf8"), first)
    })
  })

  test("--skip-gitattributes leaves .gitattributes alone", async () => {
    await withGitRepo(async dir => {
      const result = await runCli(["setup", "--skip-gitattributes"], dir)
      assert.equal(result.code, 0, result.stderr)
      await assert.rejects(readFile(join(dir, ".gitattributes"), "utf8"), ".gitattributes must not be created")
    })
  })
})

describe("verify command", () => {
  test("passes after setup", async () => {
    await withGitRepo(async dir => {
      await runCli(["setup"], dir)
      const result = await runCli(["verify"], dir)
      assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`)
      assert(result.stdout.includes("All checks passed"))
    })
  })

  test("fails before setup", async () => {
    await withGitRepo(async dir => {
      const result = await runCli(["verify"], dir)
      assert.equal(result.code, 1)
      assert(result.stdout.includes("NOT configured"))
    })
  })

  test("suggests the shrinkwrap entry for setups from older versions", async () => {
    await withGitRepo(async dir => {
      await runCli(["setup"], dir)
      // Simulate a legacy setup that predates the npm-shrinkwrap.json entry
      await writeFile(
        join(dir, ".gitattributes"),
        "package.json merge=package-conflicts-resolver\npackage-lock.json merge=package-conflicts-resolver\n"
      )

      const result = await runCli(["verify"], dir)
      assert.equal(result.code, 0, "a legacy setup must still verify cleanly")
      assert(result.stdout.includes("npm-shrinkwrap.json"), "should suggest the shrinkwrap entry")
    })
  })
})

describe("uninstall command", () => {
  test("--force removes the merge driver and .gitattributes entries", async () => {
    await withGitRepo(async dir => {
      await writeFile(join(dir, ".gitattributes"), "*.md text\n")
      await runCli(["setup"], dir)

      const result = await runCli(["uninstall", "--force"], dir)
      assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`)

      const driver = await runGit(["config", "--local", "merge.package-conflicts-resolver.driver"], dir)
      assert.notEqual(driver.code, 0, "merge driver config must be removed")

      const attributes = await readFile(join(dir, ".gitattributes"), "utf8")
      for (const entry of EXPECTED_ENTRIES) {
        assert(!attributes.includes(entry), `entry must be removed: ${entry}`)
      }
      assert(attributes.includes("*.md text"), "unrelated entries must be preserved")
    })
  })

  test("without --force, answering 'n' cancels and keeps the configuration", async () => {
    await withGitRepo(async dir => {
      await runCli(["setup"], dir)

      const result = await runCli(["uninstall"], dir, "n\n")
      assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`)
      assert(result.stdout.includes("cancelled"), "should report cancellation")

      const driver = await runGit(["config", "--local", "merge.package-conflicts-resolver.driver"], dir)
      assert.equal(driver.code, 0, "merge driver must still be configured")
    })
  })

  test("without --force, answering 'y' proceeds with removal", async () => {
    await withGitRepo(async dir => {
      await runCli(["setup"], dir)

      const result = await runCli(["uninstall"], dir, "y\n")
      assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`)

      const driver = await runGit(["config", "--local", "merge.package-conflicts-resolver.driver"], dir)
      assert.notEqual(driver.code, 0, "merge driver config must be removed")
    })
  })

  test("reports when there is nothing to uninstall", async () => {
    await withGitRepo(async dir => {
      const result = await runCli(["uninstall", "--force"], dir)
      assert.equal(result.code, 0)
      assert(result.stdout.includes("No Git merge driver configuration found"))
    })
  })
})

describe("real git merge through the merge driver", () => {
  test("auto-resolves conflicting package.json changes during git merge", async () => {
    await withGitRepo(async dir => {
      // Point the driver at this build directly (setup would configure npx,
      // which resolves to the published package, not the code under test).
      await runGit(
        [
          "config",
          "merge.package-conflicts-resolver.driver",
          `"${process.execPath}" "${CLI_PATH}" merge-driver %A %O %B`,
        ],
        dir
      )

      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({name: "app", version: "1.0.0", dependencies: {lodash: "^4.17.20"}}, null, 2) + "\n"
      )
      await writeFile(join(dir, ".gitattributes"), "package.json merge=package-conflicts-resolver\n")
      await commitAll(dir, "base")

      await runGit(["checkout", "-b", "feature"], dir)
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({name: "app", version: "1.2.0", dependencies: {lodash: "^4.17.20", react: "^18.0.0"}}, null, 2) +
          "\n"
      )
      await commitAll(dir, "feature work")

      await runGit(["checkout", "main"], dir)
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify(
          {name: "app", version: "1.1.0", dependencies: {lodash: "^4.17.21", express: "^4.18.0"}},
          null,
          2
        ) + "\n"
      )
      await commitAll(dir, "main work")

      const merge = await runGit(["merge", "feature"], dir)
      assert.equal(merge.code, 0, `merge should auto-resolve: ${merge.stdout}\n${merge.stderr}`)

      const merged = JSON.parse(await readFile(join(dir, "package.json"), "utf8"))
      assert.equal(merged.version, "1.2.0")
      assert.deepEqual(merged.dependencies, {
        lodash: "^4.17.21",
        express: "^4.18.0",
        react: "^18.0.0",
      })
    })
  })

  test("auto-resolves a package-lock.json conflict during git merge", async () => {
    await withGitRepo(async dir => {
      await runGit(
        [
          "config",
          "merge.package-conflicts-resolver.driver",
          `"${process.execPath}" "${CLI_PATH}" merge-driver %A %O %B`,
        ],
        dir
      )

      const makeLock = (version: string) =>
        JSON.stringify(
          {
            name: "app",
            lockfileVersion: 3,
            packages: {
              "node_modules/lodash": {
                version,
                resolved: `https://registry.npmjs.org/lodash/-/lodash-${version}.tgz`,
                integrity: `sha512-${version}`,
              },
            },
          },
          null,
          2
        ) + "\n"

      await writeFile(join(dir, "package-lock.json"), makeLock("4.17.19"))
      await writeFile(join(dir, ".gitattributes"), "package-lock.json merge=package-conflicts-resolver\n")
      await commitAll(dir, "base")

      await runGit(["checkout", "-b", "feature"], dir)
      await writeFile(join(dir, "package-lock.json"), makeLock("4.17.21"))
      await commitAll(dir, "feature bump")

      await runGit(["checkout", "main"], dir)
      await writeFile(join(dir, "package-lock.json"), makeLock("4.17.20"))
      await commitAll(dir, "main bump")

      const merge = await runGit(["merge", "feature"], dir)
      assert.equal(merge.code, 0, `merge should auto-resolve: ${merge.stdout}\n${merge.stderr}`)

      const entry = JSON.parse(await readFile(join(dir, "package-lock.json"), "utf8")).packages["node_modules/lodash"]
      assert.equal(entry.version, "4.17.21")
      assert.equal(entry.integrity, "sha512-4.17.21", "integrity must travel with the winning version")
    })
  })
})

describe("real git merge: package.json and package-lock.json together", () => {
  const pkg = (deps: Record<string, string>) =>
    JSON.stringify({name: "app", version: "1.0.0", dependencies: deps}, null, 2) + "\n"

  const lockEntry = (name: string, version: string) => ({
    version,
    resolved: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
    integrity: `sha512-${name}-${version}`,
  })

  const lock = (deps: Record<string, string>, versions: Record<string, string>) =>
    JSON.stringify(
      {
        name: "app",
        version: "1.0.0",
        lockfileVersion: 3,
        requires: true,
        packages: {
          "": {name: "app", version: "1.0.0", dependencies: deps},
          ...Object.fromEntries(
            Object.entries(versions).map(([name, version]) => [`node_modules/${name}`, lockEntry(name, version)])
          ),
        },
      },
      null,
      2
    ) + "\n"

  async function configureDriver(dir: string): Promise<void> {
    await runGit(
      [
        "config",
        "merge.package-conflicts-resolver.driver",
        `"${process.execPath}" "${CLI_PATH}" merge-driver %A %O %B`,
      ],
      dir
    )
    await writeFile(
      join(dir, ".gitattributes"),
      "package.json merge=package-conflicts-resolver\npackage-lock.json merge=package-conflicts-resolver\n"
    )
  }

  test("one-sided changes on each branch merge into a consistent lockfile", async () => {
    await withGitRepo(async dir => {
      await configureDriver(dir)
      await writeFile(join(dir, "package.json"), pkg({foo: "^1.5.0", bar: "^1.0.0"}))
      await writeFile(
        join(dir, "package-lock.json"),
        lock({foo: "^1.5.0", bar: "^1.0.0"}, {foo: "1.5.0", bar: "1.0.0"})
      )
      await commitAll(dir, "base")

      // feature pins foo lower; main bumps bar: neither touches the other's package
      await runGit(["checkout", "-b", "feature"], dir)
      await writeFile(join(dir, "package.json"), pkg({foo: "1.2.0", bar: "^1.0.0"}))
      await writeFile(join(dir, "package-lock.json"), lock({foo: "1.2.0", bar: "^1.0.0"}, {foo: "1.2.0", bar: "1.0.0"}))
      await commitAll(dir, "pin foo")

      await runGit(["checkout", "main"], dir)
      await writeFile(join(dir, "package.json"), pkg({foo: "^1.5.0", bar: "^1.1.0"}))
      await writeFile(
        join(dir, "package-lock.json"),
        lock({foo: "^1.5.0", bar: "^1.1.0"}, {foo: "1.5.0", bar: "1.1.0"})
      )
      await commitAll(dir, "bump bar")

      const merge = await runGit(["merge", "feature"], dir)
      assert.equal(merge.code, 0, `merge should auto-resolve: ${merge.stdout}\n${merge.stderr}`)

      const mergedPkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"))
      assert.deepEqual(mergedPkg.dependencies, {foo: "1.2.0", bar: "^1.1.0"})

      const mergedLock = JSON.parse(await readFile(join(dir, "package-lock.json"), "utf8"))
      assert.deepEqual(mergedLock.packages[""].dependencies, {foo: "1.2.0", bar: "^1.1.0"})
      assert.equal(mergedLock.packages["node_modules/foo"].version, "1.2.0")
      assert.equal(mergedLock.packages["node_modules/foo"].integrity, "sha512-foo-1.2.0")
      assert.equal(mergedLock.packages["node_modules/bar"].version, "1.1.0")
    })
  })

  test("leaves package-lock.json conflicted when the merged graph is inconsistent", async () => {
    await withGitRepo(async dir => {
      await configureDriver(dir)
      await writeFile(join(dir, "package.json"), pkg({foo: "^1.0.0"}))
      await writeFile(join(dir, "package-lock.json"), lock({foo: "^1.0.0"}, {foo: "1.0.0"}))
      await commitAll(dir, "base")

      // feature pins foo to 1.2.0 (package.json + lockfile)
      await runGit(["checkout", "-b", "feature"], dir)
      await writeFile(join(dir, "package.json"), pkg({foo: "1.2.0"}))
      await writeFile(join(dir, "package-lock.json"), lock({foo: "1.2.0"}, {foo: "1.2.0"}))
      await commitAll(dir, "pin foo")

      // main only refreshed the lockfile to foo 1.5.0 (still within ^1.0.0)
      await runGit(["checkout", "main"], dir)
      await writeFile(join(dir, "package-lock.json"), lock({foo: "^1.0.0"}, {foo: "1.5.0"}))
      await commitAll(dir, "refresh lock")

      const merge = await runGit(["merge", "feature"], dir)
      assert.notEqual(merge.code, 0, "the merge must stop on the inconsistent lockfile")
      assert.match(merge.stderr, /merged lockfile is not consistent/)
      assert.match(merge.stderr, /the root project requires foo@1\.2\.0 but node_modules\/foo is 1\.5\.0/)
      assert.match(merge.stderr, /npm install --package-lock-only/)

      // package.json only changed on feature: Git took it as-is
      assert.deepEqual(JSON.parse(await readFile(join(dir, "package.json"), "utf8")).dependencies, {foo: "1.2.0"})

      // The lockfile is left unmerged for npm, with the best-effort merge in the worktree (no markers)
      const status = await runGit(["status", "--porcelain"], dir)
      assert.match(status.stdout, /^UU package-lock\.json$/m)
      const lockContent = await readFile(join(dir, "package-lock.json"), "utf8")
      assert(!lockContent.includes("<<<<<<<"), "no conflict markers in the merged lockfile")
      const mergedLock = JSON.parse(lockContent)
      assert.equal(mergedLock.packages[""].dependencies.foo, "1.2.0")
      assert.equal(mergedLock.packages["node_modules/foo"].version, "1.5.0")

      // Simulate what `npm install --package-lock-only` produces, then finish the merge
      await writeFile(join(dir, "package-lock.json"), lock({foo: "1.2.0"}, {foo: "1.2.0"}))
      await runGit(["add", "package-lock.json"], dir)
      const commit = await runGit(["commit", "--no-edit"], dir)
      assert.equal(commit.code, 0, commit.stderr)
    })
  })

  test("--allow-inconsistent-lockfile lets the merge through", async () => {
    await withGitRepo(async dir => {
      await configureDriver(dir)
      await runGit(
        [
          "config",
          "merge.package-conflicts-resolver.driver",
          `"${process.execPath}" "${CLI_PATH}" merge-driver %A %O %B --allow-inconsistent-lockfile`,
        ],
        dir
      )
      await writeFile(join(dir, "package.json"), pkg({foo: "^1.0.0"}))
      await writeFile(join(dir, "package-lock.json"), lock({foo: "^1.0.0"}, {foo: "1.0.0"}))
      await commitAll(dir, "base")

      await runGit(["checkout", "-b", "feature"], dir)
      await writeFile(join(dir, "package.json"), pkg({foo: "1.2.0"}))
      await writeFile(join(dir, "package-lock.json"), lock({foo: "1.2.0"}, {foo: "1.2.0"}))
      await commitAll(dir, "pin foo")

      await runGit(["checkout", "main"], dir)
      await writeFile(join(dir, "package-lock.json"), lock({foo: "^1.0.0"}, {foo: "1.5.0"}))
      await commitAll(dir, "refresh lock")

      const merge = await runGit(["merge", "feature"], dir)
      assert.equal(merge.code, 0, `merge should be accepted: ${merge.stdout}\n${merge.stderr}`)
    })
  })
})
