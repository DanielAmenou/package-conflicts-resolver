/**
 * Edge-case tests: CRLF, diff3 style, BOM, lockfile atomicity, non-semver
 * specs, numeric fields, empty merge inputs, and formatting preservation.
 */

import {strict as assert} from "assert"
import {test, describe} from "node:test"
import {mkdtemp, readFile, rm} from "fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {ConflictParser} from "../conflict-parser.js"
import {VersionResolver} from "../version-resolver.js"
import {PackageResolver} from "../package-resolver.js"
import {CliOptions} from "../types.js"

function makeResolver(strategy: CliOptions["strategy"] = "highest", dryRun = false): PackageResolver {
  return new PackageResolver({
    strategy,
    dryRun,
    quiet: true,
    json: false,
    verbose: false,
    regenerateLock: false,
  })
}

describe("ConflictParser edge cases", () => {
  test("parses conflicts in CRLF files", () => {
    const content = [
      "{\r",
      "<<<<<<< HEAD\r",
      '  "version": "1.1.0"\r',
      "=======\r",
      '  "version": "1.2.0"\r',
      ">>>>>>> feature\r",
      "}\r",
      "",
    ].join("\n")

    const conflicts = ConflictParser.parseConflicts(content)
    assert.equal(conflicts.length, 1)
    assert(conflicts[0]!.ours.includes("1.1.0"))
    assert(conflicts[0]!.theirs.includes("1.2.0"))
  })

  test("parses diff3-style conflicts with base section", () => {
    const content = [
      "{",
      "<<<<<<< HEAD",
      '  "version": "1.1.0"',
      "||||||| merged common ancestors",
      '  "version": "1.0.0"',
      "=======",
      '  "version": "1.2.0"',
      ">>>>>>> feature",
      "}",
    ].join("\n")

    const conflicts = ConflictParser.parseConflicts(content)
    assert.equal(conflicts.length, 1)
    assert(conflicts[0]!.ours.includes("1.1.0"))
    assert.equal(conflicts[0]!.base!.trim(), '"version": "1.0.0"')
    assert(conflicts[0]!.theirs.includes("1.2.0"))
    assert(!conflicts[0]!.ours.includes("1.0.0"), "base content must not leak into ours")
  })

  test("extracts base side from diff3 conflicts", () => {
    const content = [
      "{",
      "<<<<<<< HEAD",
      '  "version": "1.1.0"',
      "||||||| base",
      '  "version": "1.0.0"',
      "=======",
      '  "version": "1.2.0"',
      ">>>>>>> feature",
      "}",
    ].join("\n")

    const base = ConflictParser.extractConflictSide(content, "base")
    assert.deepEqual(JSON.parse(base), {version: "1.0.0"})
  })

  test("handles markers without labels", () => {
    const content = ["{", "<<<<<<<", '  "version": "1.1.0"', "=======", '  "version": "1.2.0"', ">>>>>>>", "}"].join(
      "\n"
    )

    const conflicts = ConflictParser.parseConflicts(content)
    assert.equal(conflicts.length, 1)
  })

  test("preserves empty lines inside conflict sections", () => {
    const content = ["<<<<<<< HEAD", "line1", "", "line2", "=======", "other", ">>>>>>> branch"].join("\n")

    const conflicts = ConflictParser.parseConflicts(content)
    assert.equal(conflicts[0]!.ours, "line1\n\nline2")
  })

  test("does not treat similar-looking content lines as markers", () => {
    const content = ["{", '  "a": "<<<<<<< not a marker"', "}"].join("\n")
    assert.equal(ConflictParser.hasConflicts(content), false)
  })
})

describe("VersionResolver edge cases", () => {
  test("handles wildcard ranges", () => {
    const result = VersionResolver.resolveVersion("*", "^1.0.0", "highest")
    assert.equal(result.resolved, "^1.0.0")
  })

  test("handles x-ranges", () => {
    const result = VersionResolver.resolveVersion("1.x", "2.x", "highest")
    assert.equal(result.resolved, "2.x")
  })

  test("keeps ours deterministically for workspace protocol", () => {
    const result = VersionResolver.resolveVersion("workspace:*", "^1.0.0", "highest")
    assert.equal(result.resolved, "workspace:*")
    assert(result.reason.includes("not comparable"))
  })

  test("handles file: specs without throwing", () => {
    const result = VersionResolver.resolveVersion("file:../local-pkg", "^2.0.0", "highest")
    assert.equal(result.resolved, "file:../local-pkg")
  })

  test("handles npm: alias specs without throwing", () => {
    const result = VersionResolver.resolveVersion("npm:foo@^1.0.0", "npm:foo@^2.0.0", "highest")
    assert.ok(result.resolved)
  })

  test("identical non-semver specs resolve as identical", () => {
    const result = VersionResolver.resolveVersion("workspace:*", "workspace:*", "highest")
    assert.equal(result.resolved, "workspace:*")
    assert(result.reason.includes("identical"))
  })

  test("theirs strategy wins even for non-comparable specs", () => {
    const result = VersionResolver.resolveVersion("workspace:*", "file:../pkg", "theirs")
    assert.equal(result.resolved, "file:../pkg")
  })

  test("compares numbers numerically in resolveNonVersion", () => {
    assert.equal(VersionResolver.resolveNonVersion(2, 3, "highest").resolved, 3)
    assert.equal(VersionResolver.resolveNonVersion(2, 3, "lowest").resolved, 2)
    // Lexicographic comparison would get 9 vs 10 wrong
    assert.equal(VersionResolver.resolveNonVersion(9, 10, "highest").resolved, 10)
  })
})

describe("PackageResolver edge cases", () => {
  test("resolves conflicts in CRLF files", async () => {
    const content = [
      "{",
      '  "name": "test",',
      "<<<<<<< HEAD",
      '  "version": "1.1.0"',
      "=======",
      '  "version": "1.2.0"',
      ">>>>>>> feature",
      "}",
    ].join("\r\n")

    const resolver = makeResolver()
    const result = await resolver.resolveConflicts(content)
    assert.equal(result.resolved, true)
    assert.equal(result.packageJson!.version, "1.2.0")
  })

  test("uses diff3 base for a true 3-way merge", async () => {
    // Ours didn't change from base; theirs did: theirs must win without
    // being treated as a conflict.
    const content = [
      "{",
      "<<<<<<< HEAD",
      '  "version": "1.0.0"',
      "||||||| base",
      '  "version": "1.0.0"',
      "=======",
      '  "version": "0.9.0"',
      ">>>>>>> feature",
      "}",
    ].join("\n")

    const resolver = makeResolver("highest")
    const result = await resolver.resolveConflicts(content)
    assert.equal(result.resolved, true)
    // 3-way semantics: ours unchanged from base, so their change is taken
    // even though it is a lower version.
    assert.equal(result.packageJson!.version, "0.9.0")
  })

  test("strips BOM before parsing", async () => {
    const content =
      "﻿" +
      ["{", "<<<<<<< HEAD", '  "version": "1.1.0"', "=======", '  "version": "1.2.0"', ">>>>>>> feature", "}"].join(
        "\n"
      )

    const resolver = makeResolver()
    const result = await resolver.resolveConflicts(content)
    assert.equal(result.resolved, true)
    assert.equal(result.packageJson!.version, "1.2.0")
  })

  test("keeps boolean fields as booleans", async () => {
    const content = [
      "{",
      '  "name": "test",',
      "<<<<<<< HEAD",
      '  "private": true',
      "=======",
      '  "private": false',
      ">>>>>>> feature",
      "}",
    ].join("\n")

    const resolver = makeResolver()
    const result = await resolver.resolveConflicts(content)
    assert.equal(result.resolved, true)
    assert.equal(typeof result.packageJson!.private, "boolean")
  })

  test("keeps lockfileVersion numeric and picks the highest", async () => {
    const ours = JSON.stringify({name: "a", lockfileVersion: 2, packages: {}})
    const theirs = JSON.stringify({name: "a", lockfileVersion: 3, packages: {}})
    const base = JSON.stringify({name: "a", lockfileVersion: 1, packages: {}})

    const resolver = makeResolver("highest")
    const result = await resolver.mergeJsonContents(base, ours, theirs)
    assert.equal(result.resolved, true)
    assert.equal(result.packageJson!.lockfileVersion, 3)
  })

  test("keeps lockfile entries atomic (version/resolved/integrity move together)", async () => {
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

    // Chosen so a lexicographic field-wise merge would pair 4.10.0 with the
    // wrong resolved URL/integrity.
    const ours = makeLock("4.9.0", "zzzz")
    const theirs = makeLock("4.10.0", "aaaa")
    const base = makeLock("4.8.0", "mmmm")

    const resolver = makeResolver("highest")
    const result = await resolver.mergeJsonContents(base, ours, theirs)
    assert.equal(result.resolved, true)

    const entry = result.packageJson!.packages["node_modules/lodash"]
    assert.equal(entry.version, "4.10.0")
    assert.equal(entry.resolved, "https://registry.npmjs.org/lodash/-/lodash-4.10.0.tgz")
    assert.equal(entry.integrity, "sha512-aaaa")
  })

  test("handles empty base file (added on both branches)", async () => {
    const ours = JSON.stringify({name: "a", version: "1.0.0"})
    const theirs = JSON.stringify({name: "a", version: "1.1.0"})

    const resolver = makeResolver("highest")
    const result = await resolver.mergeJsonContents("", ours, theirs)
    assert.equal(result.resolved, true)
    assert.equal(result.packageJson!.version, "1.1.0")
  })

  test("handles one empty side (file only exists on one branch)", async () => {
    const theirs = JSON.stringify({name: "a", version: "1.1.0"})

    const resolver = makeResolver("highest")
    const result = await resolver.mergeJsonContents("", "", theirs)
    assert.equal(result.resolved, true)
    assert.equal(result.packageJson!.version, "1.1.0")
  })

  test("fails cleanly when both sides are empty", async () => {
    const resolver = makeResolver("highest")
    const result = await resolver.mergeJsonContents("", "", "")
    assert.equal(result.resolved, false)
    assert(result.errors.length > 0)
  })

  test("merges dependencies with non-semver specs without corrupting them", async () => {
    const base = JSON.stringify({dependencies: {shared: "workspace:*"}})
    const ours = JSON.stringify({dependencies: {shared: "workspace:*", lodash: "^4.17.21"}})
    const theirs = JSON.stringify({dependencies: {shared: "workspace:*", react: "^18.0.0"}})

    const resolver = makeResolver("highest")
    const result = await resolver.mergeJsonContents(base, ours, theirs)
    assert.equal(result.resolved, true)
    assert.deepEqual(result.packageJson!.dependencies, {
      shared: "workspace:*",
      lodash: "^4.17.21",
      react: "^18.0.0",
    })
  })
})

describe("Formatting preservation", () => {
  test("preserves 4-space indentation, CRLF and trailing newline", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pcr-test-"))
    const filePath = join(dir, "package.json")

    try {
      const original = '{\r\n    "name": "test",\r\n    "version": "1.0.0"\r\n}\r\n'
      const resolver = makeResolver()
      await resolver.writeResolvedPackage({name: "test", version: "2.0.0"}, filePath, original)

      const written = await readFile(filePath, "utf8")
      assert(written.includes('\r\n    "name"'), "should keep 4-space indent and CRLF")
      assert(written.endsWith("\r\n"), "should keep trailing newline")
      assert.deepEqual(JSON.parse(written), {name: "test", version: "2.0.0"})
    } finally {
      await rm(dir, {recursive: true, force: true})
    }
  })

  test("preserves tab indentation and missing trailing newline", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pcr-test-"))
    const filePath = join(dir, "package.json")

    try {
      const original = '{\n\t"name": "test"\n}'
      const resolver = makeResolver()
      await resolver.writeResolvedPackage({name: "test"}, filePath, original)

      const written = await readFile(filePath, "utf8")
      assert(written.includes('\t"name"'), "should keep tab indent")
      assert(!written.endsWith("\n"), "should not add trailing newline when original had none")
    } finally {
      await rm(dir, {recursive: true, force: true})
    }
  })

  test("defaults to 2-space indent with trailing newline", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pcr-test-"))
    const filePath = join(dir, "package.json")

    try {
      const resolver = makeResolver()
      await resolver.writeResolvedPackage({name: "test"}, filePath)

      const written = await readFile(filePath, "utf8")
      assert.equal(written, '{\n  "name": "test"\n}\n')
    } finally {
      await rm(dir, {recursive: true, force: true})
    }
  })
})
