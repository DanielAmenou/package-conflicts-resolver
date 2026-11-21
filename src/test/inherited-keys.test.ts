/**
 * Keys named like a property every JavaScript object has: "constructor",
 * "toString", "valueOf", "__proto__"... "constructor" and "valueOf" are real
 * npm packages, and JSON allows any key in scripts or config.
 *
 * Looked up on an object that does not have it, such a key finds the
 * inherited function; set with an assignment, "__proto__" changes the
 * object's prototype instead. Either way the merge would lose the value, or
 * fail on a function it cannot write.
 */

import {strict as assert} from "assert"
import {test, describe} from "node:test"
import {readFile, writeFile} from "fs/promises"
import {join} from "node:path"
import {ConflictParser} from "../conflict-parser.js"
import {PackageResolver} from "../package-resolver.js"
import {CliOptions} from "../types.js"
import {conflictedDocument, runCli, withTempDir} from "./cli-harness.js"

const resolver = (strategy: CliOptions["strategy"] = "highest", dryRun = true) =>
  new PackageResolver({strategy, dryRun, quiet: true, json: false, verbose: false, regenerateLock: false})

const j = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`

/** Every key a plain object inherits: constructor, toString, __proto__, hasOwnProperty... */
const INHERITED = Object.getOwnPropertyNames(Object.prototype)

/** An object with these entries as its own keys, "__proto__" included */
const entries = (pairs: Array<[string, unknown]>) => JSON.parse(JSON.stringify(Object.fromEntries(pairs)))

/** Assert that an object has exactly these entries, in this order, and the usual prototype */
function assertEntries(actual: unknown, pairs: Array<[string, unknown]>, message: string): void {
  assert(actual !== null && typeof actual === "object", message)
  assert.equal(Object.getPrototypeOf(actual), Object.prototype, `${message}: the prototype changed`)
  assert.deepEqual(Object.entries(actual), pairs, message)
}

describe("a key named like a property every object has", () => {
  test("a dependency named constructor that their branch added is kept", async () => {
    const result = await resolver().resolveConflicts(
      conflictedDocument(
        {dependencies: {lodash: "^4.17.21"}},
        {dependencies: {constructor: "^1.0.0", lodash: "^4.17.20"}}
      )
    )
    assert.equal(result.resolved, true, result.errors.join(", "))
    assert.deepEqual(result.unresolved, [])
    assertEntries(
      result.packageJson!.dependencies,
      [
        ["constructor", "^1.0.0"],
        ["lodash", "^4.17.21"],
      ],
      "dependencies"
    )
  })

  test("every such key is merged like any other, whichever branch has it", async () => {
    for (const name of INHERITED) {
      // Added by one branch only, while both changed the other dependency
      for (const side of ["ours", "theirs"] as const) {
        const added = entries([
          [name, "^1.0.0"],
          ["zod", side === "ours" ? "^3.1.0" : "^3.2.0"],
        ])
        const other = entries([["zod", side === "ours" ? "^3.2.0" : "^3.1.0"]])
        const [ours, theirs] = side === "ours" ? [added, other] : [other, added]
        const result = await resolver().mergeJsonContents(
          j({dependencies: {zod: "^3.0.0"}}),
          j({dependencies: ours}),
          j({dependencies: theirs})
        )
        const where = `${name}, added by ${side}`
        assert.equal(result.resolved, true, `${where}: ${result.errors.join(", ")}`)
        assert.deepEqual(result.unresolved, [], where)
        assertEntries(
          result.packageJson!.dependencies,
          [
            [name, "^1.0.0"],
            ["zod", "^3.2.0"],
          ].sort(([a], [b]) => new Intl.Collator("en").compare(a as string, b as string)) as Array<[string, unknown]>,
          where
        )
      }

      // Changed by both branches: the strategy decides it, against the right common ancestor
      const result = await resolver().mergeJsonContents(
        j({dependencies: entries([[name, "^1.0.0"]])}),
        j({dependencies: entries([[name, "^1.1.0"]])}),
        j({dependencies: entries([[name, "^1.2.0"]])})
      )
      assertEntries(result.packageJson!.dependencies, [[name, "^1.2.0"]], `${name}, changed by both`)
      assert.equal(result.packageConflicts?.[0]?.base, "^1.0.0", name)
    }
  })

  test("one their branch removed and ours changed stays removed, and the dropped change is reported", async () => {
    const result = await resolver().mergeJsonContents(
      j({dependencies: {constructor: "^1.0.0", zod: "^3.0.0"}}),
      j({dependencies: {constructor: "^1.1.0", zod: "^3.0.0"}}),
      j({dependencies: {zod: "^3.0.0"}})
    )
    assert.deepEqual(result.unresolved, [])
    assertEntries(result.packageJson!.dependencies, [["zod", "^3.0.0"]], "dependencies")
    assert.deepEqual(
      result.packageConflicts?.map(conflict => [conflict.name, conflict.ours, conflict.theirs, conflict.resolvedBy]),
      [["constructor", "^1.1.0", null, "removal"]]
    )
  })

  test("a script named like one that one branch removed is left for the user, and written as a conflict", async () => {
    await withTempDir(async dir => {
      const file = join(dir, "package.json")
      const merger = resolver("highest", false)
      const ours = j({name: "app", scripts: {build: "tsc"}})
      const result = await merger.mergeJsonContents(
        j({name: "app", scripts: {build: "tsc", toString: "echo a"}}),
        ours,
        j({name: "app", scripts: {build: "tsc", toString: "echo b"}})
      )
      assert.deepEqual(
        result.unresolved?.map(conflict => [conflict.field, conflict.reason, conflict.ours, conflict.theirs]),
        [["scripts.toString", "removed", undefined, "echo b"]]
      )

      await merger.writeResolvedPackage(result.packageJson!, file, ours, result.unresolved)
      const written = await readFile(file, "utf8")
      assert.deepEqual(JSON.parse(ConflictParser.extractConflictSide(written, "ours")).scripts, {build: "tsc"})
      assert.deepEqual(JSON.parse(ConflictParser.extractConflictSide(written, "theirs")).scripts, {
        toString: "echo b",
        build: "tsc",
      })
    })
  })

  test("__proto__ is kept as a key, and leaves the merged object's prototype alone", async () => {
    const result = await resolver().mergeJsonContents(
      j({config: {port: 1}}),
      j({config: {port: 2}}),
      '{"config": {"__proto__": {"polluted": true}, "port": 1}}\n'
    )
    const config = result.packageJson!.config
    assertEntries(
      config,
      [
        ["__proto__", {polluted: true}],
        ["port", 2],
      ],
      "config"
    )
    assert.equal(config.polluted, undefined)
    assert.match(JSON.stringify(result.packageJson), /"__proto__":\{"polluted":true\}/)
  })

  test("the block-based merge, for sides that are not JSON, keeps them too", async () => {
    // The value without quotes on our side is not JSON, which no repair changes
    const content = [
      "{",
      '  "dependencies": {',
      "<<<<<<< HEAD",
      '    "lodash": ^4.17.21',
      "=======",
      '    "lodash": "^4.17.21",',
      '    "constructor": "^1.0.0"',
      ">>>>>>> feature",
      "  }",
      "}",
    ].join("\n")
    const result = await resolver().resolveConflicts(content)
    assert.equal(result.resolved, true, result.errors.join(", "))
    assertEntries(
      result.packageJson!.dependencies,
      [
        ["lodash", "^4.17.21"],
        ["constructor", "^1.0.0"],
      ],
      "dependencies"
    )
  })

  test("the CLI and the merge driver resolve them and write the file", async () => {
    await withTempDir(async dir => {
      const file = join(dir, "package.json")
      await writeFile(
        file,
        conflictedDocument(
          {name: "app", version: "1.1.0", dependencies: {lodash: "^4.17.21"}},
          {name: "app", version: "1.2.0", dependencies: {constructor: "^1.0.0", lodash: "^4.17.20"}}
        )
      )
      const cli = await runCli(["--no-regenerate-lock"], dir)
      assert.equal(cli.code, 0, cli.stderr)
      assert.deepEqual(JSON.parse(await readFile(file, "utf8")).dependencies, {
        constructor: "^1.0.0",
        lodash: "^4.17.21",
      })

      // Our branch removed valueOf, their branch upgraded it: it stays removed, and the driver says so
      const base = join(dir, "base.json")
      const theirs = join(dir, "theirs.json")
      await writeFile(base, j({name: "app", dependencies: {valueOf: "^1.0.0", zod: "^3.0.0"}}))
      await writeFile(file, j({name: "app", dependencies: {zod: "^3.1.0"}}))
      await writeFile(theirs, j({name: "app", dependencies: {valueOf: "^1.1.0", zod: "^3.0.0"}}))
      const driver = await runCli(["merge-driver", file, base, theirs], dir)
      assert.equal(driver.code, 0, driver.stderr)
      assert.match(driver.stderr, /dependencies\.valueOf: our branch removed it, their change to \^1\.1\.0 was dropped/)
      assert.deepEqual(JSON.parse(await readFile(file, "utf8")).dependencies, {zod: "^3.1.0"})
    })
  })
})
