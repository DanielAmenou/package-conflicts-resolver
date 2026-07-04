/**
 * Package manager detection and multi-PM CLI behavior tests.
 */

import {strict as assert} from "assert"
import {test, describe} from "node:test"
import {spawn} from "node:child_process"
import {access, mkdtemp, readFile, writeFile, rm} from "fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {detectPackageManager, findLockfiles} from "../package-manager.js"

const CLI_PATH = join(__dirname, "..", "cli.js")

interface CliResult {
  code: number | null
  stdout: string
  stderr: string
}

function runCli(args: string[], cwd: string): Promise<CliResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {cwd, stdio: ["ignore", "pipe", "pipe"]})
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", chunk => (stdout += chunk))
    child.stderr.on("data", chunk => (stderr += chunk))
    child.on("error", reject)
    child.on("close", code => resolvePromise({code, stdout, stderr}))
  })
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pcr-pm-"))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, {recursive: true, force: true})
  }
}

const CONFLICTED_PKG = [
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

const CONFLICTED_YARN_LOCK = [
  "# yarn lockfile v1",
  "<<<<<<< HEAD",
  "lodash@^4.17.21:",
  '  version "4.17.21"',
  "=======",
  "lodash@^4.17.20:",
  '  version "4.17.20"',
  ">>>>>>> feature",
  "",
].join("\n")

describe("Package manager detection", () => {
  test("detects each package manager from its lockfile", async () => {
    const cases: Array<[string, string]> = [
      ["package-lock.json", "npm"],
      ["npm-shrinkwrap.json", "npm"],
      ["pnpm-lock.yaml", "pnpm"],
      ["yarn.lock", "yarn"],
      ["bun.lock", "bun"],
    ]

    for (const [lockName, expected] of cases) {
      await withTempDir(async dir => {
        await writeFile(join(dir, lockName), "", "utf8")
        assert.equal(await detectPackageManager(dir), expected, lockName)
      })
    }
  })

  test("packageManager field takes precedence over lockfiles", async () => {
    await withTempDir(async dir => {
      await writeFile(join(dir, "package.json"), '{"packageManager": "pnpm@9.0.0"}', "utf8")
      await writeFile(join(dir, "package-lock.json"), "{}", "utf8")
      assert.equal(await detectPackageManager(dir), "pnpm")
    })
  })

  test("defaults to npm when nothing is found", async () => {
    await withTempDir(async dir => {
      assert.equal(await detectPackageManager(dir), "npm")
    })
  })

  test("findLockfiles returns only existing lockfiles", async () => {
    await withTempDir(async dir => {
      await writeFile(join(dir, "yarn.lock"), "", "utf8")
      await writeFile(join(dir, "pnpm-lock.yaml"), "", "utf8")

      const found = await findLockfiles(dir)
      assert.deepEqual(
        found.map(lock => lock.name),
        ["pnpm-lock.yaml", "yarn.lock"]
      )
    })
  })
})

describe("CLI multi-package-manager behavior", () => {
  test("never creates a package-lock.json in a yarn project", async () => {
    await withTempDir(async dir => {
      await writeFile(join(dir, "package.json"), CONFLICTED_PKG, "utf8")
      await writeFile(join(dir, "yarn.lock"), "# yarn lockfile v1\n", "utf8")

      // Regeneration left enabled on purpose: npm must not run here
      const result = await runCli([], dir)
      assert.equal(result.code, 0, result.stderr)

      const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"))
      assert.equal(pkg.version, "1.2.0")
      await assert.rejects(access(join(dir, "package-lock.json")), "npm lockfile must not be created")
      assert(result.stdout.includes("yarn install"), "should point the user at yarn")
    })
  })

  test("conflicted yarn.lock reports the yarn command and exits 1", async () => {
    await withTempDir(async dir => {
      await writeFile(join(dir, "package.json"), '{\n  "name": "app"\n}\n', "utf8")
      await writeFile(join(dir, "yarn.lock"), CONFLICTED_YARN_LOCK, "utf8")

      const result = await runCli(["--no-regenerate-lock"], dir)
      assert.equal(result.code, 1)
      assert(result.stderr.includes("yarn install"))
      // The tool must not rewrite a format it doesn't own
      assert.equal(await readFile(join(dir, "yarn.lock"), "utf8"), CONFLICTED_YARN_LOCK)
    })
  })

  test("conflicted pnpm-lock.yaml reports the pnpm command when regeneration is disabled", async () => {
    await withTempDir(async dir => {
      const conflictedPnpmLock = [
        "lockfileVersion: '9.0'",
        "<<<<<<< HEAD",
        "  lodash: 4.17.21",
        "=======",
        "  lodash: 4.17.20",
        ">>>>>>> feature",
        "",
      ].join("\n")

      await writeFile(join(dir, "package.json"), '{\n  "name": "app"\n}\n', "utf8")
      await writeFile(join(dir, "pnpm-lock.yaml"), conflictedPnpmLock, "utf8")

      const result = await runCli(["--no-regenerate-lock"], dir)
      assert.equal(result.code, 1)
      assert(result.stderr.includes("pnpm install --lockfile-only"))
      assert.equal(await readFile(join(dir, "pnpm-lock.yaml"), "utf8"), conflictedPnpmLock)
    })
  })

  test("dry run reports what would happen to a conflicted yarn.lock and exits 0", async () => {
    await withTempDir(async dir => {
      await writeFile(join(dir, "package.json"), '{\n  "name": "app"\n}\n', "utf8")
      await writeFile(join(dir, "yarn.lock"), CONFLICTED_YARN_LOCK, "utf8")

      const result = await runCli(["--dry-run", "--no-regenerate-lock"], dir)
      assert.equal(result.code, 0, result.stderr)
      assert(result.stdout.includes("Would resolve yarn.lock"))
      assert.equal(await readFile(join(dir, "yarn.lock"), "utf8"), CONFLICTED_YARN_LOCK)
    })
  })

  test("npm lockfile still gets merged semantically in a mixed repo", async () => {
    await withTempDir(async dir => {
      const conflictedNpmLock = [
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

      await writeFile(join(dir, "package.json"), '{\n  "name": "app"\n}\n', "utf8")
      await writeFile(join(dir, "package-lock.json"), conflictedNpmLock, "utf8")
      await writeFile(join(dir, "yarn.lock"), "# clean\n", "utf8")

      const result = await runCli(["--no-regenerate-lock"], dir)
      assert.equal(result.code, 0, result.stderr)

      const lock = JSON.parse(await readFile(join(dir, "package-lock.json"), "utf8"))
      assert.equal(lock.version, "1.2.0")
    })
  })
})
