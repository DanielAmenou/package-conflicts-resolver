/**
 * Merge-semantics tests: 3-way merge rules (add/modify/delete), strategy
 * behavior across whole documents, array handling, key ordering, lockfile
 * scenarios, and additional parser/version-resolver coverage.
 */

import {strict as assert} from "assert"
import {test, describe} from "node:test"
import {access} from "fs/promises"
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

const j = (value: unknown) => JSON.stringify(value)

describe("Three-way merge semantics", () => {
  test("deletion on one side wins when the other side is unchanged", async () => {
    const base = j({dependencies: {lodash: "^4.17.20", express: "^4.18.0"}})
    const ours = j({dependencies: {express: "^4.18.0"}}) // we removed lodash
    const theirs = j({dependencies: {lodash: "^4.17.20", express: "^4.18.0"}}) // unchanged

    const result = await makeResolver().mergeJsonContents(base, ours, theirs)
    assert.equal(result.resolved, true)
    assert.deepEqual(result.packageJson!.dependencies, {express: "^4.18.0"})
  })

  test("modification wins over deletion", async () => {
    const base = j({dependencies: {lodash: "^1.0.0"}})
    const ours = j({dependencies: {}}) // we deleted lodash
    const theirs = j({dependencies: {lodash: "^2.0.0"}}) // they upgraded it

    const result = await makeResolver().mergeJsonContents(base, ours, theirs)
    assert.equal(result.resolved, true)
    assert.deepEqual(result.packageJson!.dependencies, {lodash: "^2.0.0"})
  })

  test("dependency added on both sides with different ranges uses the strategy", async () => {
    const base = j({dependencies: {}})
    const ours = j({dependencies: {axios: "^1.5.0"}})
    const theirs = j({dependencies: {axios: "^1.6.0"}})

    const highest = await makeResolver("highest").mergeJsonContents(base, ours, theirs)
    assert.equal(highest.packageJson!.dependencies!.axios, "^1.6.0")

    const lowest = await makeResolver("lowest").mergeJsonContents(base, ours, theirs)
    assert.equal(lowest.packageJson!.dependencies!.axios, "^1.5.0")
  })

  test("script changed on one side wins; unrelated scripts merge", async () => {
    const base = j({scripts: {build: "tsc", test: "jest"}})
    const ours = j({scripts: {build: "tsc --strict", test: "jest"}})
    const theirs = j({scripts: {build: "tsc", test: "jest", lint: "eslint ."}})

    const result = await makeResolver().mergeJsonContents(base, ours, theirs)
    assert.equal(result.resolved, true)
    assert.deepEqual(result.packageJson!.scripts, {
      build: "tsc --strict",
      test: "jest",
      lint: "eslint .",
    })
  })

  test("root version bumped on both sides resolves by strategy", async () => {
    const base = j({name: "app", version: "1.0.0"})
    const ours = j({name: "app", version: "1.1.0"})
    const theirs = j({name: "app", version: "1.0.5"})

    const result = await makeResolver("highest").mergeJsonContents(base, ours, theirs)
    assert.equal(result.packageJson!.version, "1.1.0")
    assert.equal(result.conflicts.length, 1)
    assert.equal(result.conflicts[0]!.field, "version")
  })

  test("primitive arrays merge as a union", async () => {
    const base = j({keywords: ["cli"]})
    const ours = j({keywords: ["cli", "git"]})
    const theirs = j({keywords: ["cli", "merge"]})

    const result = await makeResolver().mergeJsonContents(base, ours, theirs)
    assert.deepEqual(result.packageJson!.keywords, ["cli", "git", "merge"])
  })

  test("array unchanged from base takes the other side verbatim", async () => {
    const base = j({files: ["dist"]})
    const ours = j({files: ["dist"]})
    const theirs = j({files: ["dist", "README.md"]})

    const result = await makeResolver().mergeJsonContents(base, ours, theirs)
    assert.deepEqual(result.packageJson!.files, ["dist", "README.md"])
    assert.equal(result.conflicts.length, 0, "no conflict when only one side changed")
  })

  test("ours strategy prefers our side for every conflicting leaf", async () => {
    const base = j({version: "1.0.0", description: "old", dependencies: {a: "^1.0.0"}})
    const ours = j({version: "1.1.0", description: "ours", dependencies: {a: "^1.1.0"}})
    const theirs = j({version: "1.2.0", description: "theirs", dependencies: {a: "^1.2.0"}})

    const result = await makeResolver("ours").mergeJsonContents(base, ours, theirs)
    assert.equal(result.packageJson!.version, "1.1.0")
    assert.equal(result.packageJson!.description, "ours")
    assert.equal(result.packageJson!.dependencies!.a, "^1.1.0")
  })

  test("theirs strategy prefers their side for every conflicting leaf", async () => {
    const base = j({version: "1.0.0", description: "old"})
    const ours = j({version: "1.1.0", description: "ours"})
    const theirs = j({version: "1.0.5", description: "theirs"})

    const result = await makeResolver("theirs").mergeJsonContents(base, ours, theirs)
    assert.equal(result.packageJson!.version, "1.0.5")
    assert.equal(result.packageJson!.description, "theirs")
  })

  test("preserves our key order and appends their new keys", async () => {
    const base = j({dependencies: {}})
    const ours = j({dependencies: {zebra: "^1.0.0", alpha: "^1.0.0"}})
    const theirs = j({dependencies: {beta: "^1.0.0"}})

    const result = await makeResolver().mergeJsonContents(base, ours, theirs)
    assert.deepEqual(Object.keys(result.packageJson!.dependencies!), ["zebra", "alpha", "beta"])
  })

  test("field added identically on both sides is not a conflict", async () => {
    const base = j({name: "app"})
    const ours = j({name: "app", engines: {node: ">=20"}})
    const theirs = j({name: "app", engines: {node: ">=20"}})

    const result = await makeResolver().mergeJsonContents(base, ours, theirs)
    assert.deepEqual(result.packageJson!.engines, {node: ">=20"})
    assert.equal(result.conflicts.length, 0)
  })
})

describe("Lockfile merge scenarios", () => {
  const lockWith = (packages: Record<string, any>) =>
    j({name: "app", version: "1.0.0", lockfileVersion: 3, packages: {"": {name: "app", version: "1.0.0"}, ...packages}})

  test("packages added on different branches both survive", async () => {
    const base = lockWith({})
    const ours = lockWith({
      "node_modules/express": {version: "4.18.0", resolved: "https://r/express-4.18.0.tgz", integrity: "sha512-e"},
    })
    const theirs = lockWith({
      "node_modules/react": {version: "18.2.0", resolved: "https://r/react-18.2.0.tgz", integrity: "sha512-r"},
    })

    const result = await makeResolver().mergeJsonContents(base, ours, theirs)
    assert.equal(result.resolved, true)
    const packages = result.packageJson!.packages
    assert.ok(packages["node_modules/express"])
    assert.ok(packages["node_modules/react"])
  })

  test("ours strategy keeps our whole entry even when theirs is higher", async () => {
    const entry = (version: string, hash: string) => ({
      version,
      resolved: `https://r/pkg-${version}.tgz`,
      integrity: `sha512-${hash}`,
    })
    const base = lockWith({"node_modules/pkg": entry("1.0.0", "base")})
    const ours = lockWith({"node_modules/pkg": entry("1.1.0", "ours")})
    const theirs = lockWith({"node_modules/pkg": entry("2.0.0", "theirs")})

    const result = await makeResolver("ours").mergeJsonContents(base, ours, theirs)
    const merged = result.packageJson!.packages["node_modules/pkg"]
    assert.equal(merged.version, "1.1.0")
    assert.equal(merged.integrity, "sha512-ours")
  })

  test("entry removed on one side and untouched on the other stays removed", async () => {
    const entry = {version: "1.0.0", resolved: "https://r/pkg-1.0.0.tgz", integrity: "sha512-x"}
    const base = lockWith({"node_modules/pkg": entry})
    const ours = lockWith({}) // we removed it
    const theirs = lockWith({"node_modules/pkg": entry}) // untouched

    const result = await makeResolver().mergeJsonContents(base, ours, theirs)
    assert.equal(result.packageJson!.packages["node_modules/pkg"], undefined)
  })

  test("dependencies of the winning lock entry are kept consistent", async () => {
    const base = lockWith({
      "node_modules/pkg": {version: "1.0.0", integrity: "sha512-b", dependencies: {dep: "^1.0.0"}},
    })
    const ours = lockWith({
      "node_modules/pkg": {version: "1.5.0", integrity: "sha512-o", dependencies: {dep: "^1.5.0"}},
    })
    const theirs = lockWith({
      "node_modules/pkg": {version: "2.0.0", integrity: "sha512-t", dependencies: {dep: "^2.0.0", extra: "^1.0.0"}},
    })

    const result = await makeResolver("highest").mergeJsonContents(base, ours, theirs)
    const merged = result.packageJson!.packages["node_modules/pkg"]
    assert.equal(merged.version, "2.0.0")
    assert.equal(merged.integrity, "sha512-t")
    assert.deepEqual(merged.dependencies, {dep: "^2.0.0", extra: "^1.0.0"}, "winner's dependencies must come along")
  })
})

describe("ConflictParser additional coverage", () => {
  test("parses multiple conflicts in one file", () => {
    const content = [
      "{",
      "<<<<<<< HEAD",
      '  "version": "1.1.0",',
      "=======",
      '  "version": "1.2.0",',
      ">>>>>>> feature",
      '  "license": "MIT",',
      "<<<<<<< HEAD",
      '  "description": "a"',
      "=======",
      '  "description": "b"',
      ">>>>>>> feature",
      "}",
    ].join("\n")

    const conflicts = ConflictParser.parseConflicts(content)
    assert.equal(conflicts.length, 2)
    assert(conflicts[0]!.ours.includes("1.1.0"))
    assert(conflicts[1]!.theirs.includes('"b"'))
  })

  test("ignores an unterminated conflict", () => {
    const content = ["{", "<<<<<<< HEAD", '  "version": "1.1.0"', "=======", '  "version": "1.2.0"', "}"].join("\n")
    assert.equal(ConflictParser.parseConflicts(content).length, 0)
  })

  test("does not treat 8-character marker lines as conflicts", () => {
    const content = ["<<<<<<<<", "x", "========", "y", ">>>>>>>>"].join("\n")
    assert.equal(ConflictParser.hasConflicts(content), false)
  })

  test("handles zdiff3 conflicts with an empty base section", () => {
    // Both branches added the same key: zdiff3 emits an empty base section
    const content = [
      "{",
      "<<<<<<< HEAD",
      '  "version": "1.1.0"',
      "||||||| 1a2b3c4",
      "=======",
      '  "version": "1.2.0"',
      ">>>>>>> feature",
      "}",
    ].join("\n")

    const conflicts = ConflictParser.parseConflicts(content)
    assert.equal(conflicts.length, 1)
    assert.equal(conflicts[0]!.base, "")

    const base = ConflictParser.extractConflictSide(content, "base")
    assert.deepEqual(JSON.parse(base), {})
  })

  test("resolves zdiff3 empty-base conflicts end to end", async () => {
    const content = [
      "{",
      "<<<<<<< HEAD",
      '  "version": "1.1.0"',
      "||||||| 1a2b3c4",
      "=======",
      '  "version": "1.2.0"',
      ">>>>>>> feature",
      "}",
    ].join("\n")

    const result = await makeResolver("highest").resolveConflicts(content)
    assert.equal(result.resolved, true)
    assert.equal(result.packageJson!.version, "1.2.0")
  })

  test("handles a conflict ending at the last line without trailing newline", () => {
    const content = ["<<<<<<< HEAD", "a", "=======", "b", ">>>>>>> feature"].join("\n")
    const conflicts = ConflictParser.parseConflicts(content)
    assert.equal(conflicts.length, 1)
    assert.equal(conflicts[0]!.ours, "a")
    assert.equal(conflicts[0]!.theirs, "b")
  })

  test("removeConflictMarkers replaces each conflict with its resolution", () => {
    const content = ["before", "<<<<<<< HEAD", "a", "=======", "b", ">>>>>>> feature", "after"].join("\n")
    const conflicts = ConflictParser.parseConflicts(content)
    const resolved = new Map<number, string>([[conflicts[0]!.start, "RESOLVED"]])

    assert.equal(ConflictParser.removeConflictMarkers(content, resolved), "before\nRESOLVED\nafter")
  })
})

describe("VersionResolver additional coverage", () => {
  test("compares two pre-releases of the same version", () => {
    const result = VersionResolver.resolveVersion("2.0.0-rc.1", "2.0.0-beta.5", "highest")
    assert.equal(result.resolved, "2.0.0-rc.1")
  })

  test("handles v-prefixed versions", () => {
    const result = VersionResolver.resolveVersion("v2.0.0", "1.9.0", "highest")
    assert.equal(result.resolved, "v2.0.0")
  })

  test("handles hyphen ranges", () => {
    const result = VersionResolver.resolveVersion("1.0.0 - 1.5.0", "^1.2.0", "highest")
    assert.equal(result.resolved, "^1.2.0")
  })

  test("lowest strategy works with caret ranges", () => {
    const result = VersionResolver.resolveVersion("^2.0.0", "^1.0.0", "lowest")
    assert.equal(result.resolved, "^1.0.0")
  })

  test("lowest strategy keeps ours for non-comparable specs", () => {
    const result = VersionResolver.resolveVersion("git+https://g/a.git", "git+https://g/b.git", "lowest")
    assert.equal(result.resolved, "git+https://g/a.git")
    assert(result.reason.includes("not comparable"))
  })

  test("never throws for garbage input", () => {
    assert.doesNotThrow(() => VersionResolver.resolveVersion("", "", "highest"))
    assert.doesNotThrow(() => VersionResolver.resolveVersion("!!!", "???", "lowest"))
    assert.doesNotThrow(() => VersionResolver.resolveVersion(undefined as any, null as any, "highest"))
  })
})

describe("Dry run", () => {
  test("writeResolvedPackage does not create a file in dry-run mode", async () => {
    const filePath = join(tmpdir(), `pcr-dry-run-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)

    const resolver = makeResolver("highest", true)
    await resolver.writeResolvedPackage({name: "test"}, filePath)

    await assert.rejects(access(filePath), "dry run must not write the file")
  })
})
