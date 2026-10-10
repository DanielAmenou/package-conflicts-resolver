/**
 * Which conflicts are about package versions (ResolutionResult.packageConflicts)
 * and how picked versions resolve them, for package.json, every lockfile
 * format, three-way merges and the block-based fallback.
 */

import {strict as assert} from "assert"
import {test, describe} from "node:test"
import {PackageResolver} from "../package-resolver.js"
import {CliOptions, PackageConflict} from "../types.js"

const OPTIONS: CliOptions = {
  strategy: "highest",
  dryRun: true,
  quiet: true,
  json: false,
  verbose: false,
  regenerateLock: false,
}

const resolver = (overrides: Partial<CliOptions> = {}) => new PackageResolver({...OPTIONS, ...overrides})

/** A document conflicted as a whole: ours above, theirs below */
function conflicted(ours: unknown, theirs: unknown): string {
  const lines = (value: unknown) => JSON.stringify(value, null, 2).split("\n").slice(1, -1)
  return ["{", "<<<<<<< HEAD", ...lines(ours), "=======", ...lines(theirs), ">>>>>>> feature", "}", ""].join("\n")
}

/** Same, with a diff3 base section */
function conflicted3(ours: unknown, base: unknown, theirs: unknown): string {
  const lines = (value: unknown) => JSON.stringify(value, null, 2).split("\n").slice(1, -1)
  return [
    "{",
    "<<<<<<< HEAD",
    ...lines(ours),
    "||||||| base",
    ...lines(base),
    "=======",
    ...lines(theirs),
    ">>>>>>> feature",
    "}",
    "",
  ].join("\n")
}

const lockEntry = (name: string, version: string, extra: Record<string, unknown> = {}) => ({
  version,
  resolved: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
  integrity: `sha512-${name}-${version}`,
  ...extra,
})

const brief = (conflicts: PackageConflict[] | undefined) =>
  (conflicts ?? []).map(c => `${c.name} ${c.location}: ${c.ours} | ${c.theirs} -> ${c.resolved} (${c.resolvedBy})`)

describe("package conflicts in package.json", () => {
  const ours = {
    name: "app",
    version: "1.1.0",
    dependencies: {lodash: "^4.17.19", react: "^18.2.0"},
    devDependencies: {typescript: "~5.4.0"},
    peerDependencies: {react: "^18.0.0"},
    optionalDependencies: {fsevents: "^2.3.2"},
    scripts: {build: "tsc"},
  }
  const theirs = {
    name: "app",
    version: "1.2.0",
    dependencies: {lodash: "^4.17.21", react: "^18.2.0"},
    devDependencies: {typescript: "~5.6.2"},
    peerDependencies: {react: "^17.0.0 || ^18.0.0"},
    optionalDependencies: {fsevents: "^2.3.3"},
    scripts: {build: "tsc -b"},
  }

  test("every conflicting dependency spec is reported, in every dependency field", async () => {
    const result = await resolver().resolveConflicts(conflicted(ours, theirs))
    assert.equal(result.resolved, true, result.errors.join(", "))
    assert.deepEqual(brief(result.packageConflicts), [
      "lodash dependencies: ^4.17.19 | ^4.17.21 -> ^4.17.21 (highest)",
      "typescript devDependencies: ~5.4.0 | ~5.6.2 -> ~5.6.2 (highest)",
      "react peerDependencies: ^18.0.0 | ^17.0.0 || ^18.0.0 -> ^18.0.0 (highest)",
      "fsevents optionalDependencies: ^2.3.2 | ^2.3.3 -> ^2.3.3 (highest)",
    ])
  })

  test("records carry the JSON path, and no base or pick when there is none", async () => {
    const result = await resolver().resolveConflicts(conflicted(ours, theirs))
    assert.deepEqual(result.packageConflicts?.[0], {
      name: "lodash",
      kind: "spec",
      location: "dependencies",
      path: ["dependencies", "lodash"],
      ours: "^4.17.19",
      theirs: "^4.17.21",
      resolved: "^4.17.21",
      resolvedBy: "highest",
    })
  })

  test("conflict records name their package; other conflicts do not", async () => {
    const result = await resolver().resolveConflicts(conflicted(ours, theirs))
    const byField = Object.fromEntries(result.conflicts.map(c => [c.field, c.package]))
    assert.equal(byField["dependencies.lodash"], "lodash")
    assert.equal(byField["peerDependencies.react"], "react")
    assert.equal(byField["version"], undefined)
    // The script is no version: it is left for the user, and is no package conflict either
    assert.deepEqual(
      result.unresolved?.map(conflict => conflict.field),
      ["scripts.build"]
    )
    assert(!result.packageConflicts?.some(conflict => conflict.name === "build"))
  })

  test("arrays of objects are resolved by the strategy and are no package conflicts", async () => {
    const result = await resolver({strategy: "theirs", picks: {lodash: "4.17.20"}}).resolveConflicts(
      conflicted({contributors: [{name: "Ann"}]}, {contributors: [{name: "Bob"}]})
    )
    assert.deepEqual(result.packageJson?.contributors, [{name: "Bob"}])
    assert.deepEqual(result.packageConflicts, [])
    assert.equal(result.conflicts[0]?.field, "contributors")
    assert.equal(result.conflicts[0]?.package, undefined)
  })

  test("no conflicts, no package conflicts", async () => {
    const clean = await resolver().resolveConflicts(JSON.stringify(ours, null, 2))
    assert.deepEqual(clean.packageConflicts, [])

    const versionOnly = await resolver().resolveConflicts(conflicted({version: "1.0.0"}, {version: "2.0.0"}))
    assert.deepEqual(versionOnly.packageConflicts, [])
    assert.equal(versionOnly.conflicts.length, 1)
  })

  test("a three-way merge reports the base and only real conflicts", async () => {
    const base = {dependencies: {lodash: "^4.17.15", react: "^18.0.0"}}
    const result = await resolver().resolveConflicts(
      conflicted3({dependencies: {lodash: "^4.17.19", react: "^18.2.0"}}, base, {
        dependencies: {lodash: "^4.17.21", react: "^18.0.0"},
      })
    )
    // react changed on our side only: merged without a conflict
    assert.deepEqual(result.packageConflicts, [
      {
        name: "lodash",
        kind: "spec",
        location: "dependencies",
        path: ["dependencies", "lodash"],
        ours: "^4.17.19",
        theirs: "^4.17.21",
        base: "^4.17.15",
        resolved: "^4.17.21",
        resolvedBy: "highest",
      },
    ])
    assert.equal(result.packageJson?.dependencies?.react, "^18.2.0")
  })

  test("a dependency added on both branches has no base", async () => {
    const result = await resolver().mergeJsonContents(
      JSON.stringify({dependencies: {}}),
      JSON.stringify({dependencies: {zod: "^3.22.0"}}),
      JSON.stringify({dependencies: {zod: "^3.23.0"}})
    )
    assert.equal(result.packageConflicts?.[0]?.base, undefined)
    assert.equal(result.packageConflicts?.[0]?.resolved, "^3.23.0")
  })

  test("documents where one side is empty have no package conflicts", async () => {
    const result = await resolver().mergeJsonContents("", JSON.stringify(ours), "")
    assert.equal(result.resolved, true)
    assert.deepEqual(result.packageConflicts, [])
  })
})

describe("picked versions in package.json", () => {
  const ours = {
    version: "1.1.0",
    dependencies: {lodash: "^4.17.19", react: "^18.2.0", zod: "^3.22.0"},
    devDependencies: {typescript: "~5.4.0"},
  }
  const theirs = {
    version: "1.2.0",
    dependencies: {lodash: "^4.17.21", react: "^18.3.1", zod: "^3.23.0"},
    devDependencies: {typescript: "~5.6.2"},
  }

  test("a picked package gets the picked spec verbatim; every other conflict uses the strategy", async () => {
    const result = await resolver({
      strategy: "lowest",
      picks: {lodash: "4.17.22", typescript: "~5.5.4"},
    }).resolveConflicts(conflicted(ours, theirs))
    assert.equal(result.resolved, true, result.errors.join(", "))
    assert.deepEqual(result.packageJson?.dependencies, {lodash: "4.17.22", react: "^18.2.0", zod: "^3.22.0"})
    assert.deepEqual(result.packageJson?.devDependencies, {typescript: "~5.5.4"})
    assert.equal(result.packageJson?.version, "1.1.0", "lowest strategy for the rest")

    assert.deepEqual(brief(result.packageConflicts), [
      "lodash dependencies: ^4.17.19 | ^4.17.21 -> 4.17.22 (pick)",
      "react dependencies: ^18.2.0 | ^18.3.1 -> ^18.2.0 (lowest)",
      "zod dependencies: ^3.22.0 | ^3.23.0 -> ^3.22.0 (lowest)",
      "typescript devDependencies: ~5.4.0 | ~5.6.2 -> ~5.5.4 (pick)",
    ])
    assert.equal(result.packageConflicts?.[0]?.pick, "4.17.22")
    assert.equal(result.packageConflicts?.[1]?.pick, undefined)

    const lodash = result.conflicts.find(conflict => conflict.field === "dependencies.lodash")
    assert.equal(lodash?.strategy, "pick")
    assert.equal(lodash?.resolvedValue, "4.17.22")
  })

  test("a pick can be one side's spec, a range, an alias or a non-registry spec", async () => {
    const result = await resolver({
      picks: {lodash: "^4.17.19", react: "npm:preact-compat@^3.19.0", zod: "github:colinhacks/zod#v3"},
    }).resolveConflicts(conflicted(ours, theirs))
    assert.deepEqual(result.packageJson?.dependencies, {
      lodash: "^4.17.19",
      react: "npm:preact-compat@^3.19.0",
      zod: "github:colinhacks/zod#v3",
    })
  })

  test("a pick applies wherever the package is conflicted, and only to that package", async () => {
    const result = await resolver({picks: {react: "18.3.1"}}).resolveConflicts(
      conflicted(
        {dependencies: {react: "^18.2.0", "react-dom": "^18.2.0"}, peerDependencies: {react: "^18.0.0"}},
        {dependencies: {react: "^18.3.1", "react-dom": "^18.3.1"}, peerDependencies: {react: ">=17"}}
      )
    )
    assert.deepEqual(result.packageJson?.dependencies, {react: "18.3.1", "react-dom": "^18.3.1"})
    assert.deepEqual(result.packageJson?.peerDependencies, {react: "18.3.1"})
  })

  test("a pick for a package without conflicts changes nothing", async () => {
    const result = await resolver({picks: {express: "4.0.0"}}).resolveConflicts(conflicted(ours, theirs))
    assert.equal(result.packageJson?.dependencies?.express, undefined)
    assert(result.packageConflicts?.every(conflict => conflict.pick === undefined))
  })

  test("a one-sided change is not a conflict, so a pick does not override it", async () => {
    const result = await resolver({picks: {lodash: "4.17.15"}}).mergeJsonContents(
      JSON.stringify({dependencies: {lodash: "^4.17.15"}}),
      JSON.stringify({dependencies: {lodash: "^4.17.21"}}),
      JSON.stringify({dependencies: {lodash: "^4.17.15"}})
    )
    assert.equal(result.packageJson?.dependencies?.lodash, "^4.17.21")
    assert.deepEqual(result.packageConflicts, [])
  })

  test("picks also apply to the merge driver's three-way merge", async () => {
    const result = await resolver({picks: {lodash: "4.17.20"}}).mergeJsonContents(
      JSON.stringify({dependencies: {lodash: "^4.17.15"}}),
      JSON.stringify({dependencies: {lodash: "^4.17.19"}}),
      JSON.stringify({dependencies: {lodash: "^4.17.21"}})
    )
    assert.equal(result.packageJson?.dependencies?.lodash, "4.17.20")
    assert.equal(result.packageConflicts?.[0]?.base, "^4.17.15")
    assert.equal(result.packageConflicts?.[0]?.resolvedBy, "pick")
  })

  test("invalid picks are refused up front", () => {
    assert.throws(() => resolver({picks: {"not a name": "1.0.0"}}), /is not a valid package name/)
    assert.throws(() => resolver({picks: {lodash: "latest"}}), /dist-tag/)
  })
})

/** A lockfile v3 document */
const lockfile = (packages: Record<string, unknown>) => ({name: "app", lockfileVersion: 3, requires: true, packages})

describe("package conflicts in npm lockfiles (v3)", () => {
  const ours = lockfile({
    "": {name: "app", dependencies: {lodash: "^4.17.20", "@scope/pkg": "^1.0.0"}, devDependencies: {ms: "2.1.2"}},
    "packages/web": {name: "web", version: "1.0.0", dependencies: {left: "^1.0.0"}},
    "node_modules/lodash": lockEntry("lodash", "4.17.20"),
    "node_modules/@scope/pkg": lockEntry("pkg", "1.0.0"),
    "node_modules/ms": lockEntry("ms", "2.1.2", {dev: true}),
    "node_modules/debug/node_modules/ms": lockEntry("ms", "2.0.0"),
    "node_modules/debug": lockEntry("debug", "4.3.4", {dependencies: {ms: "2.0.0"}}),
  })
  const theirs = lockfile({
    "": {name: "app", dependencies: {lodash: "^4.17.21", "@scope/pkg": "^1.1.0"}, devDependencies: {ms: "2.1.3"}},
    "packages/web": {name: "web", version: "1.1.0", dependencies: {left: "^1.1.0"}},
    "node_modules/lodash": lockEntry("lodash", "4.17.21"),
    "node_modules/@scope/pkg": lockEntry("pkg", "1.1.0"),
    "node_modules/ms": lockEntry("ms", "2.1.3", {dev: true}),
    "node_modules/debug/node_modules/ms": lockEntry("ms", "2.0.1"),
    "node_modules/debug": lockEntry("debug", "4.3.4", {dependencies: {ms: "2.0.1"}}),
  })

  test("root specs and installed entries are reported; workspace entries are fields", async () => {
    const result = await resolver().resolveConflicts(conflicted(ours, theirs))
    assert.equal(result.resolved, true, result.errors.join(", "))
    assert.deepEqual(brief(result.packageConflicts), [
      "lodash root › dependencies: ^4.17.20 | ^4.17.21 -> ^4.17.21 (highest)",
      "@scope/pkg root › dependencies: ^1.0.0 | ^1.1.0 -> ^1.1.0 (highest)",
      "ms root › devDependencies: 2.1.2 | 2.1.3 -> 2.1.3 (highest)",
      "lodash node_modules/lodash: 4.17.20 | 4.17.21 -> 4.17.21 (highest)",
      "@scope/pkg node_modules/@scope/pkg: 1.0.0 | 1.1.0 -> 1.1.0 (highest)",
      "ms node_modules/ms: 2.1.2 | 2.1.3 -> 2.1.3 (highest)",
      "ms node_modules/debug/node_modules/ms: 2.0.0 | 2.0.1 -> 2.0.1 (highest)",
    ])
    // The workspace's own version is not a package conflict
    const workspace = result.conflicts.find(conflict => conflict.field === "packages.packages/web")
    assert(workspace, "the workspace entry is still a conflict")
    assert.equal(workspace.package, undefined)
  })

  test("the dependencies of an installed package are its own manifest, never picked", async () => {
    const result = await resolver({picks: {ms: "2.1.3"}}).resolveConflicts(conflicted(ours, theirs))
    assert.deepEqual(result.packageJson?.packages["node_modules/debug"].dependencies, {ms: "2.0.1"})
    assert(!result.packageConflicts?.some(conflict => conflict.path.includes("node_modules/debug")))
  })

  test("a workspace entry's dependency specs are the project's", async () => {
    const result = await resolver().resolveConflicts(
      conflicted(
        lockfile({"packages/web": {name: "web", dependencies: {left: "^1.0.0"}}}),
        lockfile({"packages/web": {name: "web", dependencies: {left: "^1.1.0"}}})
      )
    )
    assert.deepEqual(brief(result.packageConflicts), [
      "left packages/web › dependencies: ^1.0.0 | ^1.1.0 -> ^1.1.0 (highest)",
    ])
  })

  test("a locked entry keeps the side that satisfies the pick, whatever the strategy prefers", async () => {
    const result = await resolver({picks: {lodash: "4.17.20", "@scope/pkg": "^1.1.0"}}).resolveConflicts(
      conflicted(ours, theirs)
    )
    const packages = result.packageJson?.packages
    assert.deepEqual(packages["node_modules/lodash"], lockEntry("lodash", "4.17.20"), "ours, despite highest")
    assert.deepEqual(packages["node_modules/@scope/pkg"], lockEntry("pkg", "1.1.0"))
    assert.deepEqual(packages[""].dependencies, {lodash: "4.17.20", "@scope/pkg": "^1.1.0"})

    const lodash = result.packageConflicts?.find(c => c.path[1] === "node_modules/lodash")
    assert.equal(lodash?.resolvedBy, "pick")
    assert.equal(lodash?.pick, "4.17.20")
    assert.equal(result.conflicts.find(conflict => conflict.field === "packages.node_modules/lodash")?.strategy, "pick")
  })

  test("the theirs side is kept when only it satisfies the pick", async () => {
    const result = await resolver({strategy: "ours", picks: {ms: "2.1.3"}}).resolveConflicts(conflicted(ours, theirs))
    assert.equal(result.packageJson?.packages["node_modules/ms"].version, "2.1.3")
    // The nested copy matches neither side of the pick: the strategy decides it
    assert.equal(result.packageJson?.packages["node_modules/debug/node_modules/ms"].version, "2.0.0")
    const nested = result.packageConflicts?.find(c => c.location === "node_modules/debug/node_modules/ms")
    assert.equal(nested?.resolvedBy, "ours")
    assert.equal(nested?.pick, "2.1.3")
  })

  test("when both sides satisfy a range pick, the strategy chooses between them", async () => {
    const result = await resolver({strategy: "lowest", picks: {lodash: "^4.17.0"}}).resolveConflicts(
      conflicted(ours, theirs)
    )
    assert.equal(result.packageJson?.packages["node_modules/lodash"].version, "4.17.20")
    const lock = result.packageConflicts?.find(c => c.kind === "lock" && c.name === "lodash")
    assert.equal(lock?.resolvedBy, "pick", "the pick is honored either way")
  })

  test("a pick neither side satisfies leaves the entry to the strategy and the spec to the pick", async () => {
    const result = await resolver({picks: {lodash: "4.17.22"}}).resolveConflicts(conflicted(ours, theirs))
    assert.equal(result.packageJson?.packages["node_modules/lodash"].version, "4.17.21")
    assert.equal(result.packageJson?.packages[""].dependencies.lodash, "4.17.22")
    const lock = result.packageConflicts?.find(c => c.kind === "lock" && c.name === "lodash")
    assert.equal(lock?.resolvedBy, "highest")
    assert.equal(lock?.pick, "4.17.22")
  })

  test("an alias pick selects the entry of the aliased package", async () => {
    const result = await resolver({picks: {"my-lodash": "npm:lodash@^4.17.21"}}).resolveConflicts(
      conflicted(
        lockfile({"node_modules/my-lodash": lockEntry("lodash", "4.17.21", {name: "lodash"})}),
        lockfile({"node_modules/my-lodash": lockEntry("lodash-es", "4.17.22", {name: "lodash-es"})})
      )
    )
    assert.equal(result.packageJson?.packages["node_modules/my-lodash"].name, "lodash")
  })

  test("the base entry's version is reported in a three-way merge", async () => {
    const result = await resolver().mergeJsonContents(
      JSON.stringify(lockfile({"node_modules/lodash": lockEntry("lodash", "4.17.15")})),
      JSON.stringify(lockfile({"node_modules/lodash": lockEntry("lodash", "4.17.20")})),
      JSON.stringify(lockfile({"node_modules/lodash": lockEntry("lodash", "4.17.21")}))
    )
    assert.equal(result.packageConflicts?.[0]?.base, "4.17.15")
  })

  test("entries without a version are shown by what they point at", async () => {
    const result = await resolver().resolveConflicts(
      conflicted(
        lockfile({
          "node_modules/web": {resolved: "packages/web", link: true},
          "node_modules/odd": {integrity: "sha512-a"},
        }),
        lockfile({
          "node_modules/web": {resolved: "apps/web", link: true},
          "node_modules/odd": {integrity: "sha512-b"},
        })
      )
    )
    assert.deepEqual(brief(result.packageConflicts), [
      "web node_modules/web: packages/web | apps/web -> packages/web (highest)",
      "odd node_modules/odd: (no version) | (no version) -> (no version) (highest)",
    ])
  })

  test("a malformed install key and a base that is not an entry are handled", async () => {
    const result = await resolver().mergeJsonContents(
      JSON.stringify(lockfile({"node_modules/": "not an entry", "node_modules/a": "not an entry"})),
      JSON.stringify(lockfile({"node_modules/": lockEntry("x", "1.0.0"), "node_modules/a": lockEntry("a", "1.0.0")})),
      JSON.stringify(lockfile({"node_modules/": lockEntry("x", "2.0.0"), "node_modules/a": lockEntry("a", "2.0.0")}))
    )
    assert.deepEqual(brief(result.packageConflicts), ["a node_modules/a: 1.0.0 | 2.0.0 -> 2.0.0 (highest)"])
    assert.equal(result.packageConflicts?.[0]?.base, undefined)
  })
})

describe("package conflicts in older lockfile formats", () => {
  test("lockfile v1: entries at any depth, with install-style locations; requires ranges are no specs", async () => {
    const v1 = (lodash: string, nested: string, requires: string) => ({
      name: "app",
      lockfileVersion: 1,
      requires: true,
      dependencies: {
        lodash: lockEntry("lodash", lodash),
        debug: {
          ...lockEntry("debug", "4.3.4"),
          requires: {ms: requires},
          dependencies: {ms: lockEntry("ms", nested)},
        },
      },
    })
    const result = await resolver({picks: {ms: "2.0.0"}}).resolveConflicts(
      conflicted(v1("4.17.20", "2.0.0", "2.0.0"), v1("4.17.21", "2.1.0", "^2.1.0"))
    )
    assert.equal(result.resolved, true, result.errors.join(", "))
    assert.deepEqual(brief(result.packageConflicts), [
      "lodash node_modules/lodash: 4.17.20 | 4.17.21 -> 4.17.21 (highest)",
      "ms node_modules/debug/node_modules/ms: 2.0.0 | 2.1.0 -> 2.0.0 (pick)",
    ])
    // requires holds debug's own ranges: the strategy decides, not the pick
    const merged = result.packageJson as any
    assert.equal(merged.dependencies.debug.requires.ms, "^2.1.0")
    assert.equal(merged.dependencies.debug.dependencies.ms.version, "2.0.0")
  })

  test("lockfile v2: the legacy section follows the pick but is not listed twice", async () => {
    const v2 = (version: string) => ({
      name: "app",
      lockfileVersion: 2,
      requires: true,
      packages: {"": {dependencies: {lodash: "^4.17.0"}}, "node_modules/lodash": lockEntry("lodash", version)},
      dependencies: {lodash: lockEntry("lodash", version)},
    })
    const result = await resolver({picks: {lodash: "4.17.20"}}).resolveConflicts(
      conflicted(v2("4.17.20"), v2("4.17.21"))
    )
    assert.deepEqual(brief(result.packageConflicts), [
      "lodash node_modules/lodash: 4.17.20 | 4.17.21 -> 4.17.20 (pick)",
    ])
    assert.equal((result.packageJson as any).dependencies.lodash.version, "4.17.20")
    const legacy = result.conflicts.find(conflict => conflict.field === "dependencies.lodash")
    assert.equal(legacy?.package, "lodash")
    assert.equal(legacy?.strategy, "pick")
  })
})

/**
 * The fallback only runs when a side cannot be parsed even leniently: a
 * missing comma is repaired, so these sides carry a doubled comma (",,").
 */
describe("package conflicts in the block-based fallback (a side that is not valid JSON)", () => {
  test("entries of a dependency field are specs of that field", async () => {
    const content = [
      "{",
      '  "name": "app",',
      '  "devDependencies": {',
      "<<<<<<< HEAD",
      '    "typescript": "~5.4.0",,',
      '    "vitest": "^1.0.0"',
      "=======",
      '    "typescript": "~5.6.2",',
      '    "vitest": "^1.6.0"',
      ">>>>>>> feature",
      "  }",
      "}",
    ].join("\n")
    const result = await resolver({picks: {typescript: "~5.5.4"}}).resolveConflicts(content)
    assert.equal(result.resolved, true, result.errors.join(", "))
    assert.equal(result.conflicts[0]?.field, "dependencies", "resolved block by block")
    assert.deepEqual(result.packageJson?.devDependencies, {typescript: "~5.5.4", vitest: "^1.6.0"})
    assert.deepEqual(brief(result.packageConflicts), [
      "typescript devDependencies: ~5.4.0 | ~5.6.2 -> ~5.5.4 (pick)",
      "vitest devDependencies: ^1.0.0 | ^1.6.0 -> ^1.6.0 (highest)",
    ])
    assert.deepEqual(result.packageConflicts?.[0]?.path, ["devDependencies", "typescript"])
    // Two packages, one picked: the block as a whole is the strategy's, and about no single package
    assert.equal(result.conflicts[0]?.strategy, "highest")
    assert.equal(result.conflicts[0]?.package, undefined)
  })

  test("a block where every conflict was picked is the pick's, and names its single package", async () => {
    const content = [
      "{",
      '  "dependencies": {',
      "<<<<<<< HEAD",
      '    "lodash": "^4.17.19",,',
      '    "react": "^18.2.0"',
      "=======",
      '    "lodash": "^4.17.21",',
      '    "react": "^18.2.0"',
      ">>>>>>> feature",
      "  }",
      "}",
    ].join("\n")
    const result = await resolver({picks: {lodash: "4.17.20"}}).resolveConflicts(content)
    assert.equal(result.conflicts[0]?.field, "dependencies", "resolved block by block")
    assert.deepEqual(result.packageJson?.dependencies, {lodash: "4.17.20", react: "^18.2.0"})
    assert.equal(result.conflicts[0]?.strategy, "pick")
    assert.equal(result.conflicts[0]?.package, "lodash")
  })

  test("a conflict that declares the whole field is still that field", async () => {
    const content = [
      "{",
      "<<<<<<< HEAD",
      '  "dependencies": {',
      '    "lodash": "^4.17.19",,',
      '    "express": "^4.18.0"',
      "  }",
      "=======",
      '  "dependencies": {',
      '    "lodash": "^4.17.21"',
      "  }",
      ">>>>>>> feature",
      "}",
    ].join("\n")
    const result = await resolver({picks: {lodash: "^4.17.20"}}).resolveConflicts(content)
    assert.equal(result.conflicts[0]?.field, "dependencies", "resolved block by block")
    assert.deepEqual(result.packageJson?.dependencies, {lodash: "^4.17.20", express: "^4.18.0"})
    assert.deepEqual(brief(result.packageConflicts), ["lodash dependencies: ^4.17.19 | ^4.17.21 -> ^4.17.20 (pick)"])
  })

  test("scripts are not packages, even when a script shares a picked name", async () => {
    const content = [
      "{",
      '  "scripts": {',
      "<<<<<<< HEAD",
      '    "lint": "eslint .",,',
      '    "test": "node --test"',
      "=======",
      '    "lint": "eslint src"',
      ">>>>>>> feature",
      "  }",
      "}",
    ].join("\n")
    const result = await resolver({strategy: "ours", picks: {lint: "1.0.0"}}).resolveConflicts(content)
    assert.notEqual(result.conflicts[0]?.field, "scripts.lint", "resolved block by block")
    // Commands are no versions: the strategy keeps ours, and the pick is not applied
    assert.equal(result.packageJson?.scripts?.lint, "eslint .")
    assert.deepEqual(result.packageConflicts, [])
    assert.equal(result.conflicts[0]?.package, undefined)
  })

  test("entries are not specs when the surrounding structure cannot be followed", async () => {
    // A dependencies object inside an array has no path a pick could name
    const content = [
      "{",
      '  "configs": [',
      "    {",
      '      "dependencies": {',
      "<<<<<<< HEAD",
      '        "lodash": "^4.17.19",,',
      '        "react": "^18.2.0"',
      "=======",
      '        "lodash": "^4.17.21"',
      ">>>>>>> feature",
      "      }",
      "    }",
      "  ]",
      "}",
    ].join("\n")
    const result = await resolver({picks: {lodash: "4.17.20"}}).resolveConflicts(content)
    assert.equal(result.resolved, true, result.errors.join(", "))
    assert.equal(result.packageJson?.configs[0].dependencies.lodash, "^4.17.21", "the strategy decided")
    assert.deepEqual(result.packageConflicts, [])
  })

  test("the lockfile root entry's dependencies are specs, an installed package's are not", async () => {
    const content = (where: string) =>
      [
        "{",
        '  "lockfileVersion": 3,',
        '  "packages": {',
        `    "${where}": {`,
        '      "dependencies": {',
        "<<<<<<< HEAD",
        '        "ms": "2.1.2",,',
        '        "debug": "^4.3.0"',
        "=======",
        '        "ms": "2.1.3"',
        ">>>>>>> feature",
        "      }",
        "    }",
        "  }",
        "}",
      ].join("\n")

    const root = await resolver({picks: {ms: "2.1.2"}}).resolveConflicts(content(""))
    assert.equal(root.conflicts[0]?.field, "dependencies", "resolved block by block")
    const rootLock = root.packageJson as any
    assert.equal(rootLock.packages[""].dependencies.ms, "2.1.2")
    assert.deepEqual(brief(root.packageConflicts), ["ms root › dependencies: 2.1.2 | 2.1.3 -> 2.1.2 (pick)"])

    const installed = await resolver({picks: {ms: "2.1.2"}}).resolveConflicts(content("node_modules/debug"))
    assert.equal((installed.packageJson as any).packages["node_modules/debug"].dependencies.ms, "2.1.3")
    assert.deepEqual(installed.packageConflicts, [])
  })

  const lockWithEntryConflict = (ours: string[], theirs: string[]) =>
    [
      "{",
      '  "lockfileVersion": 3,',
      '  "packages": {',
      "<<<<<<< HEAD",
      ...ours,
      "=======",
      ...theirs,
      ">>>>>>> feature",
      "  }",
      "}",
    ].join("\n")

  /** A whole node_modules/lodash entry; `broken` doubles a comma so the side cannot be parsed */
  const wholeEntry = (version: string, broken = false) => [
    '    "node_modules/lodash": {',
    `      "version": "${version}",${broken ? "," : ""}`,
    `      "resolved": "https://registry.npmjs.org/lodash/-/lodash-${version}.tgz",`,
    `      "integrity": "sha512-${version}"`,
    "    }",
  ]

  test("a whole lockfile entry keeps the side that satisfies the pick", async () => {
    const content = lockWithEntryConflict(wholeEntry("4.17.21", true), wholeEntry("4.17.20"))
    const result = await resolver({picks: {lodash: "4.17.20"}}).resolveConflicts(content)
    assert.equal(result.resolved, true, result.errors.join(", "))
    assert.equal(result.conflicts[0]?.verbatim, true, "resolved block by block")
    assert.equal((result.packageJson as any).packages["node_modules/lodash"].version, "4.17.20")
    assert.deepEqual(brief(result.packageConflicts), [
      "lodash node_modules/lodash: 4.17.21 | 4.17.20 -> 4.17.20 (pick)",
    ])
    assert.equal(result.conflicts[0]?.strategy, "pick")
    assert.equal(result.conflicts[0]?.package, "lodash")
  })

  test("without a pick the strategy still decides a whole entry, and it is listed", async () => {
    const content = lockWithEntryConflict(wholeEntry("4.17.21", true), wholeEntry("4.17.20"))
    const result = await resolver({strategy: "lowest"}).resolveConflicts(content)
    assert.equal((result.packageJson as any).packages["node_modules/lodash"].version, "4.17.20")
    assert.deepEqual(brief(result.packageConflicts), [
      "lodash node_modules/lodash: 4.17.21 | 4.17.20 -> 4.17.20 (lowest)",
    ])
    assert.equal(result.conflicts[0]?.strategy, "lowest")
  })

  test("a conflict inside an entry keeps the side that satisfies the pick", async () => {
    const content = [
      "{",
      '  "lockfileVersion": 3,',
      '  "packages": {',
      '    "node_modules/@scope/pkg": {',
      "<<<<<<< HEAD",
      '      "version": "1.1.0",,',
      '      "integrity": "sha512-ours"',
      "=======",
      '      "version": "1.0.0",',
      '      "integrity": "sha512-theirs"',
      ">>>>>>> feature",
      "    }",
      "  }",
      "}",
    ].join("\n")
    const result = await resolver({picks: {"@scope/pkg": "~1.0.0"}}).resolveConflicts(content)
    assert.equal(result.resolved, true, result.errors.join(", "))
    assert.equal(result.conflicts[0]?.verbatim, true, "resolved block by block")
    assert.deepEqual((result.packageJson as any).packages["node_modules/@scope/pkg"], {
      version: "1.0.0",
      integrity: "sha512-theirs",
    })
    assert.deepEqual(brief(result.packageConflicts), [
      "@scope/pkg node_modules/@scope/pkg: 1.1.0 | 1.0.0 -> 1.0.0 (pick)",
    ])
  })

  test("a fallback pick matched by both sides, or by neither, leaves the strategy in charge", async () => {
    // The strategy keeps ours here, so theirs is the side that cannot be parsed
    const both = await resolver({picks: {lodash: "^4.17.0"}}).resolveConflicts(
      lockWithEntryConflict(wholeEntry("4.17.21"), wholeEntry("4.17.20", true))
    )
    assert.equal((both.packageJson as any).packages["node_modules/lodash"].version, "4.17.21")
    assert.equal(both.packageConflicts?.[0]?.resolvedBy, "pick", "the entry kept satisfies the pick")
    assert.equal(both.conflicts[0]?.strategy, "pick")

    const neither = await resolver({picks: {lodash: "4.17.22"}}).resolveConflicts(
      lockWithEntryConflict(wholeEntry("4.17.21"), wholeEntry("4.17.20", true))
    )
    assert.equal((neither.packageJson as any).packages["node_modules/lodash"].version, "4.17.21")
    assert.equal(neither.packageConflicts?.[0]?.resolvedBy, "highest")
    assert.equal(neither.packageConflicts?.[0]?.pick, "4.17.22")
    assert.equal(neither.conflicts[0]?.strategy, "highest")
  })

  /**
   * A lockfile with an entry conflict, plus a "version" conflict whose ours
   * side cannot be parsed: it sends every conflict of the file to the
   * fallback, and loses to theirs under the highest strategy.
   */
  const lockWithBrokenVersion = (ours: string[], theirs: string[]) =>
    [
      "{",
      "<<<<<<< HEAD",
      '  "version": "1.0.0",,',
      "=======",
      '  "version": "2.0.0",',
      ">>>>>>> feature",
      '  "lockfileVersion": 3,',
      '  "packages": {',
      "<<<<<<< HEAD",
      ...ours,
      "=======",
      ...theirs,
      ">>>>>>> feature",
      "  }",
      "}",
    ].join("\n")

  test("an entry added on one side only is no package conflict", async () => {
    const content = lockWithBrokenVersion(wholeEntry("4.17.21"), [])
    const result = await resolver({picks: {lodash: "4.17.20"}}).resolveConflicts(content)
    assert.equal(result.resolved, true, result.errors.join(", "))
    assert.equal(result.conflicts[1]?.verbatim, true, "resolved block by block")
    assert.equal((result.packageJson as any).packages["node_modules/lodash"].version, "4.17.21")
    assert.equal(result.packageJson?.version, "2.0.0")
    assert.deepEqual(result.packageConflicts, [])
    assert.equal(result.conflicts[1]?.package, undefined)
  })

  test("an entry whose sides only differ in formatting is no package conflict", async () => {
    const reordered = [
      '    "node_modules/lodash": {',
      '      "integrity": "sha512-4.17.21",',
      '      "resolved": "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz",',
      '      "version": "4.17.21"',
      "    }",
    ]
    const result = await resolver().resolveConflicts(lockWithBrokenVersion(reordered, wholeEntry("4.17.21")))
    assert.equal(result.resolved, true, result.errors.join(", "))
    assert.equal(result.conflicts[1]?.verbatim, true, "resolved block by block")
    assert.deepEqual(result.packageConflicts, [])
    assert.equal(result.conflicts[1]?.package, "lodash", "still about lodash")
  })

  test("v1 entries in the fallback are located like installs", async () => {
    const v1Entry = (version: string, broken = false) => [
      '    "lodash": {',
      `      "version": "${version}",${broken ? "," : ""}`,
      `      "integrity": "sha512-${version}"`,
      "    }",
    ]
    const content = [
      "{",
      '  "lockfileVersion": 1,',
      '  "dependencies": {',
      "<<<<<<< HEAD",
      ...v1Entry("4.17.21", true),
      "=======",
      ...v1Entry("4.17.20"),
      ">>>>>>> feature",
      "  }",
      "}",
    ].join("\n")
    const result = await resolver({picks: {lodash: "4.17.20"}}).resolveConflicts(content)
    assert.equal(result.conflicts[0]?.verbatim, true, "resolved block by block")
    assert.equal((result.packageJson as any).dependencies.lodash.version, "4.17.20")
    assert.deepEqual(brief(result.packageConflicts), [
      "lodash node_modules/lodash: 4.17.21 | 4.17.20 -> 4.17.20 (pick)",
    ])
  })

  test("v2's legacy section is resolved in the fallback but not listed", async () => {
    const content = [
      "{",
      '  "lockfileVersion": 2,',
      '  "packages": {},',
      '  "dependencies": {',
      "<<<<<<< HEAD",
      '    "lodash": {',
      '      "version": "4.17.21",,',
      '      "integrity": "sha512-a"',
      "    }",
      "=======",
      '    "lodash": {',
      '      "version": "4.17.20",',
      '      "integrity": "sha512-b"',
      "    }",
      ">>>>>>> feature",
      "  }",
      "}",
    ].join("\n")
    const result = await resolver({picks: {lodash: "4.17.20"}}).resolveConflicts(content)
    assert.equal((result.packageJson as any).dependencies.lodash.version, "4.17.20")
    assert.deepEqual(result.packageConflicts, [])
    assert.equal(result.conflicts[0]?.package, "lodash")
  })

  test("a compound conflict outside any entry is no package conflict", async () => {
    const content = [
      "{",
      "<<<<<<< HEAD",
      '  "version": "1.1.0",,',
      '  "description": "ours"',
      "=======",
      '  "version": "1.2.0",',
      '  "description": "theirs"',
      ">>>>>>> feature",
      "}",
    ].join("\n")
    const result = await resolver().resolveConflicts(content)
    assert.equal(result.resolved, true, result.errors.join(", "))
    assert.equal(result.conflicts[0]?.verbatim, true, "resolved block by block")
    assert.deepEqual(result.packageConflicts, [])
    assert.equal(result.conflicts[0]?.package, undefined)
  })

  test("an entry that cannot be placed in the document is no package conflict", async () => {
    // Inside an array, the entry has no path a pick could name
    const content = [
      "{",
      '  "lockfileVersion": 3,',
      '  "entries": [',
      "    {",
      "<<<<<<< HEAD",
      '      "version": "1.1.0",',
      '      "integrity": "sha512-ours"',
      "=======",
      '      "version": "1.0.0",,',
      '      "integrity": "sha512-theirs"',
      ">>>>>>> feature",
      "    }",
      "  ]",
      "}",
    ].join("\n")
    const result = await resolver({picks: {x: "1.0.0"}}).resolveConflicts(content)
    assert.equal(result.resolved, true, result.errors.join(", "))
    assert.equal(result.conflicts[0]?.verbatim, true, "resolved block by block")
    assert.equal(result.packageJson?.entries[0].version, "1.1.0")
    assert.deepEqual(result.packageConflicts, [])
  })

  test("an entry one side holds as something else than an object is skipped", async () => {
    const content = lockWithEntryConflict(['    "node_modules/x": [1, 2]'], ['    "node_modules/x": [1,,2]'])
    const result = await resolver({picks: {x: "1.0.0"}}).resolveConflicts(content)
    assert.equal(result.resolved, true, result.errors.join(", "))
    assert.equal(result.conflicts[0]?.verbatim, true, "resolved block by block")
    assert.deepEqual(result.packageConflicts, [])
    assert.equal(result.conflicts[0]?.package, undefined)
  })
})
