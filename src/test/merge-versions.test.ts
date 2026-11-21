/**
 * Resolving a conflicted file from the versions in Git's index (base, ours and
 * theirs) rather than from its conflict markers.
 *
 * Default conflict markers do not carry the common ancestor, so everything
 * inside a conflict looks changed on both branches. The index versions tell
 * which branch changed what, but only stand for the file while it is still
 * what Git wrote: these tests cover both halves, with conflicts made by Git's
 * own line merge (`git merge-file`).
 */

import {strict as assert} from "assert"
import {test, describe} from "node:test"
import {writeFile} from "fs/promises"
import {join} from "node:path"
import {isDeepStrictEqual} from "node:util"
import {ConflictParser} from "../conflict-parser.js"
import {parseJsonLenient} from "../json-repair.js"
import {compareWithVersions, followsVersions} from "../merge-versions.js"
import {PackageResolver} from "../package-resolver.js"
import {CliOptions, MergeVersions} from "../types.js"
import {run, withTempDir} from "./cli-harness.js"

const resolver = (strategy: CliOptions["strategy"] = "highest", overrides: Partial<CliOptions> = {}) =>
  new PackageResolver({
    strategy,
    dryRun: true,
    quiet: true,
    json: false,
    verbose: false,
    regenerateLock: false,
    ...overrides,
  })

const j = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`

type ConflictStyle = "merge" | "diff3" | "zdiff3"

interface Merge {
  /** The file as Git leaves it in the work tree, with conflict markers */
  content: string
  versions: Required<MergeVersions>
}

/** Git's line merge of three versions of a document, as `git merge` leaves it: in the file, and in the index */
async function gitMerge(base: unknown, ours: unknown, theirs: unknown, style: ConflictStyle = "merge"): Promise<Merge> {
  const versions = {base: j(base), ours: j(ours), theirs: j(theirs)}
  const content = await withTempDir(async dir => {
    await writeFile(join(dir, "ours"), versions.ours)
    await writeFile(join(dir, "base"), versions.base)
    await writeFile(join(dir, "theirs"), versions.theirs)
    const flags = style === "merge" ? [] : [`--${style}`]
    // Exits with the number of conflicts
    return (await run("git", ["merge-file", "-p", ...flags, "ours", "base", "theirs"], dir)).stdout
  })
  assert.match(content, /^<{7} /m, "the versions were expected to conflict")
  return {content, versions}
}

/** We removed left-pad and bumped lodash; they added express and bumped lodash too, on the line next to left-pad */
const BASE = {name: "app", dependencies: {"left-pad": "^1.3.0", lodash: "^4.17.20", zod: "^3.0.0"}}
const OURS = {name: "app", dependencies: {lodash: "^4.17.22", zod: "^3.0.0"}}
const THEIRS = {
  name: "app",
  dependencies: {express: "^4.18.0", "left-pad": "^1.3.0", lodash: "^4.17.21", zod: "^3.0.0"},
}

describe("resolving from the versions in Git's index", () => {
  test("a dependency we removed is not brought back by a conflict next to it", async () => {
    const {content, versions} = await gitMerge(BASE, OURS, THEIRS)

    // The markers alone cannot tell our removal from their addition: left-pad comes back
    const fromMarkers = await resolver().resolveConflicts(content)
    assert.deepEqual(fromMarkers.packageJson!.dependencies, {
      express: "^4.18.0",
      "left-pad": "^1.3.0",
      lodash: "^4.17.22",
      zod: "^3.0.0",
    })

    const result = await resolver().resolveConflicts(content, versions)
    assert.equal(result.resolved, true, result.errors.join(", "))
    assert.deepEqual(result.packageJson!.dependencies, {express: "^4.18.0", lodash: "^4.17.22", zod: "^3.0.0"})
    assert.deepEqual(result.unresolved, [])
  })

  test("the result is the merge driver's, for every strategy and conflict style", async () => {
    for (const style of ["merge", "diff3", "zdiff3"] as const) {
      const {content, versions} = await gitMerge(BASE, OURS, THEIRS, style)
      for (const strategy of ["highest", "lowest", "ours", "theirs"] as const) {
        const driver = await resolver(strategy).mergeJsonContents(versions.base, versions.ours, versions.theirs)
        const result = await resolver(strategy).resolveConflicts(content, versions)
        assert.deepEqual(result.packageJson, driver.packageJson, `${style}, ${strategy}`)
        assert.deepEqual(result.packageConflicts, driver.packageConflicts, `${style}, ${strategy}`)
      }
    }
  })

  test("a change only one branch made is kept, even when it lowers a version", async () => {
    // They went back to lodash 4.17.20 on purpose; the version line next to it conflicts
    const {content, versions} = await gitMerge(
      {name: "app", version: "1.0.0", lodash: "^4.17.21"},
      {name: "app", version: "1.1.0", lodash: "^4.17.21"},
      {name: "app", version: "2.0.0", lodash: "^4.17.20"}
    )
    const result = await resolver().resolveConflicts(content, versions)
    assert.deepEqual(result.packageJson, {name: "app", version: "2.0.0", lodash: "^4.17.20"})
  })

  test("a script only one branch changed is not left for the user", async () => {
    const {content, versions} = await gitMerge(
      {name: "app", version: "1.0.0", scripts: {build: "tsc", test: "jest"}},
      {name: "app", version: "1.1.0", scripts: {build: "tsc", test: "jest"}},
      {name: "app", version: "1.2.0", scripts: {build: "tsc -b", test: "jest"}}
    )
    assert.match(content, /"build": "tsc -b"/)

    const result = await resolver().resolveConflicts(content, versions)
    assert.deepEqual(result.unresolved, [])
    assert.deepEqual(result.packageJson!.scripts, {build: "tsc -b", test: "jest"})
  })

  test("a dependency one branch removed and the other changed stays removed, and is reported", async () => {
    const {content, versions} = await gitMerge(
      {name: "app", dependencies: {lodash: "^4.17.20", zod: "^3.0.0"}},
      {name: "app", dependencies: {zod: "^3.0.0"}},
      {name: "app", dependencies: {lodash: "^4.17.21", zod: "^3.0.0"}}
    )
    const result = await resolver().resolveConflicts(content, versions)
    assert.deepEqual(result.packageJson!.dependencies, {zod: "^3.0.0"})
    assert.deepEqual(
      result.packageConflicts?.map(conflict => [conflict.name, conflict.base, conflict.theirs, conflict.resolvedBy]),
      [["lodash", "^4.17.20", "^4.17.21", "removal"]]
    )
  })

  test("values left for the user show the common ancestor, so a later run reads them the same way", async () => {
    const {content, versions} = await gitMerge(
      {name: "app", scripts: {build: "tsc"}},
      {name: "app", scripts: {build: "tsc -b"}},
      {name: "app", scripts: {build: "vite build"}}
    )
    const result = await resolver().resolveConflicts(content, versions)
    assert.deepEqual(result.unresolved, [
      {
        field: "scripts.build",
        path: ["scripts", "build"],
        reason: "not-a-version",
        ours: "tsc -b",
        theirs: "vite build",
        base: "tsc",
      },
    ])
  })

  test("a file both branches added has no common ancestor to read", async () => {
    const ours = {name: "app", version: "1.0.0", dependencies: {lodash: "^4.17.20"}}
    const theirs = {name: "app", version: "1.1.0", dependencies: {lodash: "^4.17.21"}}
    const {content} = await gitMerge({}, ours, theirs)
    const versions = {ours: j(ours), theirs: j(theirs)}

    assert.equal(followsVersions(content, versions), true)
    const result = await resolver().resolveConflicts(content, versions)
    assert.deepEqual(result.packageJson, {name: "app", version: "1.1.0", dependencies: {lodash: "^4.17.21"}})
  })

  test("a lockfile entry one branch removed stays removed", async () => {
    const entry = (name: string, version: string) => ({
      version,
      resolved: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
      integrity: `sha512-${name}-${version}`,
    })
    const lockfile = (dependencies: Record<string, string>, versions: Record<string, string>) => ({
      name: "app",
      lockfileVersion: 3,
      packages: {
        "": {name: "app", dependencies},
        ...Object.fromEntries(
          Object.entries(versions).map(([name, version]) => [`node_modules/${name}`, entry(name, version)])
        ),
      },
    })
    const {content, versions} = await gitMerge(
      lockfile({"left-pad": "^1.3.0", lodash: "^4.17.20"}, {"left-pad": "1.3.0", lodash: "4.17.20"}),
      lockfile({lodash: "^4.17.22"}, {lodash: "4.17.22"}),
      lockfile({"left-pad": "^1.3.0", lodash: "^4.17.21"}, {"left-pad": "1.3.0", lodash: "4.17.21"})
    )

    const result = await resolver().resolveConflicts(content, versions)
    assert.deepEqual(Object.keys(result.packageJson!.packages), ["", "node_modules/lodash"])
    assert.deepEqual(result.packageJson!.packages[""].dependencies, {lodash: "^4.17.22"})
    assert.equal(result.packageJson!.packages["node_modules/lodash"].version, "4.17.22")
    assert.deepEqual(result.lockfileIssues, [])
  })
})

describe("a file changed after Git wrote it is resolved from its markers", () => {
  /** Unchanged lines: Git makes one conflict of two that are less than four lines apart */
  const between = {license: "MIT", main: "index.js", types: "index.d.ts", private: true}
  /** Two conflicts: the version, and the dependencies */
  const base = {name: "app", version: "1.0.0", ...between, dependencies: {a: "^1.0.0", b: "^1.0.0"}}
  const ours = {name: "app", version: "1.1.0", ...between, dependencies: {b: "^1.1.0"}}
  const theirs = {name: "app", version: "1.2.0", ...between, dependencies: {a: "^1.0.0", b: "^1.2.0"}}

  test("the file as Git wrote it follows the versions, in every conflict style", async () => {
    for (const style of ["merge", "diff3", "zdiff3"] as const) {
      const {content, versions} = await gitMerge(base, ours, theirs, style)
      assert.equal(followsVersions(content, versions), true, style)
    }
  })

  test("a value edited outside the conflicts is kept", async () => {
    const {content, versions} = await gitMerge(base, ours, theirs)
    const edited = content.replace('"license": "MIT"', '"license": "Apache-2.0"')
    assert.notEqual(edited, content)
    assert.equal(followsVersions(edited, versions), false)
    assert.equal(compareWithVersions(edited, versions), "changed")

    const result = await resolver().resolveConflicts(edited, versions)
    assert.equal(result.packageJson!.license, "Apache-2.0")
    assert.equal(result.packageJson!.version, "1.2.0", "the conflicts are still resolved")
  })

  test("a conflict resolved by hand is kept, while the others are resolved", async () => {
    const {content, versions} = await gitMerge(base, ours, theirs)
    // The version conflict resolved by hand, to our version rather than the highest
    const edited = content.replace(/<{7} [^\n]*\n(\s*"version": "1\.1\.0",\n)={7}\n[^\n]*\n>{7} [^\n]*\n/, "$1")
    assert.notEqual(edited, content)
    assert.match(edited, /^<{7} /m, "the dependencies are still conflicted")
    assert.equal(followsVersions(edited, versions), false)

    const result = await resolver().resolveConflicts(edited, versions)
    assert.equal(result.packageJson!.version, "1.1.0")
    assert.equal(result.packageJson!.dependencies!.b, "^1.2.0")
  })

  test("a value written by hand inside a conflict is kept", async () => {
    const {content, versions} = await gitMerge(base, ours, theirs)
    const edited = content.replace('"b": "^1.1.0"', '"b": "^1.9.0"')
    assert.notEqual(edited, content)
    assert.equal(followsVersions(edited, versions), false)

    const result = await resolver().resolveConflicts(edited, versions)
    assert.equal(result.packageJson!.dependencies!.b, "^1.9.0")
  })

  test("a dependency added by hand is kept", async () => {
    const {content, versions} = await gitMerge(base, ours, theirs)
    const edited = content.replace('"dependencies": {\n', '"dependencies": {\n    "0-added": "^1.0.0",\n')
    assert.notEqual(edited, content)
    assert.equal(followsVersions(edited, versions), false)

    const result = await resolver().resolveConflicts(edited, versions)
    assert.equal(result.packageJson!.dependencies!["0-added"], "^1.0.0")
  })

  test("a conflict resolved by hand the way the versions merge changes nothing", async () => {
    // Only they changed the license, on the line next to the version both changed
    const {content, versions} = await gitMerge(
      {name: "app", version: "1.0.0", license: "MIT"},
      {name: "app", version: "1.1.0", license: "MIT"},
      {name: "app", version: "1.2.0", license: "ISC"}
    )
    // By hand: their license on our side of the conflict too, which is what merging the versions gives
    const edited = content.replace('"license": "MIT"', '"license": "ISC"')
    assert.notEqual(edited, content)
    assert.equal(followsVersions(edited, versions), true)
    assert.deepEqual((await resolver().resolveConflicts(edited, versions)).packageJson, {
      name: "app",
      version: "1.2.0",
      license: "ISC",
    })
  })

  test("a later run only decides the values an earlier one left between markers", async () => {
    const versions = {
      base: j({name: "app", scripts: {build: "tsc"}, dependencies: {lodash: "^4.17.20"}}),
      ours: j({name: "app", scripts: {build: "tsc -b"}, dependencies: {lodash: "^4.17.21"}}),
      theirs: j({name: "app", scripts: {build: "vite build"}, dependencies: {lodash: "^4.17.22"}}),
    }
    // What the merge driver, or an earlier run, wrote: lodash decided by "highest", the script left open
    const written = [
      "{",
      '  "name": "app",',
      '  "scripts": {',
      "<<<<<<< ours",
      '    "build": "tsc -b"',
      "||||||| base",
      '    "build": "tsc"',
      "=======",
      '    "build": "vite build"',
      ">>>>>>> theirs",
      "  },",
      '  "dependencies": {',
      '    "lodash": "^4.17.22"',
      "  }",
      "}",
      "",
    ].join("\n")
    assert.equal(followsVersions(written, versions), false)

    // "ours" is for the script: lodash stays as the first run decided it
    const result = await resolver("ours").resolveConflicts(written, versions)
    assert.deepEqual(result.packageJson, {
      name: "app",
      scripts: {build: "tsc -b"},
      dependencies: {lodash: "^4.17.22"},
    })
  })

  test("a version picked in an earlier run is kept", async () => {
    const {versions} = await gitMerge(base, ours, theirs)
    const written = [
      "{",
      '  "name": "app",',
      "<<<<<<< ours",
      '  "version": "1.1.0",',
      "=======",
      '  "version": "1.2.0",',
      ">>>>>>> theirs",
      '  "license": "MIT",',
      '  "main": "index.js",',
      '  "types": "index.d.ts",',
      '  "private": true,',
      '  "dependencies": {',
      '    "b": "1.5.0"',
      "  }",
      "}",
      "",
    ].join("\n")
    const result = await resolver().resolveConflicts(written, versions)
    assert.equal(result.packageJson!.dependencies!.b, "1.5.0")
  })

  test("versions that are not JSON objects are not used", async () => {
    const {content, versions} = await gitMerge(base, ours, theirs)
    const expected = (await resolver().resolveConflicts(content)).packageJson

    // A criss-cross merge can leave conflict markers in the common ancestor itself
    for (const broken of [
      "<<<<<<< Temporary merge branch 1\n{}\n=======\n{}\n>>>>>>> Temporary merge branch 2\n",
      "[]",
    ]) {
      assert.equal(followsVersions(content, {...versions, base: broken}), false)
      assert.equal(compareWithVersions(content, {...versions, base: broken}), "unreadable")
      const result = await resolver().resolveConflicts(content, {...versions, base: broken})
      assert.equal(result.resolved, true)
      assert.deepEqual(result.packageJson, expected)
    }
    assert.equal(followsVersions(content, {...versions, ours: ""}), false)
    assert.equal(followsVersions(content, {...versions, theirs: '"text"'}), false)
  })

  test("a file whose sides cannot be read as JSON is not checked against the versions", () => {
    const versions = {ours: j({name: "a"}), theirs: j({name: "b"})}
    const content = '<<<<<<< HEAD\n{"name" "a"}\n=======\n{"name": "b"}\n>>>>>>> x\n'
    assert.equal(followsVersions(content, versions), false)
    assert.equal(compareWithVersions(content, versions), "unreadable")
  })
})

describe("what Git's line merge leaves in a file", () => {
  test("lists that Git merged line by line follow the versions; an item removed by hand does not", async () => {
    const {content, versions} = await gitMerge(
      {name: "app", version: "1.0.0", files: ["dist", "lib", "types"], keywords: ["a"]},
      {name: "app", version: "1.1.0", files: ["bin", "dist", "lib", "types"], keywords: ["a"]},
      {name: "app", version: "1.2.0", files: ["dist", "lib", "types", "zz"], keywords: ["a"]}
    )
    // Both additions are in the list, on either side of the version conflict
    assert.match(content, /"bin",\n {4}"dist",\n {4}"lib",\n {4}"types",\n {4}"zz"/)
    assert.equal(followsVersions(content, versions), true)

    const edited = content.replace('    "lib",\n', "")
    assert.equal(followsVersions(edited, versions), false)
    const result = await resolver().resolveConflicts(edited, versions)
    assert.deepEqual(result.packageJson!.files, ["bin", "dist", "types", "zz"])
  })

  test("the ancestor that diff3 conflicts show is checked too", async () => {
    const {content, versions} = await gitMerge(
      {
        name: "app",
        files: ["dist", "lib"],
        license: "MIT",
        main: "a.js",
        types: "a.d.ts",
        private: true,
        version: "1.0.0",
      },
      {
        name: "app",
        files: ["bin", "dist"],
        license: "MIT",
        main: "a.js",
        types: "a.d.ts",
        private: true,
        version: "1.1.0",
      },
      {
        name: "app",
        files: ["dist", "zz"],
        license: "MIT",
        main: "a.js",
        types: "a.d.ts",
        private: true,
        version: "1.2.0",
      },
      "diff3"
    )
    // Two conflicts, each with the ancestor's lines between ours and theirs
    assert.equal(content.match(/^\|{7} /gm)?.length, 2, content)
    assert.equal(followsVersions(content, versions), true)

    // A later merge from the markers would go by what these sections say
    for (const [written, edited] of [
      ['    "lib"\n=======', '    "lib",\n    "src"\n======='],
      ['  "version": "1.0.0"\n=======', '  "version": "0.9.0"\n======='],
    ] as const) {
      assert(content.includes(written), content)
      assert.equal(followsVersions(content.replace(written, edited), versions), false, edited)
    }
  })

  test("values that Git merged into one object from both branches follow the versions", async () => {
    const {content, versions} = await gitMerge(
      {name: "app", version: "1.0.0", scripts: {a: "1", m: "1", z: "1"}},
      {name: "app", version: "1.1.0", scripts: {a: "2", m: "1", z: "1"}},
      {name: "app", version: "1.2.0", scripts: {a: "1", m: "1", z: "2"}}
    )
    assert.equal(followsVersions(content, versions), true)
    const result = await resolver().resolveConflicts(content, versions)
    assert.deepEqual(result.packageJson!.scripts, {a: "2", m: "1", z: "2"})
  })

  test("a package named like a property every object inherits is read as a value", async () => {
    const {content, versions} = await gitMerge(
      {name: "app", version: "1.0.0", dependencies: {a: "^1.0.0"}},
      {name: "app", version: "1.1.0", dependencies: {a: "^1.0.0"}},
      {name: "app", version: "1.2.0", dependencies: {a: "^1.0.0", constructor: "^1.0.0"}}
    )
    assert.equal(followsVersions(content, versions), true)
    assert.equal(
      followsVersions(content.replace('"constructor": "^1.0.0"', '"constructor": "^2.0.0"'), versions),
      false
    )
  })

  test("an object one branch removed is shown whole or not at all", () => {
    // We added a script to an object they removed: Git cannot leave a part of it
    const versions = {
      base: j({name: "app", scripts: {a: "1"}}),
      ours: j({name: "app", scripts: {a: "1", b: "2"}}),
      theirs: j({name: "app"}),
    }
    const conflict = (scripts: string[]) =>
      ["{", "<<<<<<< HEAD", ...scripts, "=======", ">>>>>>> feature", '  "name": "app"', "}", ""].join("\n")

    const written = conflict(['  "scripts": {', '    "a": "1",', '    "b": "2"', "  },"])
    assert.equal(followsVersions(written, versions), true)
    const edited = conflict(['  "scripts": {', '    "b": "2"', "  },"])
    assert.equal(followsVersions(edited, versions), false)
  })
})

describe("merging the versions against random edits, property-based", () => {
  /** Deterministic PRNG so any failure is reproducible from its seed */
  function makeRandom(seed: number): () => number {
    let state = (seed * 2654435761) >>> 0
    return () => {
      state = (state * 1664525 + 1013904223) >>> 0
      return state / 0x100000000
    }
  }
  const pick = <T>(random: () => number, values: readonly T[]): T => values[Math.floor(random() * values.length)] as T

  const VALUES: Record<string, readonly string[]> = {
    scripts: ["tsc", "tsc -b", "vite build", "jest", "vitest"],
    dependencies: ["^1.0.0", "^1.1.0", "^2.0.0", "~1.5.0", "github:u/x#main"],
    "": ["one", "two", "three"],
  }
  const KEYS: Record<string, readonly string[]> = {
    scripts: ["build", "lint", "start", "test"],
    dependencies: ["a", "b", "c", "d", "e", "f"],
    "": ["description", "license", "version"],
  }

  function randomDocument(random: () => number): Record<string, any> {
    const fill = (kind: string) =>
      Object.fromEntries(
        (KEYS[kind] as readonly string[])
          .filter(() => random() < 0.7)
          .map(key => [key, pick(random, VALUES[kind] as readonly string[])])
      )
    return {name: "app", ...fill(""), scripts: fill("scripts"), dependencies: fill("dependencies")}
  }

  /** A branch of a document: each value kept, changed or removed, and some added, in the same key order */
  function randomBranch(random: () => number, base: Record<string, any>): Record<string, any> {
    const mutate = (object: Record<string, any>, kind: string) => {
      const result: Record<string, any> = {}
      for (const key of [...new Set([...Object.keys(object), ...(KEYS[kind] as readonly string[])])].sort()) {
        const roll = random()
        if (object[key] === undefined) {
          if (roll < 0.15) result[key] = pick(random, VALUES[kind] as readonly string[])
        } else if (roll < 0.15) {
          continue
        } else {
          result[key] = roll < 0.4 ? pick(random, VALUES[kind] as readonly string[]) : object[key]
        }
      }
      return result
    }
    const {name, scripts, dependencies, ...rest} = base
    return {
      name,
      ...mutate(rest, ""),
      scripts: mutate(scripts, "scripts"),
      dependencies: mutate(dependencies, "dependencies"),
    }
  }

  test("Git's merge resolves like the merge driver, and nothing decided by hand is undone", async () => {
    let conflicted = 0
    let edits = 0
    let resolvedByHand = 0

    await withTempDir(async dir => {
      for (let seed = 1; seed <= 60; seed++) {
        const random = makeRandom(seed)
        const base = randomDocument(random)
        const versions = {base: j(base), ours: j(randomBranch(random, base)), theirs: j(randomBranch(random, base))}
        await writeFile(join(dir, "ours"), versions.ours)
        await writeFile(join(dir, "base"), versions.base)
        await writeFile(join(dir, "theirs"), versions.theirs)
        const style = pick(random, ["merge", "diff3", "zdiff3"] as const)
        const flags = style === "merge" ? [] : [`--${style}`]
        const content = (await run("git", ["merge-file", "-p", ...flags, "ours", "base", "theirs"], dir)).stdout
        if (!/^<{7} /m.test(content)) {
          continue
        }
        conflicted++
        const context = `seed ${seed} (${style})\n${content}`

        // Git's own output is recognized, and resolves exactly as the merge driver resolves the versions
        assert.equal(followsVersions(content, versions), true, context)
        const driver = await resolver().mergeJsonContents(versions.base, versions.ours, versions.theirs)
        const result = await resolver().resolveConflicts(content, versions)
        assert.deepEqual(result.packageJson, driver.packageJson, context)
        assert.deepEqual(result.unresolved, driver.unresolved, context)

        // A value written by hand, anywhere in the file, is never taken for Git's: it survives the run
        const lines = content.split("\n")
        const values = lines.flatMap((line, index) => (/^\s+"[^"]+": "[^"]*",?$/.test(line) ? [index] : []))
        const edited = pick(random, values)
        lines[edited] = (lines[edited] as string).replace(/: "[^"]*"/, ': "edited-by-hand"')
        const changed = lines.join("\n")
        assert.equal(followsVersions(changed, versions), false, `edited line ${edited + 1} of ${context}`)
        edits++

        // Some conflicts resolved by hand, each to one of its sides: whatever the file has decided by now stays
        const conflicts = ConflictParser.parseConflicts(content)
        const byHand = content.split("\n")
        for (const conflict of conflicts.filter(() => random() < 0.5).reverse()) {
          const side = conflict[pick(random, ["ours", "theirs"] as const)]
          byHand.splice(conflict.start, conflict.end - conflict.start + 1, ...(side === "" ? [] : side.split("\n")))
        }
        const partly = byHand.join("\n")
        if (partly !== content && ConflictParser.hasConflicts(partly)) {
          const rerun = await resolver().resolveConflicts(partly, versions)
          assert.equal(rerun.resolved, true, `${rerun.errors.join(", ")}\n${partly}`)
          assertKeepsDecided(
            rerun.packageJson,
            parseJsonLenient(ConflictParser.extractConflictSide(partly, "ours")),
            parseJsonLenient(ConflictParser.extractConflictSide(partly, "theirs")),
            `seed ${seed} (${style}), resolved in part by hand:\n${partly}`
          )
          resolvedByHand++
        }
      }
    })

    assert(conflicted >= 40, `expected most merges to conflict, got ${conflicted}`)
    assert.equal(edits, conflicted)
    assert(resolvedByHand >= 10, `expected files resolved in part by hand, got ${resolvedByHand}`)
  })
})

/**
 * Assert that a merged document keeps what a conflicted file had decided:
 * every value both sides of the file agree on, and no key that neither side
 * shows.
 */
function assertKeepsDecided(
  merged: unknown,
  ours: unknown,
  theirs: unknown,
  context: string,
  path: string[] = []
): void {
  const isObject = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value)

  if (isDeepStrictEqual(ours, theirs)) {
    assert.deepEqual(merged, ours, `${path.join(".")} was decided in the file\n${context}`)
  } else if (isObject(ours) && isObject(theirs)) {
    assert(isObject(merged), `${path.join(".")} is an object on both sides\n${context}`)
    for (const key of Object.keys(merged)) {
      assert(key in ours || key in theirs, `${path.concat(key).join(".")} is on neither side of the file\n${context}`)
    }
    for (const key of new Set([...Object.keys(ours), ...Object.keys(theirs)])) {
      assertKeepsDecided(merged[key], ours[key], theirs[key], context, path.concat(key))
    }
  }
}
