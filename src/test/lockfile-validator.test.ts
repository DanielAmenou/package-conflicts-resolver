/**
 * Tests for the lockfile consistency validator: dependency edges of an npm
 * lockfile (v2/v3 "packages" section) must be satisfied by the locked
 * versions, following Node's resolution order, workspace links and aliases.
 */

import {strict as assert} from "assert"
import {test, describe} from "node:test"
import {
  formatLockfileIssues,
  isNpmLockfile,
  resolveLockfileDependency,
  validateLockfile,
} from "../lockfile-validator.js"

const entry = (version: string, extra: Record<string, any> = {}) => ({
  version,
  resolved: `https://registry.npmjs.org/pkg/-/pkg-${version}.tgz`,
  integrity: `sha512-${version}`,
  ...extra,
})

const lock = (root: Record<string, any>, packages: Record<string, any>) => ({
  name: "app",
  version: "1.0.0",
  lockfileVersion: 3,
  requires: true,
  packages: {"": {name: "app", version: "1.0.0", ...root}, ...packages},
})

describe("isNpmLockfile", () => {
  test("recognises lockfile v2/v3 documents", () => {
    assert.equal(isNpmLockfile(lock({}, {})), true)
  })

  test("recognises lockfile v1 documents (dependencies section only)", () => {
    assert.equal(isNpmLockfile({name: "app", lockfileVersion: 1, dependencies: {}}), true)
  })

  test("rejects package.json documents and non-objects", () => {
    assert.equal(isNpmLockfile({name: "app", version: "1.0.0", dependencies: {lodash: "^4.0.0"}}), false)
    assert.equal(isNpmLockfile(null), false)
    assert.equal(isNpmLockfile([]), false)
    assert.equal(isNpmLockfile("{}"), false)
  })
})

describe("validateLockfile", () => {
  test("a consistent lockfile has no issues", () => {
    const doc = lock(
      {dependencies: {foo: "^1.0.0"}, devDependencies: {bar: "~2.1.0"}},
      {"node_modules/foo": entry("1.5.0"), "node_modules/bar": entry("2.1.3")}
    )
    assert.deepEqual(validateLockfile(doc), [])
  })

  test("reports a root dependency whose locked version does not satisfy the spec", () => {
    const doc = lock({dependencies: {foo: "1.2.0"}}, {"node_modules/foo": entry("1.5.0")})
    const issues = validateLockfile(doc)

    assert.equal(issues.length, 1)
    assert.equal(issues[0]!.kind, "invalid")
    assert.equal(issues[0]!.from, "")
    assert.equal(issues[0]!.name, "foo")
    assert.equal(issues[0]!.spec, "1.2.0")
    assert.equal(issues[0]!.resolvedPath, "node_modules/foo")
    assert.equal(issues[0]!.version, "1.5.0")
    assert.equal(issues[0]!.message, "the root project requires foo@1.2.0 but node_modules/foo is 1.5.0")
  })

  test("reports a dependency with no entry at all", () => {
    const doc = lock({dependencies: {foo: "^1.0.0"}}, {})
    const issues = validateLockfile(doc)

    assert.equal(issues.length, 1)
    assert.equal(issues[0]!.kind, "missing")
    assert.match(issues[0]!.message, /requires foo@\^1\.0\.0 but no entry/)
  })

  test("reports unsatisfied transitive edges", () => {
    const doc = lock(
      {dependencies: {a: "^2.0.0"}},
      {
        // a@2 needs b@^2 but only b@1.9.0 is hoisted: the graph is broken
        "node_modules/a": entry("2.0.0", {dependencies: {b: "^2.0.0"}}),
        "node_modules/b": entry("1.9.0"),
      }
    )
    const issues = validateLockfile(doc)

    assert.equal(issues.length, 1)
    assert.equal(issues[0]!.from, "node_modules/a")
    assert.equal(issues[0]!.message, "node_modules/a requires b@^2.0.0 but node_modules/b is 1.9.0")
  })

  test("prefers a nested copy over a hoisted one, like Node does", () => {
    const doc = lock(
      {dependencies: {a: "^2.0.0", b: "^1.0.0"}},
      {
        "node_modules/a": entry("2.0.0", {dependencies: {b: "^2.0.0"}}),
        "node_modules/a/node_modules/b": entry("2.3.0"),
        "node_modules/b": entry("1.9.0"),
      }
    )
    assert.deepEqual(validateLockfile(doc), [])
  })

  test("walks up parent folders for deeply nested dependents", () => {
    const doc = lock(
      {dependencies: {a: "^1.0.0"}},
      {
        "node_modules/a": entry("1.0.0", {dependencies: {b: "^1.0.0"}}),
        "node_modules/a/node_modules/b": entry("1.0.0", {dependencies: {c: "^3.0.0", "@scope/d": "^1.0.0"}}),
        // c and @scope/d are hoisted to the root and must be found from two levels down
        "node_modules/c": entry("3.1.0"),
        "node_modules/@scope/d": entry("1.2.0"),
      }
    )
    assert.deepEqual(validateLockfile(doc), [])
  })

  test("missing optional dependencies are fine, wrong versions are not", () => {
    const missing = lock({optionalDependencies: {fsevents: "^2.3.0"}}, {})
    assert.deepEqual(validateLockfile(missing), [])

    const wrong = lock({optionalDependencies: {fsevents: "^2.3.0"}}, {"node_modules/fsevents": entry("1.2.13")})
    assert.equal(validateLockfile(wrong).length, 1)
  })

  test("peer dependencies are not validated", () => {
    const doc = lock(
      {dependencies: {plugin: "^1.0.0"}},
      {"node_modules/plugin": entry("1.0.0", {peerDependencies: {host: "^9.0.0"}})}
    )
    assert.deepEqual(validateLockfile(doc), [])
  })

  test("follows workspace links to the linked package", () => {
    const doc = {
      name: "monorepo",
      lockfileVersion: 3,
      packages: {
        "": {name: "monorepo", workspaces: ["packages/*"], dependencies: {"@app/core": "^1.0.0"}},
        "node_modules/@app/core": {resolved: "packages/core", link: true},
        "node_modules/@app/ui": {resolved: "packages/ui", link: true},
        "packages/core": {name: "@app/core", version: "1.4.0", dependencies: {lodash: "^4.17.0"}},
        "packages/ui": {name: "@app/ui", version: "0.1.0", dependencies: {"@app/core": "^1.2.0"}},
        "node_modules/lodash": entry("4.17.21"),
      },
    }
    assert.deepEqual(validateLockfile(doc), [])

    // A workspace requiring a version its sibling does not provide is caught
    doc.packages["packages/ui"].dependencies["@app/core"] = "^2.0.0"
    const issues = validateLockfile(doc)
    assert.equal(issues.length, 1)
    assert.equal(issues[0]!.from, "packages/ui")
    assert.equal(issues[0]!.resolvedPath, "packages/core")
  })

  test("understands npm: aliases", () => {
    const ok = lock(
      {dependencies: {"string-width-cjs": "npm:string-width@^4.2.0"}},
      {"node_modules/string-width-cjs": entry("4.2.3", {name: "string-width"})}
    )
    assert.deepEqual(validateLockfile(ok), [])

    const wrongVersion = lock(
      {dependencies: {"string-width-cjs": "npm:string-width@^4.2.0"}},
      {"node_modules/string-width-cjs": entry("5.0.0", {name: "string-width"})}
    )
    assert.equal(validateLockfile(wrongVersion).length, 1)

    const wrongPackage = lock(
      {dependencies: {"string-width-cjs": "npm:string-width@^4.2.0"}},
      {"node_modules/string-width-cjs": entry("4.2.3", {name: "something-else"})}
    )
    assert.equal(validateLockfile(wrongPackage).length, 1)
    assert.match(validateLockfile(wrongPackage)[0]!.message, /is something-else@4\.2\.3/)
  })

  test("skips specs that are not semver ranges", () => {
    const doc = lock(
      {
        dependencies: {
          git: "github:user/repo#abc123",
          gitUrl: "git+https://github.com/user/repo.git",
          local: "file:../local",
          tag: "latest",
          ws: "workspace:*",
          url: "https://example.com/pkg.tgz",
        },
      },
      {
        "node_modules/git": {version: "0.0.1", resolved: "git+ssh://git@github.com/user/repo.git#abc123"},
        "node_modules/local": {resolved: "../local", link: true},
        // tag, ws, url and gitUrl are absent entirely: still nothing to check
      }
    )
    assert.deepEqual(validateLockfile(doc), [])
  })

  test("treats an empty spec and '*' as any version", () => {
    const doc = lock(
      {dependencies: {a: "", b: "*"}},
      {"node_modules/a": entry("0.0.1"), "node_modules/b": entry("9.9.9")}
    )
    assert.deepEqual(validateLockfile(doc), [])
  })

  test("accepts pre-release versions locked for pre-release ranges", () => {
    const doc = lock({dependencies: {foo: "^2.0.0-beta.1"}}, {"node_modules/foo": entry("2.0.0-beta.4")})
    assert.deepEqual(validateLockfile(doc), [])
  })

  test("uses package.json for the root edges when it is given", () => {
    // The lockfile's own root entry still says ^1.0.0, but package.json now pins 1.2.0
    const doc = lock({dependencies: {foo: "^1.0.0"}}, {"node_modules/foo": entry("1.5.0")})
    assert.deepEqual(validateLockfile(doc), [])

    const issues = validateLockfile(doc, {name: "app", dependencies: {foo: "1.2.0"}})
    assert.equal(issues.length, 1)
    assert.equal(issues[0]!.spec, "1.2.0")

    // A dependency only declared in package.json must exist in the lockfile
    const missing = validateLockfile(doc, {name: "app", dependencies: {foo: "^1.0.0", brandNew: "^1.0.0"}})
    assert.equal(missing.length, 1)
    assert.equal(missing[0]!.kind, "missing")
  })

  test("ignores link and extraneous entries as dependents", () => {
    const doc = lock(
      {},
      {
        "node_modules/leftover": entry("1.0.0", {extraneous: true, dependencies: {gone: "^1.0.0"}}),
        "node_modules/ws": {resolved: "packages/ws", link: true, dependencies: {gone: "^1.0.0"}},
      }
    )
    assert.deepEqual(validateLockfile(doc), [])
  })

  test("cannot check lockfile v1 documents and reports nothing", () => {
    const v1 = {
      name: "app",
      lockfileVersion: 1,
      requires: true,
      dependencies: {foo: {version: "1.5.0", resolved: "https://r/foo-1.5.0.tgz", integrity: "sha512-x"}},
    }
    assert.deepEqual(validateLockfile(v1), [])
  })
})

describe("resolveLockfileDependency", () => {
  test("resolves from the root", () => {
    const packages = {"node_modules/foo": entry("1.0.0")}
    assert.equal(resolveLockfileDependency(packages, "", "foo")!.location, "node_modules/foo")
    assert.equal(resolveLockfileDependency(packages, "", "bar"), null)
  })

  test("resolves from a workspace folder through the root", () => {
    const packages = {"node_modules/foo": entry("1.0.0")}
    assert.equal(resolveLockfileDependency(packages, "packages/app", "foo")!.location, "node_modules/foo")
  })
})

describe("formatLockfileIssues", () => {
  test("caps the number of lines and summarises the rest", () => {
    const issues = Array.from({length: 13}, (_, i) => ({
      from: "",
      name: `dep${i}`,
      spec: "^1.0.0",
      kind: "missing" as const,
      message: `the root project requires dep${i}@^1.0.0 but no entry for it exists`,
    }))

    const lines = formatLockfileIssues(issues)
    assert.equal(lines.length, 11)
    assert.equal(lines[10], "... and 3 more")

    assert.equal(formatLockfileIssues(issues.slice(0, 2)).length, 2)
  })
})

describe("validateLockfile robustness", () => {
  test("entries without a usable version are skipped rather than reported", () => {
    const doc = lock(
      {dependencies: {a: "^1.0.0", b: "^1.0.0", c: "^1.0.0"}},
      {
        "node_modules/a": {resolved: "https://r/a.tgz"}, // no version at all
        "node_modules/b": {version: "not-a-version", resolved: "https://r/b.tgz"},
        "node_modules/c": {version: 42 as any},
      }
    )
    assert.deepEqual(validateLockfile(doc), [])
  })

  test("survives malformed documents without throwing", () => {
    const malformed: any[] = [
      {lockfileVersion: 3, packages: null},
      {lockfileVersion: 3, packages: {"": null}},
      {lockfileVersion: 3, packages: {"": {dependencies: null}}},
      {lockfileVersion: 3, packages: {"": {dependencies: {a: 42}}}},
      {lockfileVersion: 3, packages: {"": {dependencies: {a: "^1.0.0"}}, "node_modules/a": "string"}},
      {lockfileVersion: 3, packages: {"node_modules/a": {version: "1.0.0", dependencies: "nope"}}},
      {lockfileVersion: 3, packages: {"node_modules/a": {link: true}}},
      {lockfileVersion: 3, packages: {"node_modules/a": {link: true, resolved: "missing/target"}}},
    ]

    for (const doc of malformed) {
      assert.doesNotThrow(() => validateLockfile(doc), `threw for ${JSON.stringify(doc)}`)
      assert(Array.isArray(validateLockfile(doc)))
    }
  })

  test("a link pointing at a missing target is not reported as a version mismatch", () => {
    const doc = lock(
      {dependencies: {"@app/core": "^1.0.0"}},
      {"node_modules/@app/core": {resolved: "packages/core", link: true}}
    )
    // The target folder is absent from the lockfile: nothing to compare, and
    // inventing a mismatch here would be worse than staying quiet
    assert.deepEqual(validateLockfile(doc), [])
  })

  test("does not follow a link into an infinite loop", () => {
    const doc = {
      lockfileVersion: 3,
      packages: {
        "": {name: "app", dependencies: {a: "^1.0.0"}},
        "node_modules/a": {resolved: "node_modules/a", link: true},
      },
    }
    assert.doesNotThrow(() => validateLockfile(doc))
  })

  test("a very deep tree resolves without blowing the stack", () => {
    const packages: Record<string, any> = {"": {name: "app", dependencies: {p0: "^1.0.0"}}}
    let path = "node_modules/p0"
    for (let i = 0; i < 400; i++) {
      packages[path] = {version: "1.0.0", integrity: "sha512-x", dependencies: {[`p${i + 1}`]: "^1.0.0"}}
      path = `${path}/node_modules/p${i + 1}`
    }
    packages[path] = {version: "1.0.0", integrity: "sha512-x"}

    const doc = {lockfileVersion: 3, packages}
    assert.doesNotThrow(() => validateLockfile(doc))
    assert.deepEqual(validateLockfile(doc), [])
  })
})
