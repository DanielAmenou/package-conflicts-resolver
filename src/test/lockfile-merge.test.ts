/**
 * Lockfile merge tests: every way a merged package-lock.json could end up
 * inconsistent (root spec vs locked version, mixed resolved/integrity,
 * strategy overriding one-sided changes, pre-release desync) and the
 * consistency report attached to merge results.
 */

import {strict as assert} from "assert"
import {test, describe} from "node:test"
import {PackageResolver} from "../package-resolver.js"
import {CliOptions} from "../types.js"

function makeResolver(strategy: CliOptions["strategy"] = "highest"): PackageResolver {
  return new PackageResolver({strategy, dryRun: true, quiet: true, json: false, verbose: false, regenerateLock: false})
}

const j = (value: unknown) => JSON.stringify(value)

const entry = (name: string, version: string, extra: Record<string, any> = {}) => ({
  version,
  resolved: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
  integrity: `sha512-${name}-${version}`,
  ...extra,
})

const lock = (rootDeps: Record<string, string>, packages: Record<string, any>) =>
  j({
    name: "app",
    version: "1.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: {"": {name: "app", version: "1.0.0", dependencies: rootDeps}, ...packages},
  })

describe("Three-way merge keeps root specs and locked entries in sync", () => {
  test("a version pinned by one branch only survives the highest strategy", async () => {
    // main only bumped bar; feature deliberately pinned foo to a lower version
    const base = lock(
      {foo: "^1.5.0", bar: "^1.0.0"},
      {"node_modules/foo": entry("foo", "1.5.0"), "node_modules/bar": entry("bar", "1.0.0")}
    )
    const ours = lock(
      {foo: "^1.5.0", bar: "^1.1.0"},
      {"node_modules/foo": entry("foo", "1.5.0"), "node_modules/bar": entry("bar", "1.1.0")}
    )
    const theirs = lock(
      {foo: "1.2.0", bar: "^1.0.0"},
      {"node_modules/foo": entry("foo", "1.2.0"), "node_modules/bar": entry("bar", "1.0.0")}
    )

    const result = await makeResolver("highest").mergeJsonContents(base, ours, theirs)
    assert.equal(result.resolved, true)

    const packages = result.packageJson!.packages
    assert.equal(packages[""].dependencies.foo, "1.2.0", "their one-sided pin must not be overridden by the strategy")
    assert.equal(packages["node_modules/foo"].version, "1.2.0")
    assert.equal(packages[""].dependencies.bar, "^1.1.0", "our one-sided bump is kept too")
    assert.equal(packages["node_modules/bar"].version, "1.1.0")
    assert.deepEqual(result.lockfileIssues, [], "the merged lockfile is consistent")
  })

  test("the strategy only decides fields both branches changed", async () => {
    const base = j({dependencies: {foo: "^1.0.0", bar: "^1.0.0"}})
    const ours = j({dependencies: {foo: "^1.0.0", bar: "^1.1.0"}}) // we changed bar
    const theirs = j({dependencies: {foo: "^2.0.0", bar: "^1.0.0"}}) // they changed foo

    for (const strategy of ["highest", "lowest", "ours", "theirs"] as const) {
      const result = await makeResolver(strategy).mergeJsonContents(base, ours, theirs)
      assert.deepEqual(
        result.packageJson!.dependencies,
        {foo: "^2.0.0", bar: "^1.1.0"},
        `${strategy}: each side's exclusive change must be kept`
      )
      assert.equal(result.conflicts.length, 0, `${strategy}: one-sided changes are not conflicts`)
    }
  })

  test("a field both branches changed differently is a real conflict resolved by the strategy", async () => {
    const base = j({dependencies: {foo: "^1.0.0"}})
    const ours = j({dependencies: {foo: "^1.5.0"}})
    const theirs = j({dependencies: {foo: "^2.0.0"}})

    const merged = async (strategy: CliOptions["strategy"]) =>
      (await makeResolver(strategy).mergeJsonContents(base, ours, theirs)).packageJson!.dependencies!.foo

    assert.equal(await merged("highest"), "^2.0.0")
    assert.equal(await merged("lowest"), "^1.5.0")
    assert.equal(await merged("ours"), "^1.5.0")
    assert.equal(await merged("theirs"), "^2.0.0")
  })

  test("a root version bumped on one branch only is kept even under 'ours'", async () => {
    const base = j({name: "app", version: "1.0.0", description: "a"})
    const ours = j({name: "app", version: "1.0.0", description: "b"})
    const theirs = j({name: "app", version: "1.1.0", description: "a"})

    const result = await makeResolver("ours").mergeJsonContents(base, ours, theirs)
    assert.equal(result.packageJson!.version, "1.1.0")
    assert.equal(result.packageJson!.description, "b")
  })

  test("a dev flag removed by the branch that promoted a dependency is honored", async () => {
    const base = lock({}, {"node_modules/foo": entry("foo", "1.0.0", {dev: true})})
    const ours = lock({}, {"node_modules/foo": entry("foo", "1.0.0", {dev: true, license: "MIT"})})
    const theirs = lock({foo: "^1.0.0"}, {"node_modules/foo": entry("foo", "1.0.0")}) // moved to dependencies

    const result = await makeResolver("highest").mergeJsonContents(base, ours, theirs)
    const foo = result.packageJson!.packages["node_modules/foo"]
    assert.equal(foo.dev, undefined, "dev flag removed on one side stays removed")
    assert.equal(foo.license, "MIT", "unrelated addition on the other side is kept")
  })
})

describe("Lock entries are atomic", () => {
  test("same version but different resolved/integrity never get mixed", async () => {
    // Chosen so a field-by-field lexicographic merge would pair resolved
    // from one side with integrity from the other
    const ours = lock(
      {foo: "github:u/foo#a1"},
      {
        "node_modules/foo": {
          version: "1.0.0",
          resolved: "git+ssh://git@github.com/u/foo.git#aaaa",
          integrity: "sha512-ZZZZ",
        },
      }
    )
    const theirs = lock(
      {foo: "github:u/foo#b2"},
      {
        "node_modules/foo": {
          version: "1.0.0",
          resolved: "git+ssh://git@github.com/u/foo.git#bbbb",
          integrity: "sha512-AAAA",
        },
      }
    )

    const highest = (await makeResolver("highest").mergeJsonContents("", ours, theirs)).packageJson!.packages[
      "node_modules/foo"
    ]
    assert.deepEqual(highest, {
      version: "1.0.0",
      resolved: "git+ssh://git@github.com/u/foo.git#aaaa",
      integrity: "sha512-ZZZZ",
    })

    const theirsWins = (await makeResolver("theirs").mergeJsonContents("", ours, theirs)).packageJson!.packages[
      "node_modules/foo"
    ]
    assert.deepEqual(theirsWins, {
      version: "1.0.0",
      resolved: "git+ssh://git@github.com/u/foo.git#bbbb",
      integrity: "sha512-AAAA",
    })
  })

  test("a field present on one side only is filled in, not treated as a conflict", async () => {
    const ours = lock({}, {"node_modules/foo": {version: "1.0.0", resolved: "https://r/foo-1.0.0.tgz"}})
    const theirs = lock(
      {},
      {
        "node_modules/foo": {
          version: "1.0.0",
          resolved: "https://r/foo-1.0.0.tgz",
          integrity: "sha512-x",
          license: "MIT",
        },
      }
    )

    const result = await makeResolver("highest").mergeJsonContents("", ours, theirs)
    assert.deepEqual(result.packageJson!.packages["node_modules/foo"], {
      version: "1.0.0",
      resolved: "https://r/foo-1.0.0.tgz",
      integrity: "sha512-x",
      license: "MIT",
    })
    assert.equal(result.conflicts.length, 0)
  })

  test("entries under 'packages' are atomic even without resolved/integrity (bundled packages)", async () => {
    const ours = lock(
      {},
      {"node_modules/foo/node_modules/bar": {version: "1.0.0", inBundle: true, dependencies: {baz: "^1.0.0"}}}
    )
    const theirs = lock(
      {},
      {
        "node_modules/foo/node_modules/bar": {
          version: "2.0.0",
          inBundle: true,
          dependencies: {baz: "^2.0.0", qux: "^1.0.0"},
        },
      }
    )

    const result = await makeResolver("highest").mergeJsonContents("", ours, theirs)
    assert.deepEqual(result.packageJson!.packages["node_modules/foo/node_modules/bar"], {
      version: "2.0.0",
      inBundle: true,
      dependencies: {baz: "^2.0.0", qux: "^1.0.0"},
    })
  })

  test("workspace links pointing at different folders are not merged field by field", async () => {
    const ours = lock({}, {"node_modules/@app/ui": {resolved: "packages/ui", link: true}})
    const theirs = lock({}, {"node_modules/@app/ui": {resolved: "libs/ui", link: true}})

    const result = await makeResolver("theirs").mergeJsonContents("", ours, theirs)
    assert.deepEqual(result.packageJson!.packages["node_modules/@app/ui"], {resolved: "libs/ui", link: true})
  })

  test("lockfile v2 legacy 'dependencies' entries stay atomic and 'requires' ranges use semver", async () => {
    const v2 = (fooVersion: string, requires: Record<string, string>, barVersion: string) =>
      j({
        name: "app",
        lockfileVersion: 2,
        requires: true,
        packages: {"": {name: "app"}, "node_modules/foo": entry("foo", fooVersion, {dependencies: requires})},
        dependencies: {
          foo: {...entry("foo", fooVersion), requires},
          bar: entry("bar", barVersion),
        },
      })

    const ours = v2("1.0.0", {bar: "^1.9.0"}, "1.9.0")
    const theirs = v2("1.0.0", {bar: "^1.10.0"}, "1.10.0")

    const result = await makeResolver("highest").mergeJsonContents("", ours, theirs)
    const legacy = (result.packageJson as any).dependencies
    // Lexicographically "^1.9.0" > "^1.10.0"; semver says the opposite
    assert.equal(legacy.foo.requires.bar, "^1.10.0")
    assert.equal(legacy.bar.version, "1.10.0")
    assert.equal(legacy.bar.integrity, "sha512-bar-1.10.0")
    assert.equal(result.packageJson!.packages["node_modules/foo"].dependencies.bar, "^1.10.0")
  })

  test("engines and packageManager specs are compared as versions", async () => {
    const ours = j({engines: {node: ">=8"}, packageManager: "npm@9.9.9"})
    const theirs = j({engines: {node: ">=16"}, packageManager: "npm@10.2.0"})

    const result = await makeResolver("highest").mergeJsonContents("", ours, theirs)
    // Lexicographically ">=8" > ">=16" and "npm@9.9.9" > "npm@10.2.0"
    assert.equal(result.packageJson!.engines!.node, ">=16")
    assert.equal(result.packageJson!.packageManager, "npm@10.2.0")
  })
})

describe("Pre-release handling is consistent between package.json and the lockfile", () => {
  test("a stable version beats a pre-release for ranges as well as exact versions", async () => {
    const pkgOurs = j({dependencies: {foo: "2.0.0-beta.1"}})
    const pkgTheirs = j({dependencies: {foo: "^1.9.0"}})
    const packageJson = await makeResolver("highest").mergeJsonContents("", pkgOurs, pkgTheirs)

    const lockOurs = lock({foo: "2.0.0-beta.1"}, {"node_modules/foo": entry("foo", "2.0.0-beta.1")})
    const lockTheirs = lock({foo: "^1.9.0"}, {"node_modules/foo": entry("foo", "1.9.0")})
    const lockfile = await makeResolver("highest").mergeJsonContents("", lockOurs, lockTheirs)

    assert.equal(packageJson.packageJson!.dependencies!.foo, "^1.9.0")
    assert.equal(lockfile.packageJson!.packages[""].dependencies.foo, "^1.9.0")
    assert.equal(lockfile.packageJson!.packages["node_modules/foo"].version, "1.9.0")
    assert.deepEqual(lockfile.lockfileIssues, [])
  })

  test("a pre-release still wins over an older pre-release, and a newer stable over an older stable", async () => {
    const lockOurs = lock({foo: "^2.0.0-beta.1"}, {"node_modules/foo": entry("foo", "2.0.0-beta.1")})
    const lockTheirs = lock({foo: "^2.0.0-beta.3"}, {"node_modules/foo": entry("foo", "2.0.0-beta.3")})

    const result = await makeResolver("highest").mergeJsonContents("", lockOurs, lockTheirs)
    assert.equal(result.packageJson!.packages[""].dependencies.foo, "^2.0.0-beta.3")
    assert.equal(result.packageJson!.packages["node_modules/foo"].version, "2.0.0-beta.3")
  })
})

describe("Lockfile consistency report", () => {
  test("a merge that leaves the root spec unsatisfied is reported", async () => {
    // Inherent to merging ranges and exact versions independently: the range
    // comparison picks the pin, the exact comparison picks the higher lock
    const ours = lock({foo: "^1.0.0"}, {"node_modules/foo": entry("foo", "1.5.0")})
    const theirs = lock({foo: "1.2.0"}, {"node_modules/foo": entry("foo", "1.2.0")})

    const result = await makeResolver("highest").mergeJsonContents("", ours, theirs)
    assert.equal(result.resolved, true)
    assert.equal(result.lockfileIssues!.length, 1)
    assert.equal(
      result.lockfileIssues![0]!.message,
      "the root project requires foo@1.2.0 but node_modules/foo is 1.5.0"
    )
  })

  test("a merge that breaks a transitive edge is reported", async () => {
    // Both branches bumped `a`; the higher `a` needs a lower `b` than the higher `b`
    const ours = lock(
      {a: "^2.0.0"},
      {"node_modules/a": entry("a", "2.0.0", {dependencies: {b: "^1.0.0"}}), "node_modules/b": entry("b", "1.5.0")}
    )
    const theirs = lock(
      {a: "^1.0.0"},
      {"node_modules/a": entry("a", "1.0.0", {dependencies: {b: "^2.0.0"}}), "node_modules/b": entry("b", "2.0.0")}
    )

    const result = await makeResolver("highest").mergeJsonContents("", ours, theirs)
    assert.equal(result.packageJson!.packages["node_modules/a"].version, "2.0.0")
    assert.equal(result.packageJson!.packages["node_modules/b"].version, "2.0.0")
    assert.deepEqual(
      result.lockfileIssues!.map(issue => issue.message),
      ["node_modules/a requires b@^1.0.0 but node_modules/b is 2.0.0"]
    )
  })

  test("problems that already existed in an input lockfile are not blamed on the merge", async () => {
    // Our lockfile was already stale before the merge
    const ours = lock(
      {foo: "^2.0.0"},
      {"node_modules/foo": entry("foo", "1.5.0"), "node_modules/bar": entry("bar", "1.0.0")}
    )
    const theirs = lock(
      {foo: "^2.0.0"},
      {"node_modules/foo": entry("foo", "1.5.0"), "node_modules/bar": entry("bar", "1.1.0")}
    )

    const result = await makeResolver("highest").mergeJsonContents("", ours, theirs)
    assert.deepEqual(result.lockfileIssues, [])
  })

  test("package.json documents carry no lockfile report", async () => {
    const result = await makeResolver("highest").mergeJsonContents("", j({version: "1.0.0"}), j({version: "1.1.0"}))
    assert.equal(result.lockfileIssues, undefined)
  })

  test("the report is also produced when resolving conflict markers", async () => {
    const content = [
      "{",
      '  "name": "app",',
      '  "lockfileVersion": 3,',
      '  "packages": {',
      '    "": {',
      '      "dependencies": {',
      "<<<<<<< HEAD",
      '        "foo": "^1.0.0"',
      "=======",
      '        "foo": "1.2.0"',
      ">>>>>>> feature",
      "      }",
      "    },",
      '    "node_modules/foo": {',
      "<<<<<<< HEAD",
      '      "version": "1.5.0",',
      '      "resolved": "https://r/foo-1.5.0.tgz",',
      '      "integrity": "sha512-a"',
      "=======",
      '      "version": "1.2.0",',
      '      "resolved": "https://r/foo-1.2.0.tgz",',
      '      "integrity": "sha512-b"',
      ">>>>>>> feature",
      "    }",
      "  }",
      "}",
    ].join("\n")

    const result = await makeResolver("highest").resolveConflicts(content)
    assert.equal(result.resolved, true)
    assert.equal(result.packageJson!.packages["node_modules/foo"].version, "1.5.0")
    assert.equal(result.lockfileIssues!.length, 1)
    assert.equal(result.lockfileIssues![0]!.name, "foo")
  })
})

describe("Conflict markers from a textual merge", () => {
  test("a missing comma at a conflict boundary is repaired and merged semantically", async () => {
    // Our branch ended the "packages" object with foo; theirs added bar after
    // it. Git's line-based merge leaves our side without the comma it now needs.
    const content = [
      "{",
      '  "name": "app",',
      '  "lockfileVersion": 3,',
      '  "packages": {',
      '    "node_modules/foo": {',
      "<<<<<<< HEAD",
      '      "version": "1.1.0",',
      '      "resolved": "https://r/foo-1.1.0.tgz",',
      '      "integrity": "sha512-ours"',
      "    }",
      "=======",
      '      "version": "1.0.0",',
      '      "resolved": "https://r/foo-1.0.0.tgz",',
      '      "integrity": "sha512-base"',
      "    },",
      '    "node_modules/bar": {',
      '      "version": "2.0.0",',
      '      "resolved": "https://r/bar-2.0.0.tgz",',
      '      "integrity": "sha512-bar"',
      "    }",
      ">>>>>>> feature",
      "  }",
      "}",
    ].join("\n")

    const result = await makeResolver("highest").resolveConflicts(content)
    assert.equal(result.resolved, true, result.errors.join(", "))
    assert.deepEqual(result.packageJson!.packages, {
      "node_modules/foo": {version: "1.1.0", resolved: "https://r/foo-1.1.0.tgz", integrity: "sha512-ours"},
      "node_modules/bar": {version: "2.0.0", resolved: "https://r/bar-2.0.0.tgz", integrity: "sha512-bar"},
    })
    assert.equal(result.conflicts.length, 1, "only the foo entry was a real conflict")
  })

  test("a conflict inside a lock entry keeps version, resolved and integrity together", async () => {
    const content = [
      "{",
      '  "lockfileVersion": 3,',
      '  "packages": {',
      '    "node_modules/lodash": {',
      "<<<<<<< HEAD",
      '      "version": "4.17.21",',
      '      "resolved": "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz",',
      '      "integrity": "sha512-ours",',
      "=======",
      '      "version": "4.17.20",',
      '      "resolved": "https://registry.npmjs.org/lodash/-/lodash-4.17.20.tgz",',
      '      "integrity": "sha512-theirs",',
      ">>>>>>> feature",
      '      "license": "MIT"',
      "    }",
      "  }",
      "}",
    ].join("\n")

    const highest = await makeResolver("highest").resolveConflicts(content)
    assert.deepEqual(highest.packageJson!.packages["node_modules/lodash"], {
      version: "4.17.21",
      resolved: "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz",
      integrity: "sha512-ours",
      license: "MIT",
    })

    const lowest = await makeResolver("lowest").resolveConflicts(content)
    assert.deepEqual(lowest.packageJson!.packages["node_modules/lodash"], {
      version: "4.17.20",
      resolved: "https://registry.npmjs.org/lodash/-/lodash-4.17.20.tgz",
      integrity: "sha512-theirs",
      license: "MIT",
    })
  })

  test("diff3 markers give the lockfile merge a real base", async () => {
    // Ours never touched foo (equal to base); theirs downgraded it: theirs wins
    // and the root spec follows, so the result is consistent
    const content = [
      "{",
      '  "lockfileVersion": 3,',
      '  "packages": {',
      '    "": {',
      '      "dependencies": {',
      "<<<<<<< HEAD",
      '        "foo": "^1.5.0",',
      "||||||| base",
      '        "foo": "^1.5.0",',
      "=======",
      '        "foo": "1.2.0",',
      ">>>>>>> feature",
      '        "bar": "^1.0.0"',
      "      }",
      "    },",
      '    "node_modules/foo": {',
      "<<<<<<< HEAD",
      '      "version": "1.5.0",',
      '      "integrity": "sha512-a"',
      "||||||| base",
      '      "version": "1.5.0",',
      '      "integrity": "sha512-a"',
      "=======",
      '      "version": "1.2.0",',
      '      "integrity": "sha512-b"',
      ">>>>>>> feature",
      "    },",
      '    "node_modules/bar": {',
      '      "version": "1.0.0",',
      '      "integrity": "sha512-c"',
      "    }",
      "  }",
      "}",
    ].join("\n")

    const result = await makeResolver("highest").resolveConflicts(content)
    assert.equal(result.resolved, true, result.errors.join(", "))
    assert.equal(result.packageJson!.packages[""].dependencies.foo, "1.2.0")
    assert.equal(result.packageJson!.packages["node_modules/foo"].version, "1.2.0")
    assert.deepEqual(result.lockfileIssues, [])
  })
})
