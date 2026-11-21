/**
 * Where the keys of a merged object go.
 *
 * A key only their branch has is placed where it sits in their order, not
 * after all of ours: appended, a dependency would be re-sorted by the package
 * manager on the next install, and show up there as an unrelated change.
 */

import {strict as assert} from "assert"
import {test, describe} from "node:test"
import {PackageResolver} from "../package-resolver.js"
import {CliOptions} from "../types.js"
import {conflictedDocument} from "./cli-harness.js"

const resolver = (strategy: CliOptions["strategy"] = "highest") =>
  new PackageResolver({strategy, dryRun: true, quiet: true, json: false, verbose: false, regenerateLock: false})

const j = (value: unknown) => JSON.stringify(value, null, 2)

/** The keys of an object merged from three versions of it (no base: a two-way merge), in their order */
async function mergedKeys(
  base: Record<string, unknown> | undefined,
  ours: Record<string, unknown>,
  theirs: Record<string, unknown>
): Promise<string[]> {
  const result = await resolver("ours").mergeJsonContents(
    base === undefined ? "" : j({object: base}),
    j({object: ours}),
    j({object: theirs})
  )
  assert.equal(result.resolved, true, result.errors.join(", "))
  return Object.keys(result.packageJson!.object)
}

/** An object with the given keys, in the given order */
const keys = (...names: string[]) => Object.fromEntries(names.map(name => [name, "1"]))

describe("keys only their branch has", () => {
  test("a dependency they added is placed in order, not after ours", async () => {
    const result = await resolver().mergeJsonContents(
      j({dependencies: {lodash: "^4.17.20", zod: "^3.0.0"}}),
      j({dependencies: {lodash: "^4.17.21", zod: "^3.0.0"}}),
      j({dependencies: {express: "^4.18.0", lodash: "^4.17.20", zod: "^3.0.0"}})
    )
    assert.deepEqual(Object.keys(result.packageJson!.dependencies!), ["express", "lodash", "zod"])
  })

  test("the same holds when resolving from conflict markers", async () => {
    const result = await resolver().resolveConflicts(
      conflictedDocument(
        {dependencies: {lodash: "^4.17.21", zod: "^3.0.0"}},
        {dependencies: {express: "^4.18.0", lodash: "^4.17.20", zod: "^3.0.0"}}
      )
    )
    assert.deepEqual(Object.keys(result.packageJson!.dependencies!), ["express", "lodash", "zod"])
  })

  test("dependencies both branches added at the same place stay sorted", async () => {
    // Appending theirs after ours at that place would give express, eslint
    assert.deepEqual(
      await mergedKeys(
        keys("dotenv", "lodash"),
        keys("dotenv", "express", "lodash"),
        keys("dotenv", "eslint", "lodash")
      ),
      ["dotenv", "eslint", "express", "lodash"]
    )
    assert.deepEqual(await mergedKeys(keys("m"), keys("m", "z"), keys("a", "m", "y")), ["a", "m", "y", "z"])
  })

  test("scoped packages sort as npm sorts them", async () => {
    assert.deepEqual(
      await mergedKeys(
        keys("@types/node", "typescript"),
        keys("@types/node", "prettier", "typescript"),
        keys("@types/node", "@types/semver", "typescript")
      ),
      ["@types/node", "@types/semver", "prettier", "typescript"]
    )
  })

  test("lockfile entries stay in npm's order", async () => {
    const entry = (name: string, version: string) => ({
      version,
      resolved: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
      integrity: `sha512-${name}-${version}`,
    })
    const lockfile = (versions: Record<string, string>) =>
      j({
        name: "app",
        lockfileVersion: 3,
        packages: {
          "": {name: "app"},
          ...Object.fromEntries(
            Object.entries(versions).map(([name, version]) => [`node_modules/${name}`, entry(name, version)])
          ),
        },
      })
    const result = await resolver().mergeJsonContents(
      lockfile({lodash: "4.17.20", zod: "3.0.0"}),
      lockfile({lodash: "4.17.21", semver: "7.6.0", zod: "3.0.0"}),
      lockfile({express: "4.18.0", lodash: "4.17.20", ms: "2.1.3", zod: "3.0.0"})
    )
    assert.deepEqual(Object.keys(result.packageJson!.packages), [
      "",
      "node_modules/express",
      "node_modules/lodash",
      "node_modules/ms",
      "node_modules/semver",
      "node_modules/zod",
    ])
  })

  test("keys sorted by character code, which is not npm's order, stay sorted that way", async () => {
    // "Z" comes before "a" by character code, and after it in npm's order
    assert.deepEqual(await mergedKeys(keys("Z", "a"), keys("Z", "a", "c"), keys("Z", "a", "b")), ["Z", "a", "b", "c"])
  })

  test("in an object that is not sorted, a key follows the key it comes after in their order", async () => {
    assert.deepEqual(
      await mergedKeys(
        keys("build", "test", "lint"),
        keys("build", "test", "lint"),
        keys("build", "test", "start", "lint")
      ),
      ["build", "test", "start", "lint"]
    )
    // ...after the keys only we have at that place
    assert.deepEqual(
      await mergedKeys(
        keys("build", "test", "lint"),
        keys("build", "test", "format", "lint"),
        keys("build", "test", "start", "lint")
      ),
      ["build", "test", "format", "start", "lint"]
    )
  })

  test("a key they put first comes first, and one they put last comes last", async () => {
    assert.deepEqual(
      await mergedKeys(keys("name", "main"), keys("name", "main", "bin"), keys("private", "name", "main", "types")),
      ["private", "name", "main", "bin", "types"]
    )
  })

  test("the fields of a package.json keep our order", async () => {
    const result = await resolver().mergeJsonContents(
      j({name: "app", version: "1.0.0", scripts: {}, dependencies: {}}),
      j({name: "app", version: "1.1.0", scripts: {}, dependencies: {}, engines: {node: ">=20"}}),
      j({name: "app", version: "1.2.0", description: "An app", scripts: {}, license: "MIT", dependencies: {}})
    )
    assert.deepEqual(Object.keys(result.packageJson!), [
      "name",
      "version",
      "description",
      "scripts",
      "license",
      "dependencies",
      "engines",
    ])
  })

  test("keys they moved keep our order, and every key is there once", async () => {
    assert.deepEqual(
      await mergedKeys(keys("a", "b", "c"), keys("b", "a", "c", "ours"), keys("c", "theirs", "a", "b")),
      ["b", "a", "c", "ours", "theirs"]
    )
  })

  test("a key we removed that their change keeps is placed like one they added", async () => {
    // With "theirs", the script they changed and we removed is kept
    const result = await resolver("theirs").mergeJsonContents(
      j({scripts: {build: "tsc", lint: "eslint .", test: "jest"}}),
      j({scripts: {build: "tsc", test: "jest"}}),
      j({scripts: {build: "tsc", lint: "eslint --fix .", test: "jest"}})
    )
    assert.deepEqual(Object.keys(result.packageJson!.scripts!), ["build", "lint", "test"])
  })

  test("a key only the common ancestor has is gone", async () => {
    assert.deepEqual(await mergedKeys(keys("a", "gone", "z"), keys("a", "z"), keys("a", "b", "z")), ["a", "b", "z"])
  })

  test("without their keys or without ours, the other branch's order is the result", async () => {
    assert.deepEqual(await mergedKeys(undefined, keys("b", "a"), keys("a")), ["b", "a"])
    assert.deepEqual(await mergedKeys(undefined, {}, keys("b", "a")), ["b", "a"])
  })

  test("large objects merge in linear time, sorted or not", async () => {
    const names = Array.from({length: 30000}, (_, index) => `pkg-${String(index).padStart(5, "0")}`)
    const ours = names.filter((_, index) => index % 3 !== 0)
    const theirs = names.filter((_, index) => index % 3 !== 1)

    for (const order of ["sorted", "reversed"] as const) {
      const [ourKeys, theirKeys] = order === "sorted" ? [ours, theirs] : [[...ours].reverse(), [...theirs].reverse()]
      const started = performance.now()
      const merged = await mergedKeys(undefined, keys(...ourKeys), keys(...theirKeys))
      const elapsed = performance.now() - started

      assert.deepEqual(merged, order === "sorted" ? names : [...names].reverse(), order)
      assert(elapsed < 3000, `${order}: ${names.length} keys took ${Math.round(elapsed)} ms`)
    }
  })
})
