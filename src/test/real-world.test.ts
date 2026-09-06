/**
 * Scenarios drawn from how real projects actually look: monorepos with
 * workspaces, scoped and aliased packages, CRLF checkouts, BOMs, tab
 * indentation, overrides, and running the tool twice in a row.
 */

import {strict as assert} from "assert"
import {test, describe} from "node:test"
import {spawn} from "node:child_process"
import {mkdtemp, readFile, writeFile, rm} from "fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {PackageResolver} from "../package-resolver.js"
import {validateLockfile} from "../lockfile-validator.js"
import {CliOptions} from "../types.js"

const CLI_PATH = join(__dirname, "..", "cli.js")

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
  const dir = await mkdtemp(join(tmpdir(), "pcr-real-"))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, {recursive: true, force: true})
  }
}

const j = (value: unknown) => JSON.stringify(value, null, 2)

describe("monorepo lockfiles", () => {
  const monorepo = (coreVersion: string, uiDeps: Record<string, string>, hoisted: Record<string, any>) => ({
    name: "monorepo",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": {name: "monorepo", workspaces: ["packages/*"]},
      "node_modules/@app/core": {resolved: "packages/core", link: true},
      "node_modules/@app/ui": {resolved: "packages/ui", link: true},
      "packages/core": {name: "@app/core", version: coreVersion, dependencies: {lodash: "^4.17.0"}},
      "packages/ui": {name: "@app/ui", version: "0.1.0", dependencies: uiDeps},
      ...hoisted,
    },
  })

  const lodash = (version: string) => ({
    version,
    resolved: `https://registry.npmjs.org/lodash/-/lodash-${version}.tgz`,
    integrity: `sha512-lodash-${version}`,
  })

  test("workspace links and their targets merge consistently", async () => {
    const base = j(monorepo("1.0.0", {"@app/core": "^1.0.0"}, {"node_modules/lodash": lodash("4.17.20")}))
    const ours = j(monorepo("1.1.0", {"@app/core": "^1.1.0"}, {"node_modules/lodash": lodash("4.17.21")}))
    const theirs = j(monorepo("1.0.0", {"@app/core": "^1.0.0"}, {"node_modules/lodash": lodash("4.17.20")}))

    const result = await makeResolver().mergeJsonContents(base, ours, theirs)
    assert.equal(result.resolved, true)
    assert.equal(result.packageJson!.packages["packages/core"].version, "1.1.0")
    assert.equal(result.packageJson!.packages["packages/ui"].dependencies["@app/core"], "^1.1.0")
    assert.deepEqual(result.lockfileIssues, [], "the workspace graph must stay satisfiable")
  })

  test("a merge that leaves a workspace dependent behind is reported", async () => {
    // Each branch is fine on its own: ours has core 1.5.0 with an open range,
    // theirs has core 1.2.0 with ui pinned to exactly that version. Combining
    // the highest version with the pinned range satisfies neither.
    const ours = j(monorepo("1.5.0", {"@app/core": "^1.0.0"}, {"node_modules/lodash": lodash("4.17.21")}))
    const theirs = j(monorepo("1.2.0", {"@app/core": "1.2.0"}, {"node_modules/lodash": lodash("4.17.21")}))

    assert.deepEqual(validateLockfile(JSON.parse(ours)), [], "our branch is consistent on its own")
    assert.deepEqual(validateLockfile(JSON.parse(theirs)), [], "their branch is consistent on its own")

    const result = await makeResolver().mergeJsonContents("", ours, theirs)
    assert.equal(result.resolved, true)
    assert.equal(result.packageJson!.packages["packages/core"].version, "1.5.0")
    assert.equal(result.packageJson!.packages["packages/ui"].dependencies["@app/core"], "1.2.0")
    assert.equal(result.lockfileIssues!.length, 1)
    assert.equal(result.lockfileIssues![0]!.from, "packages/ui")
    assert.equal(result.lockfileIssues![0]!.resolvedPath, "packages/core")
  })

  test("a workspace already broken before the merge is not blamed on the merge", async () => {
    // Our branch shipped core 2.0.0 while ui still required ^1.0.0
    const ours = j(monorepo("2.0.0", {"@app/core": "^1.0.0"}, {"node_modules/lodash": lodash("4.17.21")}))
    const theirs = j(monorepo("1.0.0", {"@app/core": "^1.0.0"}, {"node_modules/lodash": lodash("4.17.21")}))

    assert.equal(validateLockfile(JSON.parse(ours)).length, 1, "our branch was already broken")

    const result = await makeResolver().mergeJsonContents("", ours, theirs)
    assert.deepEqual(result.lockfileIssues, [], "a pre-existing problem is not reported as merge damage")
    // ...but it is still genuinely there, and a fresh validation still finds it
    assert.equal(validateLockfile(result.packageJson as Record<string, any>).length, 1)
  })

  test("a link entry is never merged into a versioned entry", async () => {
    const ours = j({
      lockfileVersion: 3,
      packages: {
        "": {name: "app"},
        "node_modules/@app/core": {resolved: "packages/core", link: true},
      },
    })
    const theirs = j({
      lockfileVersion: 3,
      packages: {
        "": {name: "app"},
        "node_modules/@app/core": {version: "1.0.0", resolved: "https://r/core-1.0.0.tgz", integrity: "sha512-x"},
      },
    })

    const result = await makeResolver().mergeJsonContents("", ours, theirs)
    const entry = result.packageJson!.packages["node_modules/@app/core"]
    // Whichever side wins, a link must not acquire a tarball's integrity
    const isLink = entry.link === true
    assert.equal(
      isLink,
      entry.integrity === undefined,
      `a link entry must not carry integrity: ${JSON.stringify(entry)}`
    )
  })
})

describe("awkward but legitimate package names and specs", () => {
  test("scoped, aliased and dotted names survive a merge", async () => {
    const entry = (name: string, version: string, extra: Record<string, any> = {}) => ({
      version,
      resolved: `https://registry.npmjs.org/${name}/-/pkg-${version}.tgz`,
      integrity: `sha512-${version}`,
      ...extra,
    })

    const build = (version: string) => ({
      name: "app",
      lockfileVersion: 3,
      packages: {
        "": {
          name: "app",
          dependencies: {
            "@scope/name": "^1.0.0",
            "string-width-cjs": "npm:string-width@^4.2.0",
            "some.dotted.name": "^1.0.0",
            "UPPER-Case": "^1.0.0",
          },
        },
        "node_modules/@scope/name": entry("@scope/name", version),
        "node_modules/string-width-cjs": entry("string-width", "4.2.3", {name: "string-width"}),
        "node_modules/some.dotted.name": entry("some.dotted.name", "1.0.0"),
        "node_modules/UPPER-Case": entry("UPPER-Case", "1.0.0"),
      },
    })

    const result = await makeResolver().mergeJsonContents("", j(build("1.0.0")), j(build("1.2.0")))
    assert.equal(result.resolved, true)
    assert.equal(result.packageJson!.packages["node_modules/@scope/name"].version, "1.2.0")
    assert.deepEqual(result.lockfileIssues, [], "aliases and dotted names must not confuse the validator")
  })

  test("a package literally named like a path segment is handled", async () => {
    const build = (version: string) => ({
      name: "app",
      lockfileVersion: 3,
      packages: {
        "": {name: "app", dependencies: {node_modules: "^1.0.0"}},
        "node_modules/node_modules": {version, resolved: `https://r/nm-${version}.tgz`, integrity: `sha512-${version}`},
      },
    })

    const result = await makeResolver().mergeJsonContents("", j(build("1.0.0")), j(build("1.1.0")))
    assert.equal(result.packageJson!.packages["node_modules/node_modules"].version, "1.1.0")
    assert.deepEqual(result.lockfileIssues, [])
  })

  test("overrides and resolutions are compared as versions, not strings", async () => {
    const ours = j({overrides: {foo: "1.9.0"}, resolutions: {bar: "1.9.0"}})
    const theirs = j({overrides: {foo: "1.10.0"}, resolutions: {bar: "1.10.0"}})

    const result = await makeResolver("highest").mergeJsonContents("", ours, theirs)
    // Lexicographically "1.9.0" > "1.10.0"; semver says the opposite
    assert.equal(result.packageJson!.overrides.foo, "1.10.0")
    assert.equal(result.packageJson!.resolutions.bar, "1.10.0")
  })

  test("deeply nested duplicate packages each keep their own version", async () => {
    const deep = (leaf: string) => ({
      name: "app",
      lockfileVersion: 3,
      packages: {
        "": {name: "app", dependencies: {a: "^1.0.0"}},
        "node_modules/a": {version: "1.0.0", integrity: "sha512-a", dependencies: {b: "^1.0.0"}},
        "node_modules/a/node_modules/b": {version: "1.0.0", integrity: "sha512-b", dependencies: {c: "^1.0.0"}},
        "node_modules/a/node_modules/b/node_modules/c": {version: leaf, integrity: `sha512-c-${leaf}`},
        "node_modules/c": {version: "9.0.0", integrity: "sha512-c9"},
      },
    })

    const result = await makeResolver().mergeJsonContents("", j(deep("1.0.0")), j(deep("1.4.0")))
    const packages = result.packageJson!.packages
    assert.equal(packages["node_modules/a/node_modules/b/node_modules/c"].version, "1.4.0")
    assert.equal(packages["node_modules/c"].version, "9.0.0", "the hoisted copy is a different entry")
    assert.deepEqual(validateLockfile(result.packageJson as Record<string, any>), [])
  })
})

describe("file encodings and formatting", () => {
  const conflictedLock = (eol: string, indent: string, prefix = "") =>
    prefix +
    [
      "{",
      `${indent}"name": "app",`,
      `${indent}"lockfileVersion": 3,`,
      `${indent}"packages": {`,
      `${indent}${indent}"node_modules/foo": {`,
      "<<<<<<< HEAD",
      `${indent}${indent}${indent}"version": "1.5.0",`,
      `${indent}${indent}${indent}"integrity": "sha512-a"`,
      "=======",
      `${indent}${indent}${indent}"version": "1.2.0",`,
      `${indent}${indent}${indent}"integrity": "sha512-b"`,
      ">>>>>>> feature",
      `${indent}${indent}}`,
      `${indent}}`,
      "}",
      "",
    ].join(eol)

  test("a CRLF lockfile merges and is written back with CRLF", async () => {
    await withTempDir(async dir => {
      const file = join(dir, "package-lock.json")
      await writeFile(file, conflictedLock("\r\n", "  "), "utf8")

      const result = await runCli(["package-lock.json", "--no-regenerate-lock"], dir)
      assert.equal(result.code, 0, result.stderr)

      const written = await readFile(file, "utf8")
      assert(written.includes("\r\n"), "CRLF must be preserved")
      assert(!written.includes("<<<<<<<"))
      assert.equal(JSON.parse(written).packages["node_modules/foo"].version, "1.5.0")
    })
  })

  test("a tab-indented lockfile keeps its tabs", async () => {
    await withTempDir(async dir => {
      const file = join(dir, "package-lock.json")
      await writeFile(file, conflictedLock("\n", "\t"), "utf8")

      const result = await runCli(["package-lock.json", "--no-regenerate-lock"], dir)
      assert.equal(result.code, 0, result.stderr)

      const written = await readFile(file, "utf8")
      assert(written.includes('\t"name"'), "tab indentation must be preserved")
      assert.equal(JSON.parse(written).packages["node_modules/foo"].version, "1.5.0")
    })
  })

  test("a lockfile saved with a BOM is merged without corrupting it", async () => {
    await withTempDir(async dir => {
      const file = join(dir, "package-lock.json")
      await writeFile(file, conflictedLock("\n", "  ", "﻿"), "utf8")

      const result = await runCli(["package-lock.json", "--no-regenerate-lock"], dir)
      assert.equal(result.code, 0, result.stderr)

      const written = await readFile(file, "utf8")
      assert.doesNotThrow(() => JSON.parse(written), "the BOM must not survive into the output")
      assert.equal(JSON.parse(written).packages["node_modules/foo"].version, "1.5.0")
    })
  })
})

describe("running the tool twice", () => {
  test("a second run is a no-op and still exits 0", async () => {
    await withTempDir(async dir => {
      await writeFile(
        join(dir, "package.json"),
        [
          "{",
          '  "name": "app",',
          "<<<<<<< HEAD",
          '  "version": "1.1.0"',
          "=======",
          '  "version": "1.2.0"',
          ">>>>>>> feature",
          "}",
          "",
        ].join("\n"),
        "utf8"
      )

      const first = await runCli(["--no-regenerate-lock"], dir)
      assert.equal(first.code, 0, first.stderr)
      const afterFirst = await readFile(join(dir, "package.json"), "utf8")

      const second = await runCli(["--no-regenerate-lock"], dir)
      assert.equal(second.code, 0, second.stderr)
      assert.match(second.stdout, /No Git conflict markers found/)
      assert.equal(await readFile(join(dir, "package.json"), "utf8"), afterFirst, "the file must not drift")
    })
  })

  test("re-resolving an already merged lockfile changes nothing", async () => {
    await withTempDir(async dir => {
      const lock = [
        "{",
        '  "name": "app",',
        '  "lockfileVersion": 3,',
        '  "packages": {',
        '    "": {"name": "app", "dependencies": {"foo": "^1.0.0"}},',
        '    "node_modules/foo": {',
        "<<<<<<< HEAD",
        '      "version": "1.5.0",',
        '      "integrity": "sha512-a"',
        "=======",
        '      "version": "1.2.0",',
        '      "integrity": "sha512-b"',
        ">>>>>>> feature",
        "    }",
        "  }",
        "}",
        "",
      ].join("\n")
      await writeFile(join(dir, "package.json"), j({name: "app", dependencies: {foo: "^1.0.0"}}) + "\n", "utf8")
      await writeFile(join(dir, "package-lock.json"), lock, "utf8")

      const first = await runCli(["--no-regenerate-lock"], dir)
      assert.equal(first.code, 0, first.stderr)
      const merged = await readFile(join(dir, "package-lock.json"), "utf8")

      const second = await runCli(["--no-regenerate-lock"], dir)
      assert.equal(second.code, 0, second.stderr)
      assert.equal(await readFile(join(dir, "package-lock.json"), "utf8"), merged)
    })
  })
})

describe("large lockfiles", () => {
  test("merges a few thousand entries in reasonable time and stays consistent", async () => {
    const build = (seedOffset: number) => {
      const packages: Record<string, any> = {"": {name: "app", version: "1.0.0", dependencies: {}}}
      for (let i = 0; i < 2000; i++) {
        const name = `pkg${i}`
        const version = `1.${(i + seedOffset) % 5}.0`
        packages[`node_modules/${name}`] = {
          version,
          resolved: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
          integrity: `sha512-${name}-${version}`,
        }
        if (i < 100) packages[""].dependencies[name] = "^1.0.0"
      }
      return JSON.stringify({name: "app", lockfileVersion: 3, requires: true, packages}, null, 2)
    }

    const started = Date.now()
    const result = await makeResolver().mergeJsonContents(build(0), build(1), build(2))
    const elapsed = Date.now() - started

    assert.equal(result.resolved, true)
    assert.equal(Object.keys(result.packageJson!.packages).length, 2001)
    assert.deepEqual(result.lockfileIssues, [])
    assert(elapsed < 15_000, `merging 2000 entries took ${elapsed}ms`)
  })
})
