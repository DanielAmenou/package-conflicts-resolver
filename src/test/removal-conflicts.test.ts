/**
 * A value one branch removed while the other changed it.
 *
 * - A dependency stays removed, with highest and lowest: changing its version
 *   says which version to use, not that the package is still needed. The
 *   merge goes on, and the dropped change is reported. A lockfile follows: its
 *   root and workspace specs drop the dependency, while the installed entry
 *   stays until npm regenerates the lockfile and prunes it.
 * - Any other value (a script, a config block...) is left for the user,
 *   between conflict markers: there is no telling whether it should still
 *   exist.
 * - Ours and theirs, or a version picked for the package, decide either.
 */

import {strict as assert} from "assert"
import {test, describe} from "node:test"
import {readFile, writeFile} from "fs/promises"
import {join} from "node:path"
import {ConflictParser} from "../conflict-parser.js"
import {PackageResolver} from "../package-resolver.js"
import {CliOptions, PackageJson, UnresolvedConflict} from "../types.js"
import {CLI_PATH, conflictedDocument, jsonLines, run, runCli, withTempDir} from "./cli-harness.js"

const resolver = (strategy: CliOptions["strategy"] = "highest", overrides: Partial<CliOptions> = {}) =>
  new PackageResolver({
    strategy,
    dryRun: false,
    quiet: true,
    json: false,
    verbose: false,
    regenerateLock: false,
    ...overrides,
  })

const j = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`

const BASE = {
  name: "app",
  scripts: {build: "tsc", lint: "eslint ."},
  dependencies: {lodash: "^4.17.20", react: "^18.2.0", zod: "^3.22.0"},
}
// We removed the lint script and lodash, and upgraded react and zod
const OURS = {
  name: "app",
  scripts: {build: "tsc"},
  dependencies: {react: "^18.3.0", zod: "^3.23.0"},
}
// They changed the lint script, upgraded lodash and react, and removed zod
const THEIRS = {
  name: "app",
  scripts: {build: "tsc", lint: "eslint --fix ."},
  dependencies: {lodash: "^4.17.21", react: "^18.3.1"},
}

/** What a run with highest leaves in package.json for the merge above: only the script is left open */
const WRITTEN = [
  "{",
  '  "name": "app",',
  '  "scripts": {',
  "<<<<<<< ours",
  "||||||| base",
  '    "lint": "eslint .",',
  "=======",
  '    "lint": "eslint --fix .",',
  ">>>>>>> theirs",
  '    "build": "tsc"',
  "  },",
  '  "dependencies": {',
  '    "react": "^18.3.1"',
  "  }",
  "}",
  "",
].join("\n")

/** Merge, then write the result the way the CLI does, and return the file's text */
async function mergeAndWrite(base: unknown, ours: unknown, theirs: unknown): Promise<string> {
  const merger = resolver()
  const result = await merger.mergeJsonContents(j(base), j(ours), j(theirs))
  assert.equal(result.resolved, true, result.errors.join(", "))
  return write(merger, result.packageJson!, j(ours), result.unresolved ?? [])
}

function write(
  merger: PackageResolver,
  document: PackageJson,
  original: string,
  unresolved: UnresolvedConflict[]
): Promise<string> {
  return withTempDir(async dir => {
    const file = join(dir, "package.json")
    await merger.writeResolvedPackage(document, file, original, unresolved)
    return readFile(file, "utf8")
  })
}

describe("a dependency one branch removed and the other changed", () => {
  for (const strategy of ["highest", "lowest"] as const) {
    test(`${strategy} keeps it removed, whichever branch removed it`, async () => {
      const result = await resolver(strategy).mergeJsonContents(j(BASE), j(OURS), j(THEIRS))
      assert.equal(result.resolved, true, result.errors.join(", "))

      const react = strategy === "highest" ? "^18.3.1" : "^18.3.0"
      assert.deepEqual(result.packageJson, {name: "app", scripts: {build: "tsc"}, dependencies: {react}})
      assert.deepEqual(
        result.conflicts.map(conflict => [conflict.field, conflict.resolvedValue, conflict.strategy]),
        [
          ["dependencies.react", react, strategy],
          ["dependencies.zod", "<deleted>", "removal"],
          ["dependencies.lodash", "<deleted>", "removal"],
        ]
      )
      // The removed script is no dependency: it is left for the user
      assert.deepEqual(
        result.unresolved?.map(conflict => [conflict.field, conflict.reason]),
        [["scripts.lint", "removed"]]
      )
    })
  }

  test("the package conflicts say which branch removed it, and the change that was dropped", async () => {
    const result = await resolver().mergeJsonContents(j(BASE), j(OURS), j(THEIRS))
    assert.deepEqual(result.packageConflicts, [
      {
        name: "react",
        kind: "spec",
        location: "dependencies",
        path: ["dependencies", "react"],
        ours: "^18.3.0",
        theirs: "^18.3.1",
        base: "^18.2.0",
        resolved: "^18.3.1",
        resolvedBy: "highest",
      },
      {
        name: "zod",
        kind: "spec",
        location: "dependencies",
        path: ["dependencies", "zod"],
        ours: "^3.23.0",
        theirs: null,
        base: "^3.22.0",
        resolved: null,
        resolvedBy: "removal",
      },
      {
        name: "lodash",
        kind: "spec",
        location: "dependencies",
        path: ["dependencies", "lodash"],
        ours: null,
        theirs: "^4.17.21",
        base: "^4.17.20",
        resolved: null,
        resolvedBy: "removal",
      },
    ])
  })

  test("every dependency field follows the rule", async () => {
    const result = await resolver().mergeJsonContents(
      j({devDependencies: {a: "^1.0.0"}, peerDependencies: {b: "^1.0.0"}, optionalDependencies: {c: "^1.0.0"}}),
      j({devDependencies: {}, peerDependencies: {b: "^2.0.0"}, optionalDependencies: {}}),
      j({devDependencies: {a: "^1.1.0"}, peerDependencies: {}, optionalDependencies: {c: "file:../c"}})
    )
    assert.deepEqual(result.packageJson, {devDependencies: {}, peerDependencies: {}, optionalDependencies: {}})
    assert.deepEqual(result.unresolved, [])
  })

  test("a dependency moved to another field keeps the version it was moved with", async () => {
    // We promoted typescript to a runtime dependency; they upgraded the dev dependency
    const result = await resolver().mergeJsonContents(
      j({dependencies: {}, devDependencies: {typescript: "~5.4.5"}}),
      j({dependencies: {typescript: "~5.4.5"}, devDependencies: {}}),
      j({dependencies: {}, devDependencies: {typescript: "~5.6.2"}})
    )
    assert.deepEqual(result.packageJson, {dependencies: {typescript: "~5.4.5"}, devDependencies: {}})
    assert.deepEqual(
      result.packageConflicts?.map(conflict => [conflict.location, conflict.theirs, conflict.resolvedBy]),
      [["devDependencies", "~5.6.2", "removal"]]
    )
  })

  test("ours and theirs take their side, the removal included", async () => {
    const withOurs = await resolver("ours").mergeJsonContents(j(BASE), j(OURS), j(THEIRS))
    assert.deepEqual(withOurs.unresolved, [])
    assert.deepEqual(withOurs.packageJson, {
      name: "app",
      scripts: {build: "tsc"},
      dependencies: {react: "^18.3.0", zod: "^3.23.0"},
    })
    assert.deepEqual(
      withOurs.conflicts.map(conflict => [
        conflict.field,
        conflict.ourValue,
        conflict.theirValue,
        conflict.resolvedValue,
      ]),
      [
        ["scripts.lint", "<deleted>", "eslint --fix .", "<deleted>"],
        ["dependencies.react", "^18.3.0", "^18.3.1", "^18.3.0"],
        ["dependencies.zod", "^3.23.0", "<deleted>", "^3.23.0"],
        ["dependencies.lodash", "<deleted>", "^4.17.21", "<deleted>"],
      ]
    )
    const zod = withOurs.packageConflicts?.find(conflict => conflict.name === "zod")
    assert.deepEqual([zod?.ours, zod?.theirs, zod?.resolved, zod?.resolvedBy], ["^3.23.0", null, "^3.23.0", "ours"])

    const withTheirs = await resolver("theirs").mergeJsonContents(j(BASE), j(OURS), j(THEIRS))
    assert.deepEqual(withTheirs.unresolved, [])
    assert.deepEqual(withTheirs.packageJson, {
      name: "app",
      scripts: {build: "tsc", lint: "eslint --fix ."},
      dependencies: {react: "^18.3.1", lodash: "^4.17.21"},
    })
  })

  test("a picked version keeps the dependency, at the picked version", async () => {
    const result = await resolver("highest", {picks: {lodash: "^4.17.21", zod: "3.23.8"}}).mergeJsonContents(
      j(BASE),
      j(OURS),
      j(THEIRS)
    )
    assert.deepEqual(result.packageJson!.dependencies, {react: "^18.3.1", zod: "3.23.8", lodash: "^4.17.21"})
    assert.deepEqual(
      result.packageConflicts?.filter(conflict => conflict.resolvedBy === "pick").map(conflict => conflict.name),
      ["zod", "lodash"]
    )
  })

  test("a removal both branches made, or one the other branch left alone, is no conflict", async () => {
    const result = await resolver().mergeJsonContents(
      j({dependencies: {a: "^1.0.0", b: "^1.0.0", c: "^1.0.0"}}),
      j({dependencies: {c: "^1.0.0"}}),
      j({dependencies: {b: "^1.0.0", c: "^1.0.0"}})
    )
    assert.deepEqual(result.packageJson, {dependencies: {c: "^1.0.0"}})
    assert.deepEqual(result.unresolved, [])
    assert.deepEqual(result.conflicts, [])
    assert.deepEqual(result.packageConflicts, [])
  })

  test("diff3 conflict markers carry the ancestor, so the removals are seen there too", async () => {
    const result = await resolver().resolveConflicts(conflictedDocument(OURS, THEIRS, BASE))
    assert.equal(result.resolved, true, result.errors.join(", "))
    assert.deepEqual(result.packageJson!.dependencies, {react: "^18.3.1"})
    assert.deepEqual(
      result.packageConflicts?.map(conflict => [conflict.name, conflict.resolvedBy]),
      [
        ["react", "highest"],
        ["zod", "removal"],
        ["lodash", "removal"],
      ]
    )
  })

  test("without the ancestor, a missing dependency cannot be told from an added one, so both are kept", async () => {
    const result = await resolver().resolveConflicts(conflictedDocument(OURS, THEIRS))
    assert.equal(result.resolved, true, result.errors.join(", "))
    assert.deepEqual(result.packageJson!.dependencies, {react: "^18.3.1", zod: "^3.23.0", lodash: "^4.17.21"})
  })
})

describe("any other value one branch removed and the other changed", () => {
  test("highest and lowest leave it for the user, with nothing in its place when we removed it", async () => {
    for (const strategy of ["highest", "lowest"] as const) {
      const result = await resolver(strategy).mergeJsonContents(j(BASE), j(OURS), j(THEIRS))
      assert.deepEqual(result.unresolved, [
        {
          field: "scripts.lint",
          path: ["scripts", "lint"],
          reason: "removed",
          ours: undefined,
          theirs: "eslint --fix .",
          base: "eslint .",
        },
      ])
      assert.deepEqual(result.packageJson!.scripts, {build: "tsc"})
    }
  })

  test("a whole object is left whole", async () => {
    const result = await resolver().mergeJsonContents(
      j({name: "app", jest: {testEnvironment: "node", verbose: true}}),
      j({name: "app"}),
      j({name: "app", jest: {testEnvironment: "jsdom", verbose: true}})
    )
    assert.deepEqual(result.unresolved, [
      {
        field: "jest",
        path: ["jest"],
        reason: "removed",
        ours: undefined,
        theirs: {testEnvironment: "jsdom", verbose: true},
        base: {testEnvironment: "node", verbose: true},
      },
    ])
    assert.deepEqual(result.packageJson, {name: "app"})
  })

  test("so is a whole dependency field: the other branch may have added dependencies to it", async () => {
    const result = await resolver().mergeJsonContents(
      j({name: "app", devDependencies: {a: "^1.0.0"}}),
      j({name: "app"}),
      j({name: "app", devDependencies: {a: "^1.0.0", b: "^1.0.0"}})
    )
    assert.deepEqual(
      result.unresolved?.map(conflict => [conflict.field, conflict.reason]),
      [["devDependencies", "removed"]]
    )
  })
})

describe("removals in a lockfile", () => {
  const entry = (name: string, version: string) => ({
    version,
    resolved: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
    integrity: `sha512-${name}-${version}`,
  })
  const lock = (dependencies: Record<string, string>, packages: Record<string, unknown>) => ({
    name: "app",
    lockfileVersion: 3,
    requires: true,
    packages: {"": {name: "app", dependencies}, ...packages},
  })
  const base = lock({lodash: "^4.17.20"}, {"node_modules/lodash": entry("lodash", "4.17.20")})
  const ours = lock({}, {}) // lodash uninstalled
  const theirs = lock({lodash: "^4.17.21"}, {"node_modules/lodash": entry("lodash", "4.17.21")})

  test("highest drops the dependency from the root entry, and keeps the installed entry for npm to prune", async () => {
    const result = await resolver().mergeJsonContents(j(base), j(ours), j(theirs))
    assert.equal(result.resolved, true, result.errors.join(", "))
    assert.deepEqual(result.unresolved, [], "a lockfile leaves nothing for the user")
    // Another package may still need the installed entry: it stays, harmless if nothing does
    assert.deepEqual(result.packageJson, lock({}, {"node_modules/lodash": entry("lodash", "4.17.21")}))
    assert.deepEqual(result.lockfileIssues, [])
    assert.deepEqual(result.packageConflicts, [
      {
        name: "lodash",
        kind: "spec",
        location: "root › dependencies",
        path: ["packages", "", "dependencies", "lodash"],
        ours: null,
        theirs: "^4.17.21",
        base: "^4.17.20",
        resolved: null,
        resolvedBy: "removal",
      },
      {
        name: "lodash",
        kind: "lock",
        location: "node_modules/lodash",
        path: ["packages", "node_modules/lodash"],
        ours: null,
        theirs: "4.17.21",
        base: "4.17.20",
        resolved: "4.17.21",
        resolvedBy: "theirs",
      },
    ])
  })

  test("ours and theirs follow their side", async () => {
    const withOurs = await resolver("ours").mergeJsonContents(j(base), j(ours), j(theirs))
    assert.deepEqual(withOurs.packageJson, ours)
    assert.deepEqual(
      withOurs.packageConflicts?.map(conflict => [conflict.kind, conflict.resolved, conflict.resolvedBy]),
      [
        ["spec", null, "ours"],
        ["lock", null, "ours"],
      ]
    )

    const withTheirs = await resolver("theirs").mergeJsonContents(j(base), j(ours), j(theirs))
    assert.deepEqual(withTheirs.packageJson, theirs)
  })

  test("a pick keeps the changed entry when it is the picked version", async () => {
    const picked = await resolver("ours", {picks: {lodash: "4.17.21"}}).mergeJsonContents(j(base), j(ours), j(theirs))
    assert.deepEqual(picked.packageJson!.packages["node_modules/lodash"], entry("lodash", "4.17.21"))
    assert.equal(picked.packageJson!.packages[""].dependencies.lodash, "4.17.21")
    assert.deepEqual(
      picked.packageConflicts?.map(conflict => conflict.resolvedBy),
      ["pick", "pick"]
    )

    // A third version: the spec gets it, the entry is left to the strategy
    const third = await resolver("ours", {picks: {lodash: "4.17.22"}}).mergeJsonContents(j(base), j(ours), j(theirs))
    assert.equal(third.packageJson!.packages["node_modules/lodash"], undefined)
    const locked = third.packageConflicts?.find(conflict => conflict.kind === "lock")
    assert.deepEqual([locked?.resolvedBy, locked?.pick], ["ours", "4.17.22"])
  })
})

describe("writing a value one branch removed", () => {
  test("the removing side has no line, the ancestor shows, and the property comes first in its object", async () => {
    assert.equal(await mergeAndWrite(BASE, OURS, THEIRS), WRITTEN)
  })

  test("keeping either side as it is gives valid JSON", () => {
    assert.deepEqual(JSON.parse(ConflictParser.extractConflictSide(WRITTEN, "ours")), {
      name: "app",
      scripts: {build: "tsc"},
      dependencies: {react: "^18.3.1"},
    })
    assert.deepEqual(JSON.parse(ConflictParser.extractConflictSide(WRITTEN, "theirs")), {
      name: "app",
      scripts: {lint: "eslint --fix .", build: "tsc"},
      dependencies: {react: "^18.3.1"},
    })
  })

  test("several removals in one object keep their order at the front", async () => {
    const written = await mergeAndWrite(
      {scripts: {build: "tsc", lint: "eslint .", test: "jest"}},
      {scripts: {build: "tsc", test: "vitest"}},
      {scripts: {build: "tsc -b", lint: "eslint --fix ."}}
    )
    assert.equal(
      written,
      [
        "{",
        '  "scripts": {',
        "<<<<<<< ours",
        '    "test": "vitest",',
        "||||||| base",
        '    "test": "jest",',
        "=======",
        ">>>>>>> theirs",
        "<<<<<<< ours",
        "||||||| base",
        '    "lint": "eslint .",',
        "=======",
        '    "lint": "eslint --fix .",',
        ">>>>>>> theirs",
        '    "build": "tsc -b"',
        "  }",
        "}",
        "",
      ].join("\n")
    )
    assert.deepEqual(JSON.parse(ConflictParser.extractConflictSide(written, "ours")).scripts, {
      test: "vitest",
      build: "tsc -b",
    })
    assert.deepEqual(JSON.parse(ConflictParser.extractConflictSide(written, "theirs")).scripts, {
      lint: "eslint --fix .",
      build: "tsc -b",
    })
  })

  test("a removal in an object that has nothing else", async () => {
    const written = await mergeAndWrite(
      {name: "app", scripts: {lint: "eslint ."}},
      {name: "app", scripts: {}},
      {name: "app", scripts: {lint: "eslint --fix ."}}
    )
    assert.equal(
      written,
      [
        "{",
        '  "name": "app",',
        '  "scripts": {',
        "<<<<<<< ours",
        "||||||| base",
        '    "lint": "eslint ."',
        "=======",
        '    "lint": "eslint --fix ."',
        ">>>>>>> theirs",
        "  }",
        "}",
        "",
      ].join("\n")
    )
    assert.deepEqual(JSON.parse(ConflictParser.extractConflictSide(written, "ours")).scripts, {})
  })

  test("a value over several lines that one branch removed", async () => {
    const written = await mergeAndWrite(
      {name: "app", jest: {verbose: true}},
      {name: "app", jest: {verbose: false}},
      {name: "app"}
    )
    assert.equal(
      written,
      [
        "{",
        "<<<<<<< ours",
        '  "jest": {',
        '    "verbose": false',
        "  },",
        "||||||| base",
        '  "jest": {',
        '    "verbose": true',
        "  },",
        "=======",
        ">>>>>>> theirs",
        '  "name": "app"',
        "}",
        "",
      ].join("\n")
    )
  })

  test("once one conflict shows the ancestor, all do: a later run reads them all the same way", async () => {
    // The description was added on both branches, so its ancestor section is empty
    const written = await mergeAndWrite(
      {name: "app", scripts: {lint: "eslint ."}},
      {name: "app", description: "ours", scripts: {}},
      {name: "app", description: "theirs", scripts: {lint: "eslint --fix ."}}
    )
    assert(
      written.includes(
        ["<<<<<<< ours", '  "description": "ours",', "||||||| base", "=======", '  "description": "theirs",'].join("\n")
      ),
      written
    )

    const withOurs = await resolver("ours").resolveConflicts(written)
    assert.deepEqual(withOurs.packageJson, {name: "app", description: "ours", scripts: {}})
    const withTheirs = await resolver("theirs").resolveConflicts(written)
    assert.deepEqual(withTheirs.packageJson, {name: "app", description: "theirs", scripts: {lint: "eslint --fix ."}})
  })

  test("ours or theirs finish the file, and highest leaves the same file again", async () => {
    const withOurs = await resolver("ours").resolveConflicts(WRITTEN)
    assert.deepEqual(withOurs.unresolved, [])
    assert.deepEqual(withOurs.packageJson, {name: "app", scripts: {build: "tsc"}, dependencies: {react: "^18.3.1"}})

    const withTheirs = await resolver("theirs").resolveConflicts(WRITTEN)
    assert.deepEqual(withTheirs.packageJson, {
      name: "app",
      scripts: {build: "tsc", lint: "eslint --fix ."},
      dependencies: {react: "^18.3.1"},
    })

    const again = resolver()
    const result = await again.resolveConflicts(WRITTEN)
    assert.deepEqual(
      result.unresolved?.map(conflict => conflict.field),
      ["scripts.lint"]
    )
    assert.equal(await write(again, result.packageJson!, WRITTEN, result.unresolved ?? []), WRITTEN)
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

const pickOne = <T>(random: () => number, values: readonly T[]): T => values[Math.floor(random() * values.length)] as T

/** Leaf values by the object they are in: scripts, versions (comparable or not), text and numbers */
const LEAVES: Record<string, readonly unknown[]> = {
  scripts: ["tsc", "tsc -b", "vite build", "jest", "vitest"],
  dependencies: ["^1.0.0", "^2.0.0", "~1.5.0", "github:u/x#main", "file:../x"],
  config: [1, 2, "a", "b", true],
  "": ["one", "two", "three"],
}
const KEYS: Record<string, readonly string[]> = {
  scripts: ["build", "test", "lint", "start"],
  dependencies: ["a", "b", "c", "d"],
  config: ["port", "host"],
  "": ["description", "license"],
}

function randomObject(random: () => number, kind: string): Record<string, unknown> {
  const object: Record<string, unknown> = {}
  for (const key of KEYS[kind] as readonly string[]) {
    if (random() < 0.6) {
      object[key] = pickOne(random, LEAVES[kind] as readonly unknown[])
    }
  }
  return object
}

function randomBase(random: () => number): Record<string, any> {
  const document: Record<string, any> = {name: "app", ...randomObject(random, "")}
  for (const kind of ["scripts", "dependencies", "config"]) {
    if (random() < 0.85) document[kind] = randomObject(random, kind)
  }
  return document
}

/** A branch of the base: each value kept, changed or removed, and some values added */
function randomBranch(random: () => number, base: Record<string, any>): Record<string, any> {
  const mutate = (object: Record<string, any>, kind: string): Record<string, any> => {
    const result: Record<string, any> = {}
    for (const key of new Set([...Object.keys(object), ...(KEYS[kind] ?? [])])) {
      const value = object[key]
      const roll = random()
      if (value !== null && typeof value === "object") {
        if (roll < 0.15) continue // the whole object removed
        result[key] = roll < 0.25 ? randomObject(random, key) : mutate(value, key)
      } else if (value === undefined) {
        if (roll < 0.2) result[key] = pickOne(random, LEAVES[kind] as readonly unknown[])
      } else if (key !== "name") {
        if (roll < 0.25) continue
        result[key] = roll < 0.5 ? pickOne(random, LEAVES[kind] as readonly unknown[]) : value
      } else {
        result[key] = value
      }
    }
    return result
  }
  return mutate(base, "")
}

const byField = (conflicts: UnresolvedConflict[]) =>
  [...conflicts].sort((a, b) => (a.field < b.field ? -1 : a.field > b.field ? 1 : 0))

/** The document with each unresolved value replaced by one side's, or removed where that side has none */
function withSide(
  document: PackageJson,
  unresolved: UnresolvedConflict[],
  side: "ours" | "theirs"
): Record<string, any> {
  const copy = structuredClone(document) as Record<string, any>
  for (const conflict of unresolved) {
    let parent = copy
    for (const key of conflict.path.slice(0, -1)) parent = parent[key]
    const key = conflict.path[conflict.path.length - 1] as string
    if (conflict[side] === undefined) delete parent[key]
    else parent[key] = conflict[side]
  }
  return copy
}

describe("removals, property-based", () => {
  test("either side of the written file is valid JSON, a later run decides it the same way, and highest rewrites it unchanged", async () => {
    let removals = 0
    let leftOpen = 0

    for (let seed = 1; seed <= 150; seed++) {
      const random = makeRandom(seed)
      const base = randomBase(random)
      const ours = randomBranch(random, base)
      const theirs = randomBranch(random, base)

      const merger = resolver()
      const result = await merger.mergeJsonContents(j(base), j(ours), j(theirs))
      assert.equal(result.resolved, true, `seed ${seed}: ${result.errors.join(", ")}`)
      const unresolved = result.unresolved ?? []
      removals += unresolved.filter(conflict => conflict.reason === "removed").length
      leftOpen += unresolved.length

      const written = await write(merger, result.packageJson!, j(ours), unresolved)
      const context = `seed ${seed}\n${written}`
      const oursDocument = withSide(result.packageJson!, unresolved, "ours")
      const theirsDocument = withSide(result.packageJson!, unresolved, "theirs")

      // A user keeping one side everywhere gets valid JSON
      assert.deepEqual(JSON.parse(ConflictParser.extractConflictSide(written, "ours")), oursDocument, context)
      assert.deepEqual(JSON.parse(ConflictParser.extractConflictSide(written, "theirs")), theirsDocument, context)

      if (unresolved.length > 0) {
        // A later run with ours or theirs decides each value for that side
        assert.deepEqual((await resolver("ours").resolveConflicts(written)).packageJson, oursDocument, context)
        assert.deepEqual((await resolver("theirs").resolveConflicts(written)).packageJson, theirsDocument, context)

        // ...and one with highest leaves exactly the same file
        const again = resolver()
        const rerun = await again.resolveConflicts(written)
        assert.deepEqual(byField(rerun.unresolved ?? []), byField(unresolved), context)
        assert.equal(await write(again, rerun.packageJson!, written, rerun.unresolved ?? []), written, context)
      }
    }

    assert(removals > 20, `expected removals among the values left open, got ${removals}`)
    assert(leftOpen > 100, `expected many values left open, got ${leftOpen}`)
  })

  test("a removed dependency stays removed and is reported; any other removed value is left open", async () => {
    let droppedDependencies = 0

    for (let seed = 1; seed <= 150; seed++) {
      const random = makeRandom(seed + 5000)
      const base = randomBase(random)
      const ours = randomBranch(random, base)
      const theirs = randomBranch(random, base)
      const result = await resolver().mergeJsonContents(j(base), j(ours), j(theirs))

      for (const kind of ["scripts", "dependencies", "config"]) {
        if (!base[kind] || !ours[kind] || !theirs[kind]) continue
        for (const key of Object.keys(base[kind])) {
          const [o, t, b] = [ours[kind][key], theirs[kind][key], base[kind][key]]
          const removedAndChanged =
            (o === undefined && t !== undefined && t !== b) || (t === undefined && o !== undefined && o !== b)
          if (!removedAndChanged) continue

          const where = `seed ${seed}: ${kind}.${key} (ours ${o}, theirs ${t}, base ${b})`
          if (kind === "dependencies") {
            droppedDependencies++
            assert.equal(result.packageJson!.dependencies?.[key], undefined, where)
            const reported = result.packageConflicts?.find(
              conflict => conflict.path.join(".") === `dependencies.${key}`
            )
            assert.deepEqual([reported?.resolved, reported?.resolvedBy], [null, "removal"], where)
          } else {
            const conflict = result.unresolved?.find(entry => entry.field === `${kind}.${key}`)
            assert.equal(conflict?.reason, "removed", where)
          }
        }
      }
    }

    assert(droppedDependencies > 20, `expected removed dependencies, got ${droppedDependencies}`)
  })
})

describe("the CLI with a dependency one branch removed", () => {
  const base = {name: "app", dependencies: {lodash: "^4.17.20", react: "^18.2.0"}}
  const ours = {name: "app", dependencies: {react: "^18.2.0"}}
  const theirs = {name: "app", dependencies: {lodash: "^4.17.21", react: "^18.2.0"}}

  /** Run the merge driver on three versions of the file, and return its result and the merged text */
  async function mergeDriver(ancestorValue: unknown, current: unknown, other: unknown) {
    return withTempDir(async dir => {
      const [currentFile, ancestorFile, otherFile] = ["current.json", "base.json", "other.json"].map(name =>
        join(dir, name)
      ) as [string, string, string]
      await writeFile(ancestorFile, j(ancestorValue), "utf8")
      await writeFile(currentFile, j(current), "utf8")
      await writeFile(otherFile, j(other), "utf8")
      const result = await runCli(["merge-driver", currentFile, ancestorFile, otherFile], dir)
      return {result, merged: await readFile(currentFile, "utf8")}
    })
  }

  test("the merge driver keeps it removed, says whose change it dropped, and finishes", async () => {
    const {result, merged} = await mergeDriver(base, ours, theirs)
    assert.equal(result.code, 0, result.stderr)
    assert.equal(
      result.stderr,
      "package-conflicts-resolver: dependencies.lodash: our branch removed it, their change to ^4.17.21 was dropped\n"
    )
    assert.equal(merged, j({name: "app", dependencies: {react: "^18.2.0"}}))

    const mirrored = await mergeDriver(base, theirs, ours)
    assert.equal(mirrored.result.code, 0, mirrored.result.stderr)
    assert.equal(
      mirrored.result.stderr,
      "package-conflicts-resolver: dependencies.lodash: their branch removed it, our change to ^4.17.21 was dropped\n"
    )
    assert.equal(mirrored.merged, j({name: "app", dependencies: {react: "^18.2.0"}}))
  })

  test("the merge driver says nothing about a lockfile, which follows package.json", async () => {
    const lock = (dependencies: Record<string, string>, packages: Record<string, unknown>) => ({
      name: "app",
      lockfileVersion: 3,
      requires: true,
      packages: {"": {name: "app", dependencies}, ...packages},
    })
    const entry = (version: string) => ({
      version,
      resolved: `https://r/lodash-${version}.tgz`,
      integrity: `sha512-${version}`,
    })
    const {result, merged} = await mergeDriver(
      lock({lodash: "^4.17.20"}, {"node_modules/lodash": entry("4.17.20")}),
      lock({}, {}),
      lock({lodash: "^4.17.21"}, {"node_modules/lodash": entry("4.17.21")})
    )
    assert.equal(result.code, 0, result.stderr)
    assert.equal(result.stderr, "")
    assert.deepEqual(JSON.parse(merged).packages[""].dependencies, {})
  })

  test("a run says which changes it dropped, also with --quiet, and --json gives them as data", async () => {
    await withTempDir(async dir => {
      const file = join(dir, "package.json")
      await writeFile(file, conflictedDocument(OURS, THEIRS, BASE), "utf8")

      const quiet = await runCli(["--quiet", "--no-regenerate-lock", "--strategy", "lowest"], dir)
      assert.equal(quiet.code, 1, "the lint script is still left open")
      assert(
        quiet.stderr.includes(
          [
            "⚠️  2 dependencies one branch removed stay removed in package.json, without the other branch's changes:",
            "   - dependencies.zod: their branch removed it, our change to ^3.23.0 was dropped",
            "   - dependencies.lodash: our branch removed it, their change to ^4.17.21 was dropped",
            "   Add back any that are still needed.",
          ].join("\n")
        ),
        quiet.stderr
      )

      await writeFile(file, conflictedDocument(OURS, THEIRS, BASE), "utf8")
      const json = await runCli(["--json", "--no-regenerate-lock"], dir)
      const warning = jsonLines(json.stdout).find(record => record.data?.droppedChanges !== undefined)
      assert.deepEqual(warning.data.droppedChanges, [
        {field: "dependencies.zod", package: "zod", removedBy: "theirs", change: "^3.23.0", base: "^3.22.0"},
        {field: "dependencies.lodash", package: "lodash", removedBy: "ours", change: "^4.17.21", base: "^4.17.20"},
      ])
    })
  })

  test("a dry run says it would keep it removed, and changes nothing", async () => {
    await withTempDir(async dir => {
      const file = join(dir, "package.json")
      const content = conflictedDocument(ours, theirs, base)
      await writeFile(file, content, "utf8")

      const dryRun = await runCli(["--dry-run"], dir)
      assert.equal(dryRun.code, 0, dryRun.stderr)
      assert.match(
        dryRun.stderr,
        /A dependency one branch removed would stay removed in package\.json, without the other branch's change:\n {3}- dependencies\.lodash: our branch removed it, their change to \^4\.17\.21 was dropped\n {3}Add it back if it is still needed\./
      )
      assert.equal(await readFile(file, "utf8"), content)
    })
  })

  test("other values one branch removed are still left open, with whose removal it was", async () => {
    const ancestor = {name: "app", scripts: {build: "tsc", test: "jest"}}
    const current = {name: "app", scripts: {build: "tsc -b", test: "vitest"}}
    const other = {name: "app", scripts: {build: "vite build"}}

    const {result} = await mergeDriver(ancestor, current, other)
    assert.equal(result.code, 1)
    assert.deepEqual(result.stderr.trim().split("\n"), [
      "package-conflicts-resolver: left 2 values between conflict markers for you to decide:",
      "  - scripts.build: both branches changed it, and it is not a version",
      "  - scripts.test: their branch removed it, our branch changed it",
      "package-conflicts-resolver: everything else is merged. Edit them, or run package-conflicts-resolver --strategy ours (or theirs) on the file.",
    ])

    await withTempDir(async dir => {
      await writeFile(join(dir, "package.json"), conflictedDocument(current, other, ancestor), "utf8")
      const run = await runCli(["--no-regenerate-lock"], dir)
      assert.equal(run.code, 1)
      assert(
        run.stderr.includes(
          [
            "⚠️  Left 2 values between conflict markers in package.json for you to decide:",
            "   - scripts.build: both branches changed it, and it is not a version",
            "   - scripts.test: their branch removed it, our branch changed it",
            "   Everything else is merged. Edit them, or run again with --strategy ours or --strategy theirs.",
          ].join("\n")
        ),
        run.stderr
      )
    })
  })

  test("--list shows it as removed, and how to keep it", async () => {
    await withTempDir(async dir => {
      await writeFile(join(dir, "package.json"), conflictedDocument(OURS, THEIRS, BASE), "utf8")

      const list = await runCli(["--list"], dir)
      assert.equal(list.code, 0, list.stderr)
      const lines = list.stdout.split("\n")
      const row = (pattern: RegExp) =>
        assert(
          lines.some(line => pattern.test(line)),
          list.stdout
        )
      row(/^ {3}lodash +dependencies +\(removed\) +\^4\.17\.21 +\^4\.17\.20 +\(removed\)$/)
      row(/^ {3}zod +dependencies +\^3\.23\.0 +\(removed\) +\^3\.22\.0 +\(removed\)$/)
      row(/^ {3}react +dependencies +\^18\.3\.0 +\^18\.3\.1 +\^18\.2\.0 +\^18\.3\.1$/)
      assert(
        lines.includes("   Left for you to decide: scripts.lint (ours removed, theirs eslint --fix .)"),
        list.stdout
      )
      assert(
        lines.includes(
          "Choose the version of a package with --pick <name>@<version>, for example --pick lodash@^4.17.21"
        ),
        list.stdout
      )
      assert(
        lines.includes(
          "A dependency one branch removed stays removed, without the other branch's change: pick a version to keep it"
        ),
        list.stdout
      )

      const [report] = jsonLines((await runCli(["--list", "--json"], dir)).stdout)
      const lodash = report.files[0].packages.find((conflict: any) => conflict.name === "lodash")
      assert.deepEqual(
        [lodash.ours, lodash.theirs, lodash.resolved, lodash.resolvedBy],
        [null, "^4.17.21", null, "removal"]
      )
    })
  })

  test("--pick keeps a removed dependency", async () => {
    await withTempDir(async dir => {
      const file = join(dir, "package.json")
      await writeFile(file, conflictedDocument(OURS, THEIRS, BASE), "utf8")

      const picked = await runCli(["--pick", "lodash@^4.17.21", "--no-version-check", "--no-regenerate-lock"], dir)
      assert.equal(picked.code, 1, "the lint script is still left open")
      assert.match(picked.stderr, /dependencies\.zod: their branch removed it, our change to \^3\.23\.0 was dropped/)
      assert.doesNotMatch(picked.stderr, /dependencies\.lodash/)

      const finished = await runCli(["--strategy", "theirs", "--no-regenerate-lock"], dir)
      assert.equal(finished.code, 0, finished.stderr)
      assert.deepEqual(JSON.parse(await readFile(file, "utf8")), {
        name: "app",
        scripts: {build: "tsc", lint: "eslint --fix ."},
        dependencies: {react: "^18.3.1", lodash: "^4.17.21"},
      })
    })
  })
})

describe("a real git merge with a dependency one branch removed", () => {
  const git = (args: string[], cwd: string) => run("git", args, cwd)

  test("the merge finishes without it, and says whose change was dropped", async () => {
    await withTempDir(async dir => {
      const commit = async (message: string) => {
        assert.equal((await git(["add", "-A"], dir)).code, 0)
        const result = await git(["commit", "-m", message], dir)
        assert.equal(result.code, 0, result.stderr)
      }
      const writePackage = (value: unknown) => writeFile(join(dir, "package.json"), j(value), "utf8")

      await git(["init", "-b", "main"], dir)
      await git(["config", "user.name", "Test"], dir)
      await git(["config", "user.email", "test@example.com"], dir)
      await git(["config", "core.autocrlf", "false"], dir)
      await git(
        [
          "config",
          "merge.package-conflicts-resolver.driver",
          `"${process.execPath}" "${CLI_PATH}" merge-driver %A %O %B`,
        ],
        dir
      )
      await writeFile(join(dir, ".gitattributes"), "package.json merge=package-conflicts-resolver\n", "utf8")
      await writePackage({name: "app", dependencies: {lodash: "^4.17.19", react: "^18.2.0"}})
      await commit("base")

      await git(["checkout", "-b", "feature"], dir)
      await writePackage({name: "app", dependencies: {lodash: "^4.17.21", react: "^18.2.0"}})
      await commit("upgrade lodash")

      await git(["checkout", "main"], dir)
      await writePackage({name: "app", dependencies: {react: "^18.3.1"}})
      await commit("drop lodash, upgrade react")

      const merge = await git(["merge", "--no-edit", "feature"], dir)
      assert.equal(merge.code, 0, `${merge.stdout}\n${merge.stderr}`)
      assert.match(merge.stderr, /dependencies\.lodash: our branch removed it, their change to \^4\.17\.21 was dropped/)
      assert.equal((await git(["status", "--porcelain"], dir)).stdout.trim(), "")
      assert.deepEqual(JSON.parse(await readFile(join(dir, "package.json"), "utf8")), {
        name: "app",
        dependencies: {react: "^18.3.1"},
      })
      assert.match((await git(["log", "-1", "--format=%s"], dir)).stdout, /^Merge branch 'feature'/)
    })
  })
})
