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
