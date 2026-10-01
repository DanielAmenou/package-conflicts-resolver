/**
 * Hostile and degenerate inputs: conflict markers in shapes Git can actually
 * emit (and some it cannot), files the tool has no business rewriting, and I/O
 * failures. The bar for all of these is the same — report a problem, never
 * write a corrupted file.
 */

import {strict as assert} from "assert"
import {test, describe} from "node:test"
import {spawn} from "node:child_process"
import {chmod, mkdir, mkdtemp, readFile, writeFile, rm} from "fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {ConflictParser} from "../conflict-parser.js"
import {PackageResolver} from "../package-resolver.js"
import {CliOptions} from "../types.js"

const CLI_PATH = join(__dirname, "..", "cli.js")

// Running as root defeats permission-based tests
const SKIP_AS_ROOT =
  typeof process.getuid === "function" && process.getuid() === 0 ? "permission checks are meaningless as root" : false

// Windows ignores the POSIX read bit, so chmod(0o000) leaves the file readable: the unreadable-file case cannot be simulated there.
const SKIP_UNREADABLE =
  process.platform === "win32" ? "file read permissions cannot be removed on Windows" : SKIP_AS_ROOT

function makeResolver(strategy: CliOptions["strategy"] = "highest"): PackageResolver {
  return new PackageResolver({strategy, dryRun: true, quiet: true, json: false, verbose: false, regenerateLock: false})
}

function runCli(args: string[], cwd: string): Promise<{code: number | null; stdout: string; stderr: string}> {
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
  const dir = await mkdtemp(join(tmpdir(), "pcr-edge-"))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, {recursive: true, force: true})
  }
}

describe("conflict markers in unusual shapes", () => {
  test("markers carrying trailing whitespace are still recognised", () => {
    const content = [
      "{",
      "<<<<<<< HEAD   ",
      '  "version": "1.1.0"',
      "=======   ",
      '  "version": "1.2.0"',
      ">>>>>>> feature   ",
      "}",
    ].join("\n")

    const conflicts = ConflictParser.parseConflicts(content)
    assert.equal(conflicts.length, 1)
    assert(conflicts[0]!.ours.includes("1.1.0"))
  })

  test("a marker indented by even one space is not a marker", () => {
    const content = ["{", " <<<<<<< HEAD", '  "a": 1', " =======", '  "a": 2', " >>>>>>> x", "}"].join("\n")
    assert.equal(ConflictParser.hasConflicts(content), false)
  })

  test("a conflict occupying the entire file is handled", async () => {
    const content = [
      "<<<<<<< HEAD",
      '{"name": "app", "version": "1.1.0"}',
      "=======",
      '{"name": "app", "version": "1.2.0"}',
      ">>>>>>> feature",
    ].join("\n")

    const result = await makeResolver().resolveConflicts(content)
    assert.equal(result.resolved, true, result.errors.join(", "))
    assert.equal(result.packageJson!.version, "1.2.0")
  })

  test("a conflict where both sides are empty resolves to the surrounding document", async () => {
    const content = [
      "{",
      '  "name": "app",',
      "<<<<<<< HEAD",
      "=======",
      ">>>>>>> feature",
      '  "version": "1.0.0"',
      "}",
    ].join("\n")

    const result = await makeResolver().resolveConflicts(content)
    assert.equal(result.resolved, true, result.errors.join(", "))
    assert.deepEqual(result.packageJson, {name: "app", version: "1.0.0"})
  })

  test("several conflicts inside a single lock entry all resolve", async () => {
    const content = [
      "{",
      '  "lockfileVersion": 3,',
      '  "packages": {',
      '    "node_modules/foo": {',
      "<<<<<<< HEAD",
      '      "version": "2.0.0",',
      "=======",
      '      "version": "1.0.0",',
      ">>>>>>> feature",
      '      "license": "MIT",',
      "<<<<<<< HEAD",
      '      "dev": true',
      "=======",
      '      "dev": false',
      ">>>>>>> feature",
      "    }",
      "  }",
      "}",
    ].join("\n")

    const result = await makeResolver().resolveConflicts(content)
    assert.equal(result.resolved, true, result.errors.join(", "))
    const entry = result.packageJson!.packages["node_modules/foo"]
    assert.equal(entry.version, "2.0.0")
    assert.equal(entry.license, "MIT")
    assert.equal(typeof entry.dev, "boolean")
  })

  test("a closing marker with no middle marker is ignored", () => {
    const content = ["{", "<<<<<<< HEAD", '  "a": 1', ">>>>>>> feature", "}"].join("\n")
    assert.equal(ConflictParser.parseConflicts(content).length, 0)
  })

  test("a stray middle marker outside any conflict is ignored", () => {
    const content = ["{", '  "a": 1', "=======", '  "b": 2', "}"].join("\n")
    assert.equal(ConflictParser.hasConflicts(content), false)
  })

  test("CRLF diff3 conflicts keep their base section", () => {
    const content = [
      "{\r",
      "<<<<<<< HEAD\r",
      '  "version": "1.1.0"\r',
      "||||||| base\r",
      '  "version": "1.0.0"\r',
      "=======\r",
      '  "version": "1.2.0"\r',
      ">>>>>>> feature\r",
      "}\r",
      "",
    ].join("\n")

    const conflicts = ConflictParser.parseConflicts(content)
    assert.equal(conflicts.length, 1)
    assert(conflicts[0]!.base!.includes("1.0.0"))
    assert(!conflicts[0]!.ours.includes("1.0.0"), "base must not leak into ours")
  })

  test("a file with hundreds of conflicts still resolves", async () => {
    const lines = ["{", '  "dependencies": {']
    for (let i = 0; i < 300; i++) {
      lines.push("<<<<<<< HEAD", `    "pkg${i}": "^1.0.0",`, "=======", `    "pkg${i}": "^2.0.0",`, ">>>>>>> feature")
    }
    lines.push('    "last": "^1.0.0"', "  }", "}")

    const started = Date.now()
    const result = await makeResolver().resolveConflicts(lines.join("\n"))
    const elapsed = Date.now() - started

    assert.equal(result.resolved, true, result.errors.join(", "))
    assert.equal(Object.keys(result.packageJson!.dependencies!).length, 301)
    assert.equal(result.packageJson!.dependencies!.pkg0, "^2.0.0")
    assert(elapsed < 20_000, `resolving 300 conflicts took ${elapsed}ms`)
  })

  test("marker-looking text inside a string value is left alone", async () => {
    const content = [
      "{",
      '  "scripts": {',
      '    "warn": "echo <<<<<<< HEAD",',
      '    "other": "echo >>>>>>> done"',
      "  },",
      "<<<<<<< HEAD",
      '  "version": "1.1.0"',
      "=======",
      '  "version": "1.2.0"',
      ">>>>>>> feature",
      "}",
    ].join("\n")

    const result = await makeResolver().resolveConflicts(content)
    assert.equal(result.resolved, true, result.errors.join(", "))
    assert.equal(result.packageJson!.version, "1.2.0")
    assert.deepEqual(result.packageJson!.scripts, {
      warn: "echo <<<<<<< HEAD",
      other: "echo >>>>>>> done",
    })
  })
})

describe("documents that are not mergeable package files", () => {
  test("a JSON array is rejected rather than merged", async () => {
    const result = await makeResolver().mergeJsonContents("", "[1, 2]", "[3]")
    assert.equal(result.resolved, false)
    assert.match(result.errors.join(" "), /JSON object/)
  })

  test("a JSON scalar is rejected", async () => {
    for (const scalar of ['"text"', "42", "true", "null"]) {
      const result = await makeResolver().mergeJsonContents("", scalar, scalar)
      assert.equal(result.resolved, false, `${scalar} should not merge`)
    }
  })

  test("a non-JSON file with conflict markers reports an error and is not rewritten", async () => {
    await withTempDir(async dir => {
      const original = ["hello", "<<<<<<< HEAD", "ours", "=======", "theirs", ">>>>>>> feature", "world", ""].join("\n")
      const file = join(dir, "package.json")
      await writeFile(file, original, "utf8")

      const result = await runCli(["package.json", "--no-regenerate-lock"], dir)
      assert.equal(result.code, 1)
      assert.match(result.stderr, /Failed to resolve conflicts/)
      assert.equal(await readFile(file, "utf8"), original, "a file we cannot parse must be left untouched")
    })
  })

  test("a base document that is not an object is rejected", async () => {
    const result = await makeResolver().mergeJsonContents("[1]", '{"a": 1}', '{"a": 2}')
    assert.equal(result.resolved, false)
    assert.match(result.errors.join(" "), /base document/)
  })
})

describe("I/O and argument failures", () => {
  test("pointing at a directory fails cleanly", async () => {
    await withTempDir(async dir => {
      await mkdir(join(dir, "package.json"))
      const result = await runCli(["package.json", "--no-regenerate-lock"], dir)
      assert.equal(result.code, 1)
      assert(result.stderr.length > 0, "should explain the failure")
    })
  })

  test("an unreadable file fails cleanly", {skip: SKIP_UNREADABLE}, async () => {
    await withTempDir(async dir => {
      const file = join(dir, "package.json")
      await writeFile(file, '{"name": "app"}', "utf8")
      await chmod(file, 0o000)

      try {
        const result = await runCli(["package.json", "--no-regenerate-lock"], dir)
        assert.equal(result.code, 1)
        assert(result.stderr.length > 0)
      } finally {
        await chmod(file, 0o644)
      }
    })
  })

  test("the merge driver reports a missing input file instead of crashing", async () => {
    await withTempDir(async dir => {
      const current = join(dir, "current.json")
      await writeFile(current, '{"name": "app"}', "utf8")

      const result = await runCli(["merge-driver", current, join(dir, "nope.json"), join(dir, "also-nope.json")], dir)
      assert.equal(result.code, 1)
      assert.match(result.stderr, /package-conflicts-resolver: merge driver failed/)
      assert.equal(await readFile(current, "utf8"), '{"name": "app"}', "the current file must survive")
    })
  })

  test("the merge driver leaves the file alone when it cannot write the result", {skip: SKIP_AS_ROOT}, async () => {
    await withTempDir(async dir => {
      const current = join(dir, "current.json")
      const base = join(dir, "base.json")
      const other = join(dir, "other.json")
      await writeFile(base, JSON.stringify({version: "1.0.0"}), "utf8")
      await writeFile(current, JSON.stringify({version: "1.1.0"}), "utf8")
      await writeFile(other, JSON.stringify({version: "1.2.0"}), "utf8")
      await chmod(current, 0o444)

      try {
        const result = await runCli(["merge-driver", current, base, other], dir)
        assert.equal(result.code, 1)
        assert.match(result.stderr, /merge driver failed/)
        assert.equal(JSON.parse(await readFile(current, "utf8")).version, "1.1.0")
      } finally {
        await chmod(current, 0o644)
      }
    })
  })

  test("the merge driver requires all three arguments", async () => {
    await withTempDir(async dir => {
      const result = await runCli(["merge-driver", "only-one.json"], dir)
      assert.notEqual(result.code, 0)
      assert.match(result.stderr, /argument|missing/i)
    })
  })

  test("an empty file is treated as having no conflicts", async () => {
    await withTempDir(async dir => {
      await writeFile(join(dir, "package.json"), "", "utf8")
      const result = await runCli(["package.json", "--no-regenerate-lock"], dir)
      assert.equal(result.code, 0, result.stderr)
      assert.match(result.stdout, /No Git conflict markers found/)
      assert.equal(await readFile(join(dir, "package.json"), "utf8"), "", "an empty file must stay empty")
    })
  })
})
