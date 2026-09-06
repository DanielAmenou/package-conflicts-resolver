/**
 * End-to-end CLI tests: run the real built binary against temp files and
 * verify outputs, exit codes, dry-run behavior, JSON mode, and the
 * merge-driver subcommand exactly as Git invokes it.
 */

import {strict as assert} from "assert"
import {test, describe} from "node:test"
import {spawn} from "node:child_process"
import {mkdtemp, readFile, writeFile, rm} from "fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"

const CLI_PATH = join(__dirname, "..", "cli.js")

interface CliResult {
  code: number | null
  stdout: string
  stderr: string
}

function runCli(args: string[], cwd: string): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {cwd, stdio: ["ignore", "pipe", "pipe"]})
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", chunk => (stdout += chunk))
    child.stderr.on("data", chunk => (stderr += chunk))
    child.on("error", reject)
    child.on("close", code => resolve({code, stdout, stderr}))
  })
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pcr-cli-"))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, {recursive: true, force: true})
  }
}

const CONFLICTED = [
  "{",
  '  "name": "app",',
  "<<<<<<< HEAD",
  '  "version": "1.1.0"',
  "=======",
  '  "version": "1.2.0"',
  ">>>>>>> feature",
  "}",
  "",
].join("\n")

describe("CLI end-to-end", () => {
  test("resolves a conflicted package.json and exits 0", async () => {
    await withTempDir(async dir => {
      const file = join(dir, "package.json")
      await writeFile(file, CONFLICTED, "utf8")

      const result = await runCli(["package.json", "--no-regenerate-lock"], dir)
      assert.equal(result.code, 0, result.stderr)

      const written = JSON.parse(await readFile(file, "utf8"))
      assert.equal(written.version, "1.2.0")
      assert.equal(written.name, "app")
    })
  })

  test("supports the lowest strategy via flag", async () => {
    await withTempDir(async dir => {
      const file = join(dir, "package.json")
      await writeFile(file, CONFLICTED, "utf8")

      const result = await runCli(["package.json", "--strategy", "lowest", "--no-regenerate-lock"], dir)
      assert.equal(result.code, 0, result.stderr)

      const written = JSON.parse(await readFile(file, "utf8"))
      assert.equal(written.version, "1.1.0")
    })
  })

  test("dry run leaves the file untouched", async () => {
    await withTempDir(async dir => {
      const file = join(dir, "package.json")
      await writeFile(file, CONFLICTED, "utf8")

      const result = await runCli(["package.json", "--dry-run", "--no-regenerate-lock"], dir)
      assert.equal(result.code, 0, result.stderr)

      const content = await readFile(file, "utf8")
      assert.equal(content, CONFLICTED, "dry run must not modify the file")
    })
  })

  test("exits 0 with a friendly message when there are no conflicts", async () => {
    await withTempDir(async dir => {
      const file = join(dir, "package.json")
      await writeFile(file, '{\n  "name": "clean"\n}\n', "utf8")

      const result = await runCli(["package.json", "--no-regenerate-lock"], dir)
      assert.equal(result.code, 0)
      assert(result.stdout.includes("No Git conflict markers"))
    })
  })

  test("exits 1 for a missing file", async () => {
    await withTempDir(async dir => {
      const result = await runCli(["does-not-exist.json", "--no-regenerate-lock"], dir)
      assert.equal(result.code, 1)
      assert(result.stderr.includes("File not found"))
    })
  })

  test("exits 1 for an invalid strategy", async () => {
    await withTempDir(async dir => {
      const file = join(dir, "package.json")
      await writeFile(file, CONFLICTED, "utf8")

      const result = await runCli(["package.json", "--strategy", "bogus", "--no-regenerate-lock"], dir)
      assert.equal(result.code, 1)
      assert(result.stderr.includes("Invalid strategy"))
    })
  })

  test("--json mode emits machine-readable lines only", async () => {
    await withTempDir(async dir => {
      const file = join(dir, "package.json")
      await writeFile(file, CONFLICTED, "utf8")

      const result = await runCli(["package.json", "--json", "--dry-run", "--no-regenerate-lock"], dir)
      assert.equal(result.code, 0, result.stderr)

      const lines = result.stdout.split("\n").filter(line => line.trim() !== "")
      assert(lines.length > 0, "expected JSON output")
      for (const line of lines) {
        assert.doesNotThrow(() => JSON.parse(line), `not valid JSON: ${line}`)
      }
    })
  })

  test("--version reports the package.json version", async () => {
    await withTempDir(async dir => {
      const result = await runCli(["--version"], dir)
      assert.equal(result.code, 0)

      const packageJson = JSON.parse(await readFile(join(__dirname, "..", "..", "package.json"), "utf8"))
      assert.equal(result.stdout.trim(), packageJson.version)
    })
  })
})

const CONFLICTED_LOCK = [
  "{",
  '  "name": "app",',
  "<<<<<<< HEAD",
  '  "version": "1.1.0",',
  "=======",
  '  "version": "1.2.0",',
  ">>>>>>> feature",
  '  "lockfileVersion": 3,',
  '  "packages": {}',
  "}",
  "",
].join("\n")

describe("CLI companion lockfile resolution", () => {
  test("resolves package-lock.json alongside package.json in one run", async () => {
    await withTempDir(async dir => {
      await writeFile(join(dir, "package.json"), CONFLICTED, "utf8")
      await writeFile(join(dir, "package-lock.json"), CONFLICTED_LOCK, "utf8")

      const result = await runCli(["--no-regenerate-lock"], dir)
      assert.equal(result.code, 0, result.stderr)

      const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"))
      const lock = JSON.parse(await readFile(join(dir, "package-lock.json"), "utf8"))
      assert.equal(pkg.version, "1.2.0")
      assert.equal(lock.version, "1.2.0")
      assert.equal(lock.lockfileVersion, 3)
    })
  })

  test("resolves the lockfile even when package.json has no conflicts", async () => {
    await withTempDir(async dir => {
      await writeFile(join(dir, "package.json"), '{\n  "name": "app",\n  "version": "1.2.0"\n}\n', "utf8")
      await writeFile(join(dir, "package-lock.json"), CONFLICTED_LOCK, "utf8")

      const result = await runCli(["--no-regenerate-lock"], dir)
      assert.equal(result.code, 0, result.stderr)

      const lock = JSON.parse(await readFile(join(dir, "package-lock.json"), "utf8"))
      assert.equal(lock.version, "1.2.0")
    })
  })

  test("resolves a conflicted npm-shrinkwrap.json", async () => {
    await withTempDir(async dir => {
      await writeFile(join(dir, "package.json"), CONFLICTED, "utf8")
      await writeFile(join(dir, "npm-shrinkwrap.json"), CONFLICTED_LOCK, "utf8")

      const result = await runCli(["--no-regenerate-lock"], dir)
      assert.equal(result.code, 0, result.stderr)

      const shrinkwrap = JSON.parse(await readFile(join(dir, "npm-shrinkwrap.json"), "utf8"))
      assert.equal(shrinkwrap.version, "1.2.0")
    })
  })

  test("leaves a clean lockfile byte-identical", async () => {
    await withTempDir(async dir => {
      const cleanLock = '{\n  "name": "app",\n  "lockfileVersion": 3,\n  "packages": {}\n}\n'
      await writeFile(join(dir, "package.json"), CONFLICTED, "utf8")
      await writeFile(join(dir, "package-lock.json"), cleanLock, "utf8")

      const result = await runCli(["--no-regenerate-lock"], dir)
      assert.equal(result.code, 0, result.stderr)
      assert.equal(await readFile(join(dir, "package-lock.json"), "utf8"), cleanLock)
    })
  })

  test("dry run leaves the lockfile untouched", async () => {
    await withTempDir(async dir => {
      await writeFile(join(dir, "package.json"), CONFLICTED, "utf8")
      await writeFile(join(dir, "package-lock.json"), CONFLICTED_LOCK, "utf8")

      const result = await runCli(["--dry-run", "--no-regenerate-lock"], dir)
      assert.equal(result.code, 0, result.stderr)
      assert.equal(await readFile(join(dir, "package-lock.json"), "utf8"), CONFLICTED_LOCK)
    })
  })

  test("targeting package-lock.json directly still works", async () => {
    await withTempDir(async dir => {
      await writeFile(join(dir, "package-lock.json"), CONFLICTED_LOCK, "utf8")

      const result = await runCli(["package-lock.json", "--no-regenerate-lock"], dir)
      assert.equal(result.code, 0, result.stderr)

      const lock = JSON.parse(await readFile(join(dir, "package-lock.json"), "utf8"))
      assert.equal(lock.version, "1.2.0")
    })
  })
})

describe("CLI merge-driver (as invoked by Git)", () => {
  test("merges current/base/other and rewrites the current file", async () => {
    await withTempDir(async dir => {
      const current = join(dir, "current.json")
      const base = join(dir, "base.json")
      const other = join(dir, "other.json")

      await writeFile(base, JSON.stringify({name: "app", version: "1.0.0", dependencies: {lodash: "^4.17.20"}}), "utf8")
      await writeFile(
        current,
        JSON.stringify({name: "app", version: "1.1.0", dependencies: {lodash: "^4.17.21", express: "^4.18.0"}}),
        "utf8"
      )
      await writeFile(
        other,
        JSON.stringify({name: "app", version: "1.0.0", dependencies: {lodash: "^4.17.20", react: "^18.0.0"}}),
        "utf8"
      )

      const result = await runCli(["merge-driver", current, base, other], dir)
      assert.equal(result.code, 0, result.stderr)

      const merged = JSON.parse(await readFile(current, "utf8"))
      assert.equal(merged.version, "1.1.0")
      assert.deepEqual(merged.dependencies, {
        lodash: "^4.17.21",
        express: "^4.18.0",
        react: "^18.0.0",
      })
    })
  })

  test("handles an empty base file (file added on both branches)", async () => {
    await withTempDir(async dir => {
      const current = join(dir, "current.json")
      const base = join(dir, "base.json")
      const other = join(dir, "other.json")

      await writeFile(base, "", "utf8")
      await writeFile(current, JSON.stringify({name: "new", version: "1.0.0"}), "utf8")
      await writeFile(other, JSON.stringify({name: "new", version: "2.0.0"}), "utf8")

      const result = await runCli(["merge-driver", current, base, other], dir)
      assert.equal(result.code, 0, result.stderr)

      const merged = JSON.parse(await readFile(current, "utf8"))
      assert.equal(merged.version, "2.0.0")
    })
  })

  test("preserves the current file's indentation and line endings", async () => {
    await withTempDir(async dir => {
      const current = join(dir, "current.json")
      const base = join(dir, "base.json")
      const other = join(dir, "other.json")

      await writeFile(base, '{\r\n    "version": "1.0.0"\r\n}\r\n', "utf8")
      await writeFile(current, '{\r\n    "version": "1.1.0"\r\n}\r\n', "utf8")
      await writeFile(other, '{\r\n    "version": "1.2.0"\r\n}\r\n', "utf8")

      const result = await runCli(["merge-driver", current, base, other], dir)
      assert.equal(result.code, 0, result.stderr)

      const written = await readFile(current, "utf8")
      assert(written.includes('\r\n    "version"'), "should keep 4-space indent and CRLF")
      assert.equal(JSON.parse(written).version, "1.2.0")
    })
  })

  test("exits 1 and reports to stderr when a side is invalid JSON", async () => {
    await withTempDir(async dir => {
      const current = join(dir, "current.json")
      const base = join(dir, "base.json")
      const other = join(dir, "other.json")

      const currentContent = JSON.stringify({name: "app", version: "1.1.0"})
      await writeFile(base, JSON.stringify({name: "app", version: "1.0.0"}), "utf8")
      await writeFile(current, currentContent, "utf8")
      await writeFile(other, "{ not valid json", "utf8")

      const result = await runCli(["merge-driver", current, base, other], dir)
      assert.equal(result.code, 1)
      assert(result.stderr.includes("package-conflicts-resolver"))
      assert.equal(await readFile(current, "utf8"), currentContent, "current file must be left as-is on failure")
    })
  })

  test("falls back to the default strategy for an invalid strategy flag", async () => {
    await withTempDir(async dir => {
      const current = join(dir, "current.json")
      const base = join(dir, "base.json")
      const other = join(dir, "other.json")

      await writeFile(base, JSON.stringify({version: "1.0.0"}), "utf8")
      await writeFile(current, JSON.stringify({version: "1.1.0"}), "utf8")
      await writeFile(other, JSON.stringify({version: "1.2.0"}), "utf8")

      const result = await runCli(["merge-driver", current, base, other, "--strategy", "bogus"], dir)
      assert.equal(result.code, 0, "merge driver must not hard-fail on a bad flag")
      assert.equal(JSON.parse(await readFile(current, "utf8")).version, "1.2.0")
    })
  })

  test("merges package-lock.json entries atomically", async () => {
    await withTempDir(async dir => {
      const current = join(dir, "current.json")
      const base = join(dir, "base.json")
      const other = join(dir, "other.json")

      const makeLock = (version: string, hash: string) =>
        JSON.stringify({
          name: "app",
          lockfileVersion: 3,
          packages: {
            "node_modules/lodash": {
              version,
              resolved: `https://registry.npmjs.org/lodash/-/lodash-${version}.tgz`,
              integrity: `sha512-${hash}`,
            },
          },
        })

      await writeFile(base, makeLock("4.8.0", "base"), "utf8")
      await writeFile(current, makeLock("4.9.0", "ours"), "utf8")
      await writeFile(other, makeLock("4.10.0", "theirs"), "utf8")

      const result = await runCli(["merge-driver", current, base, other], dir)
      assert.equal(result.code, 0, result.stderr)

      const entry = JSON.parse(await readFile(current, "utf8")).packages["node_modules/lodash"]
      assert.equal(entry.version, "4.10.0")
      assert.equal(entry.integrity, "sha512-theirs")
      assert(entry.resolved.includes("4.10.0"))
    })
  })
})

const j = (value: unknown) => JSON.stringify(value, null, 2) + "\n"

const lockEntry = (name: string, version: string) => ({
  version,
  resolved: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
  integrity: `sha512-${name}-${version}`,
})

const lockWith = (rootDeps: Record<string, string>, packages: Record<string, any>) =>
  j({
    name: "app",
    version: "1.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: {"": {name: "app", version: "1.0.0", dependencies: rootDeps}, ...packages},
  })

describe("CLI merge-driver lockfile consistency", () => {
  // Ours kept the range and moved the lock to 1.5.0; theirs pinned 1.2.0. The
  // range comparison picks the pin, the exact comparison picks 1.5.0: the
  // merged lockfile cannot satisfy its own root.
  const current = lockWith({foo: "^1.0.0"}, {"node_modules/foo": lockEntry("foo", "1.5.0")})
  const other = lockWith({foo: "1.2.0"}, {"node_modules/foo": lockEntry("foo", "1.2.0")})

  test("exits 1 and explains when the merged lockfile is inconsistent", async () => {
    await withTempDir(async dir => {
      const currentPath = join(dir, "current.json")
      await writeFile(currentPath, current, "utf8")
      await writeFile(join(dir, "base.json"), "", "utf8")
      await writeFile(join(dir, "other.json"), other, "utf8")

      const result = await runCli(["merge-driver", currentPath, join(dir, "base.json"), join(dir, "other.json")], dir)
      assert.equal(result.code, 1)
      assert.match(result.stderr, /not consistent/)
      assert.match(result.stderr, /the root project requires foo@1\.2\.0 but node_modules\/foo is 1\.5\.0/)
      assert.match(result.stderr, /npm install --package-lock-only/)
      assert.match(result.stderr, /--allow-inconsistent-lockfile/)

      // The best-effort merge is still written so npm can start from it
      const written = JSON.parse(await readFile(currentPath, "utf8"))
      assert.equal(written.packages[""].dependencies.foo, "1.2.0")
      assert.equal(written.packages["node_modules/foo"].version, "1.5.0")
    })
  })

  test("--allow-inconsistent-lockfile accepts the merge", async () => {
    await withTempDir(async dir => {
      const currentPath = join(dir, "current.json")
      await writeFile(currentPath, current, "utf8")
      await writeFile(join(dir, "base.json"), "", "utf8")
      await writeFile(join(dir, "other.json"), other, "utf8")

      const result = await runCli(
        ["merge-driver", currentPath, join(dir, "base.json"), join(dir, "other.json"), "--allow-inconsistent-lockfile"],
        dir
      )
      assert.equal(result.code, 0, result.stderr)
      assert.equal(result.stderr, "")
    })
  })

  test("a consistent merge exits 0 silently", async () => {
    await withTempDir(async dir => {
      const currentPath = join(dir, "current.json")
      await writeFile(currentPath, lockWith({foo: "^1.0.0"}, {"node_modules/foo": lockEntry("foo", "1.5.0")}), "utf8")
      await writeFile(
        join(dir, "base.json"),
        lockWith({foo: "^1.0.0"}, {"node_modules/foo": lockEntry("foo", "1.0.0")}),
        "utf8"
      )
      await writeFile(
        join(dir, "other.json"),
        lockWith({foo: "^1.0.0"}, {"node_modules/foo": lockEntry("foo", "1.3.0")}),
        "utf8"
      )

      const result = await runCli(["merge-driver", currentPath, join(dir, "base.json"), join(dir, "other.json")], dir)
      assert.equal(result.code, 0, result.stderr)
      assert.equal(result.stderr, "")
      assert.equal(JSON.parse(await readFile(currentPath, "utf8")).packages["node_modules/foo"].version, "1.5.0")
    })
  })

  test("a one-sided change is kept even when the strategy would prefer the other value", async () => {
    await withTempDir(async dir => {
      const currentPath = join(dir, "current.json")
      const base = lockWith(
        {foo: "^1.5.0", bar: "^1.0.0"},
        {"node_modules/foo": lockEntry("foo", "1.5.0"), "node_modules/bar": lockEntry("bar", "1.0.0")}
      )
      const ours = lockWith(
        {foo: "^1.5.0", bar: "^1.1.0"},
        {"node_modules/foo": lockEntry("foo", "1.5.0"), "node_modules/bar": lockEntry("bar", "1.1.0")}
      )
      const theirs = lockWith(
        {foo: "1.2.0", bar: "^1.0.0"},
        {"node_modules/foo": lockEntry("foo", "1.2.0"), "node_modules/bar": lockEntry("bar", "1.0.0")}
      )
      await writeFile(currentPath, ours, "utf8")
      await writeFile(join(dir, "base.json"), base, "utf8")
      await writeFile(join(dir, "other.json"), theirs, "utf8")

      const result = await runCli(["merge-driver", currentPath, join(dir, "base.json"), join(dir, "other.json")], dir)
      assert.equal(result.code, 0, result.stderr)

      const merged = JSON.parse(await readFile(currentPath, "utf8"))
      assert.equal(merged.packages[""].dependencies.foo, "1.2.0")
      assert.equal(merged.packages["node_modules/foo"].version, "1.2.0")
      assert.equal(merged.packages[""].dependencies.bar, "^1.1.0")
      assert.equal(merged.packages["node_modules/bar"].version, "1.1.0")
    })
  })
})

describe("CLI lockfile consistency without regeneration", () => {
  const CONFLICTED_INCONSISTENT_LOCK = [
    "{",
    '  "name": "app",',
    '  "version": "1.0.0",',
    '  "lockfileVersion": 3,',
    '  "packages": {',
    '    "": {',
    '      "name": "app",',
    '      "dependencies": {',
    "<<<<<<< HEAD",
    '        "foo": "^1.0.0"',
    "=======",
    '        "foo": "1.2.0"',
    ">>>>>>> feature",
    "      }",
    "    },",
    '    "node_modules/foo": {',
    "<<<<<<< HEAD",
    '      "version": "1.5.0",',
    '      "resolved": "https://r/foo-1.5.0.tgz",',
    '      "integrity": "sha512-a"',
    "=======",
    '      "version": "1.2.0",',
    '      "resolved": "https://r/foo-1.2.0.tgz",',
    '      "integrity": "sha512-b"',
    ">>>>>>> feature",
    "    }",
    "  }",
    "}",
    "",
  ].join("\n")

  test("exits 1 with the unsatisfied edges when the merged lockfile is inconsistent", async () => {
    await withTempDir(async dir => {
      await writeFile(
        join(dir, "package.json"),
        j({name: "app", version: "1.0.0", dependencies: {foo: "1.2.0"}}),
        "utf8"
      )
      await writeFile(join(dir, "package-lock.json"), CONFLICTED_INCONSISTENT_LOCK, "utf8")

      const result = await runCli(["--no-regenerate-lock"], dir)
      assert.equal(result.code, 1)
      assert.match(result.stderr, /package-lock\.json was merged but its dependency graph is not consistent/)
      assert.match(result.stderr, /the root project requires foo@1\.2\.0 but node_modules\/foo is 1\.5\.0/)
      assert.match(result.stderr, /npm install --package-lock-only/)

      // The merge itself is written: no markers are left behind
      const lock = await readFile(join(dir, "package-lock.json"), "utf8")
      assert(!lock.includes("<<<<<<<"))
      assert.equal(JSON.parse(lock).packages["node_modules/foo"].version, "1.5.0")
    })
  })

  test("checks the root against package.json, not only against the lockfile's own root entry", async () => {
    await withTempDir(async dir => {
      // The lockfile is internally consistent (its root says ^1.0.0) but the
      // resolved package.json pins a version the lockfile does not provide
      const lock = [
        "{",
        '  "name": "app",',
        '  "lockfileVersion": 3,',
        '  "packages": {',
        '    "": {',
        '      "name": "app",',
        '      "dependencies": {',
        '        "foo": "^1.0.0"',
        "      }",
        "    },",
        '    "node_modules/foo": {',
        "<<<<<<< HEAD",
        '      "version": "1.5.0",',
        '      "integrity": "sha512-a"',
        "=======",
        '      "version": "1.4.0",',
        '      "integrity": "sha512-b"',
        ">>>>>>> feature",
        "    }",
        "  }",
        "}",
        "",
      ].join("\n")
      await writeFile(
        join(dir, "package.json"),
        j({name: "app", version: "1.0.0", dependencies: {foo: "1.2.0"}}),
        "utf8"
      )
      await writeFile(join(dir, "package-lock.json"), lock, "utf8")

      const result = await runCli(["--no-regenerate-lock"], dir)
      assert.equal(result.code, 1)
      assert.match(result.stderr, /requires foo@1\.2\.0 but node_modules\/foo is 1\.5\.0/)
    })
  })

  test("dry run only warns and exits 0", async () => {
    await withTempDir(async dir => {
      await writeFile(
        join(dir, "package.json"),
        j({name: "app", version: "1.0.0", dependencies: {foo: "1.2.0"}}),
        "utf8"
      )
      await writeFile(join(dir, "package-lock.json"), CONFLICTED_INCONSISTENT_LOCK, "utf8")

      const result = await runCli(["--dry-run", "--no-regenerate-lock"], dir)
      assert.equal(result.code, 0, result.stderr)
      assert.match(result.stderr, /would be merged with 1 unsatisfied dependency/)
      assert.equal(await readFile(join(dir, "package-lock.json"), "utf8"), CONFLICTED_INCONSISTENT_LOCK)
    })
  })

  test("--json keeps stdout machine-readable while reporting on stderr", async () => {
    await withTempDir(async dir => {
      await writeFile(
        join(dir, "package.json"),
        j({name: "app", version: "1.0.0", dependencies: {foo: "1.2.0"}}),
        "utf8"
      )
      await writeFile(join(dir, "package-lock.json"), CONFLICTED_INCONSISTENT_LOCK, "utf8")

      const result = await runCli(["--json", "--no-regenerate-lock"], dir)
      assert.equal(result.code, 1)
      for (const line of result.stdout.split("\n").filter(line => line.trim() !== "")) {
        assert.doesNotThrow(() => JSON.parse(line), `not valid JSON: ${line}`)
      }
      assert.match(result.stderr, /not consistent/)
    })
  })

  test("a consistent lockfile merge exits 0", async () => {
    await withTempDir(async dir => {
      const lock = [
        "{",
        '  "name": "app",',
        '  "lockfileVersion": 3,',
        '  "packages": {',
        '    "": {',
        '      "name": "app",',
        '      "dependencies": {',
        '        "foo": "^1.0.0"',
        "      }",
        "    },",
        '    "node_modules/foo": {',
        "<<<<<<< HEAD",
        '      "version": "1.5.0",',
        '      "integrity": "sha512-a"',
        "=======",
        '      "version": "1.4.0",',
        '      "integrity": "sha512-b"',
        ">>>>>>> feature",
        "    }",
        "  }",
        "}",
        "",
      ].join("\n")
      await writeFile(
        join(dir, "package.json"),
        j({name: "app", version: "1.0.0", dependencies: {foo: "^1.0.0"}}),
        "utf8"
      )
      await writeFile(join(dir, "package-lock.json"), lock, "utf8")

      const result = await runCli(["--no-regenerate-lock"], dir)
      assert.equal(result.code, 0, result.stderr)
      assert.equal(result.stderr, "")
      assert.equal(
        JSON.parse(await readFile(join(dir, "package-lock.json"), "utf8")).packages["node_modules/foo"].version,
        "1.5.0"
      )
    })
  })

  test("targeting an inconsistent package-lock.json directly is reported too", async () => {
    await withTempDir(async dir => {
      await writeFile(
        join(dir, "package.json"),
        j({name: "app", version: "1.0.0", dependencies: {foo: "1.2.0"}}),
        "utf8"
      )
      await writeFile(join(dir, "package-lock.json"), CONFLICTED_INCONSISTENT_LOCK, "utf8")

      const result = await runCli(["package-lock.json", "--no-regenerate-lock"], dir)
      assert.equal(result.code, 1)
      assert.match(result.stderr, /package-lock\.json was merged but its dependency graph is not consistent/)
    })
  })
})
