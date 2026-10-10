/**
 * Lists of plain values (keywords, files, os, cpu, workspaces...) that both
 * branches changed merge item by item, against the common ancestor: an item
 * either branch added is kept, and an item either branch removed stays
 * removed, instead of coming back from the other branch.
 */

import {strict as assert} from "assert"
import {test, describe} from "node:test"
import {PackageResolver} from "../package-resolver.js"
import {CliOptions} from "../types.js"
import {conflictedDocument} from "./cli-harness.js"

const STRATEGIES: CliOptions["strategy"][] = ["highest", "lowest", "ours", "theirs"]

const resolver = (strategy: CliOptions["strategy"] = "highest") =>
  new PackageResolver({strategy, dryRun: true, quiet: true, json: false, verbose: false, regenerateLock: false})

const j = (value: unknown) => JSON.stringify(value, null, 2)

/** Merge three versions of the "files" list (no base: a two-way merge) and return the merged list */
async function mergeFiles(
  base: unknown[] | undefined,
  ours: unknown[],
  theirs: unknown[],
  strategy: CliOptions["strategy"] = "highest"
): Promise<unknown[]> {
  const result = await resolver(strategy).mergeJsonContents(
    base === undefined ? "" : j({files: base}),
    j({files: ours}),
    j({files: theirs})
  )
  assert.equal(result.resolved, true, result.errors.join(", "))
  assert.deepEqual(result.unresolved, [], "a list of plain values is never left for the user")
  return result.packageJson!.files
}

describe("lists of plain values merge item by item", () => {
  test("an item one branch removed stays removed while the other branch adds one", async () => {
    // We stopped publishing lib/; they started publishing the README
    const merged = await mergeFiles(["dist", "lib", "types"], ["dist", "types"], ["dist", "lib", "types", "README.md"])
    assert.deepEqual(merged, ["dist", "types", "README.md"])
  })

  test("removals on both branches are all honored, and additions on both are all kept", async () => {
    const merged = await mergeFiles(["a", "b", "c", "d"], ["a", "c", "d", "ours"], ["a", "b", "d", "theirs"])
    assert.deepEqual(merged, ["a", "d", "ours", "theirs"])
  })

  test("an item both branches added is kept once", async () => {
    const merged = await mergeFiles(["a"], ["a", "shared", "x"], ["a", "shared", "y"])
    assert.deepEqual(merged, ["a", "shared", "x", "y"])
  })

  test("their additions follow the item they come after, after ours at the same place", async () => {
    // Order matters here: "prettier" must stay last for its overrides to apply
    const base = ["eslint:recommended", "prettier"]
    const ours = ["eslint:recommended", "plugin:react/recommended", "prettier"]
    const theirs = ["eslint:recommended", "plugin:import/recommended", "prettier"]

    const result = await resolver().mergeJsonContents(
      j({eslintConfig: {extends: base}}),
      j({eslintConfig: {extends: ours}}),
      j({eslintConfig: {extends: theirs}})
    )
    assert.deepEqual(result.packageJson!.eslintConfig.extends, [
      "eslint:recommended",
      "plugin:react/recommended",
      "plugin:import/recommended",
      "prettier",
    ])
  })

  test("an item they added before everything else goes first", async () => {
    assert.deepEqual(await mergeFiles(["b"], ["b", "c"], ["a", "b"]), ["a", "b", "c"])
    assert.deepEqual(await mergeFiles(["b"], ["o", "b"], ["t", "b"]), ["o", "t", "b"], "ours first at the same place")
  })

  test("an item they added after an item we removed follows what precedes it", async () => {
    assert.deepEqual(await mergeFiles(["a", "b", "c"], ["a", "c"], ["a", "b", "x", "c"]), ["a", "x", "c"])
  })

  test("our order is kept when we reordered the list, and their additions still land after their neighbors", async () => {
    assert.deepEqual(await mergeFiles(["a", "b"], ["b", "a"], ["a", "b", "c"]), ["b", "a", "c"])
  })

  test("without a common ancestor, nothing can be told removed: both lists are combined", async () => {
    assert.deepEqual(await mergeFiles(undefined, ["dist", "types"], ["dist", "lib", "README.md"]), [
      "dist",
      "types",
      "lib",
      "README.md",
    ])
  })

  test("an ancestor that was not a list counts as an empty one", async () => {
    const result = await resolver().mergeJsonContents(j({files: "dist"}), j({files: ["a", "b"]}), j({files: ["c"]}))
    assert.deepEqual(result.packageJson!.files, ["a", "b", "c"])
  })

  test("every strategy merges a list the same way: there is no conflict to decide", async () => {
    for (const strategy of STRATEGIES) {
      assert.deepEqual(
        await mergeFiles(["dist", "lib"], ["dist"], ["dist", "lib", "README.md"], strategy),
        ["dist", "README.md"],
        strategy
      )
    }
  })

  test("numbers, booleans and null merge the same way", async () => {
    assert.deepEqual(await mergeFiles([1, true, null], [1, null, 2], [1, true, null, false]), [1, null, 2, false])
  })

  test("the merge is recorded as a resolved conflict on the list", async () => {
    const result = await resolver().mergeJsonContents(
      j({keywords: ["cli", "git"]}),
      j({keywords: ["cli"]}),
      j({keywords: ["cli", "git", "merge"]})
    )
    assert.deepEqual(
      result.conflicts.map(conflict => [conflict.field, conflict.resolvedValue]),
      [["keywords", '["cli","merge"]']]
    )
  })

  test("a list only one branch changed is taken from it, removals included", async () => {
    const result = await resolver().mergeJsonContents(
      j({os: ["darwin", "linux"]}),
      j({os: ["linux"]}),
      j({os: ["darwin", "linux"]})
    )
    assert.deepEqual(result.packageJson!.os, ["linux"])
    assert.deepEqual(result.conflicts, [])
  })

  test("lists of objects have no identity to merge items by: they are decided as a whole", async () => {
    const base = {contributors: [{name: "Ann"}]}
    const ours = {contributors: [{name: "Ann", email: "ann@example.com"}]}
    const theirs = {contributors: [{name: "Ann"}, {name: "Bob"}]}

    const highest = await resolver().mergeJsonContents(j(base), j(ours), j(theirs))
    assert.deepEqual(
      highest.unresolved?.map(conflict => [conflict.field, conflict.reason]),
      [["contributors", "not-a-version"]]
    )
    const withTheirs = await resolver("theirs").mergeJsonContents(j(base), j(ours), j(theirs))
    assert.deepEqual(withTheirs.packageJson!.contributors, theirs.contributors)
  })

  test("diff3 conflict markers carry the ancestor, so a removed item stays removed", async () => {
    const base = {name: "app", files: ["dist", "lib"]}
    const ours = {name: "app", files: ["dist"]}
    const theirs = {name: "app", files: ["dist", "lib", "README.md"]}

    const result = await resolver().resolveConflicts(conflictedDocument(ours, theirs, base))
    assert.equal(result.resolved, true, result.errors.join(", "))
    assert.deepEqual(result.packageJson!.files, ["dist", "README.md"])
  })

  test("in a lockfile, lists merge the same way", async () => {
    const lock = (workspaces: string[]) => ({
      name: "app",
      lockfileVersion: 3,
      packages: {"": {name: "app", workspaces}},
    })
    const result = await resolver().mergeJsonContents(
      j(lock(["packages/a", "packages/b"])),
      j(lock(["packages/a"])),
      j(lock(["packages/a", "packages/b", "packages/c"]))
    )
    assert.deepEqual(result.packageJson!.packages[""].workspaces, ["packages/a", "packages/c"])
  })
})

/** Deterministic PRNG so any failure is reproducible from its seed */
function makeRandom(seed: number): () => number {
  let state = (seed * 2654435761) >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x100000000
  }
}

const ITEMS = ["a", "b", "c", "d", "e", "f", 1, 2, true, null]

/** Some of the items, in a random order, without duplicates */
function randomList(random: () => number): unknown[] {
  const list: unknown[] = ITEMS.filter(() => random() < 0.5)
  for (let index = list.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1))
    const item = list[index]
    list[index] = list[other]
    list[other] = item
  }
  return list
}

describe("list merges, property-based", () => {
  test("an item is kept when both branches have it or one branch added it, and only then", async () => {
    for (let seed = 1; seed <= 200; seed++) {
      const random = makeRandom(seed)
      const [base, ours, theirs] = [randomList(random), randomList(random), randomList(random)]
      const merged = await mergeFiles(base, ours, theirs)

      for (const item of ITEMS) {
        const [inBase, inOurs, inTheirs] = [base, ours, theirs].map(list => list.includes(item))
        const expected = (inOurs && inTheirs) || (inOurs && !inBase) || (inTheirs && !inBase)
        assert.equal(
          merged.includes(item),
          expected,
          `seed ${seed}: ${JSON.stringify(item)} in base ${inBase}, ours ${inOurs}, theirs ${inTheirs}; merged ${JSON.stringify(merged)}`
        )
      }
      assert.equal(new Set(merged).size, merged.length, `seed ${seed}: no item twice`)

      // What remains of our list keeps our order
      const ourOrder = ours.filter(item => merged.includes(item))
      assert.deepEqual(
        merged.filter(item => ourOrder.includes(item)),
        ourOrder,
        `seed ${seed}: our order`
      )
    }
  })

  test("swapping the branches merges the same items", async () => {
    for (let seed = 1; seed <= 100; seed++) {
      const random = makeRandom(seed + 1000)
      const [base, ours, theirs] = [randomList(random), randomList(random), randomList(random)]
      const merged = await mergeFiles(base, ours, theirs)
      const swapped = await mergeFiles(base, theirs, ours)
      assert.deepEqual(new Set(swapped), new Set(merged), `seed ${seed}`)
    }
  })

  test("merging their branch into the result again changes nothing", async () => {
    for (let seed = 1; seed <= 100; seed++) {
      const random = makeRandom(seed + 2000)
      const [base, ours, theirs] = [randomList(random), randomList(random), randomList(random)]
      const merged = await mergeFiles(base, ours, theirs)
      assert.deepEqual(new Set(await mergeFiles(base, merged, theirs)), new Set(merged), `seed ${seed}`)
    }
  })
})
