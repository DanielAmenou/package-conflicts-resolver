/**
 * Field-by-field merge behavior for the parts of package.json and of npm 6
 * (lockfileVersion 1) lockfiles that are not plain dependency maps.
 */

import {strict as assert} from "assert"
import {test, describe} from "node:test"
import {PackageResolver} from "../package-resolver.js"
import {CliOptions} from "../types.js"

function makeResolver(strategy: CliOptions["strategy"] = "highest"): PackageResolver {
  return new PackageResolver({strategy, dryRun: true, quiet: true, json: false, verbose: false, regenerateLock: false})
}

const j = (value: unknown) => JSON.stringify(value)

describe("overrides and resolutions", () => {
  test("nested override specs are compared with semver, not as strings", async () => {
    // npm allows overrides to nest, including "." for the package itself
    const ours = j({overrides: {foo: {".": "1.9.0", bar: "1.9.0"}, top: "1.9.0"}})
    const theirs = j({overrides: {foo: {".": "1.10.0", bar: "1.10.0"}, top: "1.10.0"}})

    const result = await makeResolver("highest").mergeJsonContents("", ours, theirs)
    // Lexicographically "1.9.0" > "1.10.0"; semver says the opposite
    assert.equal(result.packageJson!.overrides.top, "1.10.0")
    assert.equal(result.packageJson!.overrides.foo["."], "1.10.0")
    assert.equal(result.packageJson!.overrides.foo.bar, "1.10.0")
  })

  test("deeply nested overrides are still specs", async () => {
    const ours = j({overrides: {a: {b: {c: "^1.9.0"}}}})
    const theirs = j({overrides: {a: {b: {c: "^1.10.0"}}}})

    const result = await makeResolver("highest").mergeJsonContents("", ours, theirs)
    assert.equal(result.packageJson!.overrides.a.b.c, "^1.10.0")
  })

  test("the lowest strategy applies to nested overrides too", async () => {
    const ours = j({overrides: {foo: {bar: "1.9.0"}}})
    const theirs = j({overrides: {foo: {bar: "1.10.0"}}})

    const result = await makeResolver("lowest").mergeJsonContents("", ours, theirs)
    assert.equal(result.packageJson!.overrides.foo.bar, "1.9.0")
  })

  test("a field that merely shares the name is not treated as a spec", async () => {
    // A script called "overrides" is free-form text, compared as a string
    const ours = j({scripts: {overrides: "node apply-a.js"}})
    const theirs = j({scripts: {overrides: "node apply-b.js"}})

    const result = await makeResolver("highest").mergeJsonContents("", ours, theirs)
    assert.equal(result.packageJson!.scripts!.overrides, "node apply-b.js")
  })

  test("yarn resolutions with path-style keys compare as versions", async () => {
    const ours = j({resolutions: {"pkg/sub": "1.9.0", "**/other": "^2.9.0"}})
    const theirs = j({resolutions: {"pkg/sub": "1.10.0", "**/other": "^2.10.0"}})

    const result = await makeResolver("highest").mergeJsonContents("", ours, theirs)
    assert.equal(result.packageJson!.resolutions["pkg/sub"], "1.10.0")
    assert.equal(result.packageJson!.resolutions["**/other"], "^2.10.0")
  })
})

describe("other manifest fields", () => {
  test("bin entries are paths, not versions", async () => {
    const ours = j({bin: {app: "./bin/a.js", helper: "./bin/h.js"}})
    const theirs = j({bin: {app: "./bin/b.js"}})

    const result = await makeResolver("highest").mergeJsonContents("", ours, theirs)
    assert.equal(result.packageJson!.bin.helper, "./bin/h.js", "an entry only we have is kept")
    assert(["./bin/a.js", "./bin/b.js"].includes(result.packageJson!.bin.app))
  })

  test("os and cpu arrays merge as a union", async () => {
    const ours = j({os: ["darwin"], cpu: ["x64"]})
    const theirs = j({os: ["linux"], cpu: ["arm64"]})

    const result = await makeResolver().mergeJsonContents("", ours, theirs)
    assert.deepEqual(result.packageJson!.os, ["darwin", "linux"])
    assert.deepEqual(result.packageJson!.cpu, ["x64", "arm64"])
  })

  test("peerDependenciesMeta merges per package", async () => {
    const ours = j({
      peerDependencies: {react: "^17.0.0"},
      peerDependenciesMeta: {react: {optional: true}},
    })
    const theirs = j({
      peerDependencies: {react: "^18.0.0", vue: "^3.0.0"},
      peerDependenciesMeta: {react: {optional: true}, vue: {optional: false}},
    })

    const result = await makeResolver("highest").mergeJsonContents("", ours, theirs)
    assert.equal(result.packageJson!.peerDependencies!.react, "^18.0.0", "peer ranges use semver")
    assert.equal(result.packageJson!.peerDependencies!.vue, "^3.0.0")
    assert.deepEqual(result.packageJson!.peerDependenciesMeta, {react: {optional: true}, vue: {optional: false}})
  })

  test("conditional exports merge without losing either side's conditions", async () => {
    const ours = j({
      exports: {".": {import: "./dist/index.mjs", require: "./dist/index.cjs"}, "./util": "./dist/util.mjs"},
    })
    const theirs = j({
      exports: {".": {import: "./dist/index.mjs", types: "./dist/index.d.ts"}},
    })

    const result = await makeResolver().mergeJsonContents("", ours, theirs)
    assert.deepEqual(result.packageJson!.exports, {
      ".": {import: "./dist/index.mjs", require: "./dist/index.cjs", types: "./dist/index.d.ts"},
      "./util": "./dist/util.mjs",
    })
  })

  test("the workspaces array merges as a union", async () => {
    const ours = j({workspaces: ["packages/*"]})
    const theirs = j({workspaces: ["packages/*", "apps/*"]})

    const result = await makeResolver().mergeJsonContents("", ours, theirs)
    assert.deepEqual(result.packageJson!.workspaces, ["packages/*", "apps/*"])
  })

  test("engines ranges use semver while unrelated strings do not", async () => {
    const ours = j({engines: {node: ">=9", npm: ">=9"}, license: "Apache-2.0"})
    const theirs = j({engines: {node: ">=10", npm: ">=10"}, license: "MIT"})

    const result = await makeResolver("highest").mergeJsonContents("", ours, theirs)
    assert.equal(result.packageJson!.engines!.node, ">=10", "semver: 10 > 9")
    assert.equal(result.packageJson!.engines!.npm, ">=10")
    assert.equal(result.packageJson!.license, "MIT", "a license is compared as a plain string")
  })
})

describe("npm 6 lockfiles (lockfileVersion 1)", () => {
  /** A v1 lockfile stores entry objects under "dependencies", not version strings */
  const v1Dependencies = (result: {packageJson?: unknown}): Record<string, any> =>
    (result.packageJson as Record<string, any>).dependencies

  const entry = (name: string, version: string, extra: Record<string, any> = {}) => ({
    version,
    resolved: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
    integrity: `sha512-${name}-${version}`,
    ...extra,
  })

  const v1 = (dependencies: Record<string, any>) =>
    j({name: "app", version: "1.0.0", lockfileVersion: 1, requires: true, dependencies})

  test("top-level entries stay atomic", async () => {
    const ours = v1({lodash: entry("lodash", "4.17.21")})
    const theirs = v1({lodash: entry("lodash", "4.17.20")})

    const result = await makeResolver("highest").mergeJsonContents("", ours, theirs)
    assert.deepEqual(v1Dependencies(result).lodash, {
      version: "4.17.21",
      resolved: "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz",
      integrity: "sha512-lodash-4.17.21",
    })
  })

  test("nested entries stay atomic at any depth", async () => {
    const build = (inner: string) =>
      v1({
        a: entry("a", "1.0.0", {
          requires: {b: "^1.0.0"},
          dependencies: {
            b: entry("b", inner, {
              dependencies: {c: entry("c", inner)},
            }),
          },
        }),
      })

    const result = await makeResolver("highest").mergeJsonContents("", build("1.0.0"), build("2.0.0"))
    const b = v1Dependencies(result).a.dependencies.b
    assert.equal(b.version, "2.0.0")
    assert.equal(b.integrity, "sha512-b-2.0.0", "integrity must travel with the version")
    assert.equal(b.resolved, "https://registry.npmjs.org/b/-/b-2.0.0.tgz")
    assert.equal(b.dependencies.c.version, "2.0.0")
    assert.equal(b.dependencies.c.integrity, "sha512-c-2.0.0")
  })

  test("'requires' ranges are compared with semver", async () => {
    const ours = v1({a: entry("a", "1.0.0", {requires: {b: "^1.9.0"}})})
    const theirs = v1({a: entry("a", "1.0.0", {requires: {b: "^1.10.0"}})})

    const result = await makeResolver("highest").mergeJsonContents("", ours, theirs)
    assert.equal(v1Dependencies(result).a.requires.b, "^1.10.0")
  })

  test("dev and optional flags are preserved", async () => {
    const ours = v1({a: entry("a", "1.0.0", {dev: true}), b: entry("b", "1.0.0", {optional: true})})
    const theirs = v1({a: entry("a", "1.0.0", {dev: true}), b: entry("b", "1.0.0", {optional: true})})

    const result = await makeResolver().mergeJsonContents("", ours, theirs)
    assert.equal(v1Dependencies(result).a.dev, true)
    assert.equal(v1Dependencies(result).b.optional, true)
  })

  test("entries added on either branch all survive", async () => {
    const ours = v1({a: entry("a", "1.0.0"), shared: entry("shared", "1.0.0")})
    const theirs = v1({b: entry("b", "2.0.0"), shared: entry("shared", "1.0.0")})

    const result = await makeResolver().mergeJsonContents("", ours, theirs)
    assert.deepEqual(Object.keys(result.packageJson!.dependencies!).sort(), ["a", "b", "shared"])
  })

  test("a v1 lockfile carries no consistency report, since it cannot be checked", async () => {
    const result = await makeResolver().mergeJsonContents(
      "",
      v1({lodash: entry("lodash", "4.17.21")}),
      v1({lodash: entry("lodash", "4.17.20")})
    )
    assert.deepEqual(result.lockfileIssues, [], "no packages section means nothing to validate")
  })

  test("a three-way merge honors the base in a v1 lockfile", async () => {
    const base = v1({lodash: entry("lodash", "4.17.20")})
    const ours = v1({lodash: entry("lodash", "4.17.20"), react: entry("react", "18.0.0")})
    const theirs = v1({lodash: entry("lodash", "4.17.19")}) // deliberate downgrade

    const result = await makeResolver("highest").mergeJsonContents(base, ours, theirs)
    assert.equal(v1Dependencies(result).lodash.version, "4.17.19", "their one-sided downgrade stands")
    assert.equal(v1Dependencies(result).lodash.integrity, "sha512-lodash-4.17.19")
    assert.equal(v1Dependencies(result).react.version, "18.0.0", "our addition survives")
  })
})
