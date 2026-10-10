/**
 * Unit tests for picked versions: parsing `--pick` values, telling registry
 * versions from other specs, matching locked entries, finding picks that
 * cannot apply, and checking that picked versions exist.
 */

import {strict as assert} from "assert"
import {test, describe} from "node:test"
import {mkdir, mkdtemp, rm} from "fs/promises"
import {homedir, tmpdir} from "node:os"
import {join, resolve} from "node:path"
import {
  classifyVersionSpec,
  findPickProblems,
  isValidPackageName,
  lockedVersionSatisfies,
  normalizeVersionPicks,
  parseVersionPick,
  parseVersionPicks,
  verifyVersionPicks,
  FilePackageConflict,
} from "../version-picks.js"
import {PackageVersions} from "../registry.js"

describe("isValidPackageName", () => {
  test("accepts plain, scoped and legacy names", () => {
    for (const name of ["lodash", "@types/node", "lodash.merge", "socket.io", "a-b_c~d", "JSONStream", "@a/b", "x"]) {
      assert.equal(isValidPackageName(name), true, name)
    }
  })

  test("rejects anything npm would not publish, shell metacharacters included", () => {
    const invalid = [
      "",
      " lodash",
      "lo dash",
      ".hidden",
      "_private",
      "@scope",
      "@scope/",
      "@/name",
      "foo&calc",
      "a;b",
      "$(whoami)",
      "a|b",
      "a>b",
      'a"b',
      "a/b/c",
      "x".repeat(215),
    ]
    for (const name of invalid) {
      assert.equal(isValidPackageName(name), false, name)
    }
    assert.equal(isValidPackageName("x".repeat(214)), true, "214 characters is the limit")
  })
})

describe("classifyVersionSpec", () => {
  const typeOf = (spec: string) => classifyVersionSpec(spec)?.type ?? null

  test("exact versions", () => {
    for (const spec of ["1.2.3", "v1.2.3", "1.0.0-beta.1", "  2.0.0  "]) {
      assert.equal(typeOf(spec), "version", spec)
    }
    assert.deepEqual(classifyVersionSpec("1.2.3"), {type: "version", range: "1.2.3"})
  })

  test("semver ranges", () => {
    const ranges = ["^1.2.3", "~1.2", "1.x", "*", "x", ">=1 <2", "1.2.3 - 2.0.0", "^17 || ^18", "1", "v1", "=1.2.3"]
    for (const spec of ranges) {
      assert.equal(typeOf(spec), "range", spec)
    }
    assert.deepEqual(classifyVersionSpec("^4.17.0"), {type: "range", range: "^4.17.0"})
  })

  test("npm aliases need a registry package and carry its range", () => {
    assert.deepEqual(classifyVersionSpec("npm:lodash@^4.17.0"), {type: "alias", target: "lodash", range: "^4.17.0"})
    assert.deepEqual(classifyVersionSpec("npm:@scope/pkg@1.0.0"), {
      type: "alias",
      target: "@scope/pkg",
      range: "1.0.0",
    })
    // Without a version (or with a tag) an alias says nothing about the version
    assert.deepEqual(classifyVersionSpec("npm:lodash"), {type: "alias", target: "lodash"})
    assert.deepEqual(classifyVersionSpec("npm:lodash@"), {type: "alias", target: "lodash"})
    assert.deepEqual(classifyVersionSpec("npm:lodash@latest"), {type: "alias", target: "lodash"})
    // Only registry packages can be aliased
    assert.equal(classifyVersionSpec("npm:bad name@1.0.0"), null)
    assert.equal(classifyVersionSpec("npm:lodash@github:user/repo"), null)
    assert.equal(classifyVersionSpec("npm:lodash@not valid!"), null)
  })

  test("dist-tags", () => {
    for (const spec of ["latest", "next", "beta-2", "canary"]) {
      assert.equal(typeOf(spec), "tag", spec)
    }
  })

  test("local paths, with or without a protocol", () => {
    assert.deepEqual(classifyVersionSpec("file:../lib"), {type: "file", path: "../lib"})
    assert.deepEqual(classifyVersionSpec("link:./lib"), {type: "file", path: "./lib"})
    assert.deepEqual(classifyVersionSpec("FILE:lib"), {type: "file", path: "lib"})
    for (const spec of ["./lib", "../lib", ".", "..", "/abs/lib", "~/lib", "~\\lib", "\\lib", "C:\\lib", "c:/lib"]) {
      assert.deepEqual(classifyVersionSpec(spec), {type: "file", path: spec}, spec)
    }
  })

  test("URLs, git repositories and other protocols", () => {
    for (const spec of ["https://example.com/pkg.tgz", "http://example.com/pkg.tgz"]) {
      assert.equal(typeOf(spec), "url", spec)
    }
    const git = [
      "github:user/repo",
      "github:user/repo#v1.0.0",
      "gitlab:user/repo",
      "bitbucket:user/repo",
      "gist:abc123",
      "git://github.com/user/repo.git",
      "git+ssh://git@github.com/user/repo.git#semver:^1.0.0",
      "git+https://github.com/user/repo.git",
      "git@github.com:user/repo.git",
      "user/repo",
      "user/repo#main",
    ]
    for (const spec of git) {
      assert.equal(typeOf(spec), "git", spec)
    }
    for (const spec of ["workspace:*", "workspace:^1.0.0", "catalog:", "portal:../lib", "patch:lodash@4#./fix.patch"]) {
      assert.equal(typeOf(spec), "protocol", spec)
    }
  })

  test("returns null for anything that is no spec at all", () => {
    // Loose semver would read "1.2.3 garbage" as 1.2.3 and "01.2.3" as 1.2.3: both are rejected
    const invalid = [
      "",
      "   ",
      "not valid!",
      "a b",
      "1.2.3 garbage <<",
      "1.2.3 garbage",
      "01.2.3",
      "v1.x.y.z",
      "^^1",
      ">=foo",
    ]
    for (const spec of invalid) {
      assert.equal(classifyVersionSpec(spec), null, JSON.stringify(spec))
    }
  })
})

describe("parseVersionPick", () => {
  test("splits name and version, scoped names and aliases included", () => {
    assert.deepEqual(parseVersionPick("lodash@4.17.21"), {name: "lodash", spec: "4.17.21"})
    assert.deepEqual(parseVersionPick("@types/node@^20.11.0"), {name: "@types/node", spec: "^20.11.0"})
    assert.deepEqual(parseVersionPick("my-lodash@npm:lodash@^4.17.0"), {
      name: "my-lodash",
      spec: "npm:lodash@^4.17.0",
    })
    assert.deepEqual(parseVersionPick("@scope/x@npm:@other/y@1.0.0"), {name: "@scope/x", spec: "npm:@other/y@1.0.0"})
    assert.deepEqual(parseVersionPick("react@^17 || ^18"), {name: "react", spec: "^17 || ^18"})
    assert.deepEqual(parseVersionPick("  lodash@ 4.17.21  "), {name: "lodash", spec: "4.17.21"})
    assert.deepEqual(parseVersionPick("local@file:../local"), {name: "local", spec: "file:../local"})
    assert.deepEqual(parseVersionPick("ws@workspace:*"), {name: "ws", spec: "workspace:*"})
  })

  test("explains what is wrong with an invalid pick", () => {
    const cases: Array<[string, RegExp]> = [
      ["lodash", /"lodash" is not <name>@<version>/],
      ["@types/node", /"@types\/node" is not <name>@<version>/],
      ["", /"" is not <name>@<version>/],
      ["lo dash@1.0.0", /"lo dash" is not a valid package name/],
      ["foo&calc@1.0.0", /"foo&calc" is not a valid package name/],
      ["lodash@", /has no version after the "@"/],
      ["lodash@   ", /has no version after the "@"/],
      ["lodash@not valid!", /"not valid!" is not a valid version or range/],
      ["lodash@latest", /"latest" is a dist-tag; pick a version or a range instead/],
      ["lodash@npm:lodash", /an npm: alias needs a version or a range/],
      ["lodash@npm:lodash@next", /an npm: alias needs a version or a range/],
    ]
    for (const [input, message] of cases) {
      assert.throws(() => parseVersionPick(input), message, input)
    }
  })
})

describe("parseVersionPicks", () => {
  test("collects every pick into a name -> spec map", () => {
    const {picks, errors} = parseVersionPicks(["lodash@4.17.21", "@types/node@^20", "react@18.3.1"])
    assert.deepEqual(errors, [])
    assert.deepEqual(picks, {lodash: "4.17.21", "@types/node": "^20", react: "18.3.1"})
  })

  test("the same pick twice is fine, two different versions are not", () => {
    assert.deepEqual(parseVersionPicks(["lodash@4.17.21", "lodash@4.17.21"]), {picks: {lodash: "4.17.21"}, errors: []})

    const {picks, errors} = parseVersionPicks(["lodash@4.17.21", "lodash@4.17.20"])
    assert.deepEqual(picks, {lodash: "4.17.21"})
    assert.deepEqual(errors, ["lodash is picked twice, as 4.17.21 and as 4.17.20"])
  })

  test("reports every problem at once", () => {
    const {picks, errors} = parseVersionPicks(["lodash", "react@latest", "ok@1.0.0"])
    assert.deepEqual(picks, {ok: "1.0.0"})
    assert.equal(errors.length, 2)
  })

  test("package names that are Object.prototype members are plain keys", () => {
    const {picks, errors} = parseVersionPicks(["constructor@1.0.0", "toString@2.0.0", "hasOwnProperty@3.0.0"])
    assert.deepEqual(errors, [])
    assert.deepEqual(picks, {constructor: "1.0.0", toString: "2.0.0", hasOwnProperty: "3.0.0"})
  })

  test("no picks at all", () => {
    assert.deepEqual(parseVersionPicks([]), {picks: {}, errors: []})
  })
})

describe("normalizeVersionPicks", () => {
  test("validates API picks with the --pick rules", () => {
    assert.deepEqual(normalizeVersionPicks(undefined), new Map())
    assert.deepEqual(
      normalizeVersionPicks({lodash: " 4.17.21 ", "@types/node": "^20"}),
      new Map([
        ["lodash", "4.17.21"],
        ["@types/node", "^20"],
      ])
    )
  })

  test("throws on an invalid name or version", () => {
    assert.throws(() => normalizeVersionPicks({"bad name": "1.0.0"}), /"bad name" is not a valid package name/)
    assert.throws(() => normalizeVersionPicks({"foo@bar": "1.0.0"}), /"foo@bar" is not a valid package name/)
    assert.throws(() => normalizeVersionPicks({lodash: ""}), /has no version/)
    assert.throws(() => normalizeVersionPicks({lodash: "latest"}), /dist-tag/)
    assert.throws(() => normalizeVersionPicks({lodash: 4 as any}), TypeError)
  })
})

describe("lockedVersionSatisfies", () => {
  const entry = (version: unknown, extra: Record<string, unknown> = {}) => ({version, ...extra})

  test("an exact pick matches only that version", () => {
    assert.equal(lockedVersionSatisfies(entry("4.17.21"), "lodash", "4.17.21"), true)
    assert.equal(lockedVersionSatisfies(entry("4.17.20"), "lodash", "4.17.21"), false)
    assert.equal(lockedVersionSatisfies(entry("4.17.21"), "lodash", "v4.17.21"), true, "a v prefix is fine")
  })

  test("a range pick matches with npm's semantics", () => {
    assert.equal(lockedVersionSatisfies(entry("4.17.21"), "lodash", "^4.17.0"), true)
    assert.equal(lockedVersionSatisfies(entry("5.0.0"), "lodash", "^4.17.0"), false)
    assert.equal(lockedVersionSatisfies(entry("4.18.0-beta.1"), "lodash", "^4.17.0"), false, "no pre-releases")
    assert.equal(lockedVersionSatisfies(entry("1.0.0-beta.1"), "x", "1.0.0-beta.1"), true)
  })

  test("a plain pick does not match an aliased install, an alias pick only its target", () => {
    const aliased = entry("4.17.21", {name: "lodash"})
    assert.equal(lockedVersionSatisfies(aliased, "my-lodash", "4.17.21"), false)
    assert.equal(lockedVersionSatisfies(aliased, "my-lodash", "npm:lodash@4.17.21"), true)
    assert.equal(lockedVersionSatisfies(aliased, "my-lodash", "npm:lodash@^5"), false)
    assert.equal(lockedVersionSatisfies(entry("4.17.21"), "my-lodash", "npm:lodash@4.17.21"), false)
    assert.equal(lockedVersionSatisfies(entry("4.17.21"), "lodash", "npm:lodash@4.17.21"), true)
  })

  test("npm 6 records aliased installs as npm:<name>@<version>", () => {
    const v1 = entry("npm:lodash@4.17.21")
    assert.equal(lockedVersionSatisfies(v1, "my-lodash", "npm:lodash@^4.17.0"), true)
    assert.equal(lockedVersionSatisfies(v1, "my-lodash", "4.17.21"), false)
    assert.equal(lockedVersionSatisfies(entry("npm:lodash"), "my-lodash", "npm:lodash@4.17.21"), false)
  })

  test("specs without a version never match, nor do entries without one", () => {
    for (const spec of ["file:../lib", "github:user/repo", "https://x/y.tgz", "workspace:*", "npm:lodash", "!!"]) {
      assert.equal(lockedVersionSatisfies(entry("1.0.0"), "x", spec), false, spec)
    }
    assert.equal(lockedVersionSatisfies(entry(undefined, {resolved: "packages/x", link: true}), "x", "1.0.0"), false)
    assert.equal(lockedVersionSatisfies(entry(1), "x", "1.0.0"), false)
    assert.equal(lockedVersionSatisfies(entry("not a version"), "x", "^1"), false)
  })
})

describe("findPickProblems", () => {
  const conflict = (overrides: Partial<FilePackageConflict>): FilePackageConflict => ({
    name: "lodash",
    kind: "spec",
    location: "dependencies",
    path: ["dependencies", "lodash"],
    ours: "^4.17.20",
    theirs: "^4.17.21",
    resolved: "^4.17.21",
    resolvedBy: "highest",
    ...overrides,
  })

  test("a pick that applied to a conflict is fine", () => {
    const conflicts = [
      conflict({resolvedBy: "pick", resolved: "4.17.22", pick: "4.17.22"}),
      conflict({kind: "lock", location: "node_modules/lodash", ours: "4.17.20", theirs: "4.17.21", pick: "4.17.22"}),
    ]
    assert.deepEqual(findPickProblems({lodash: "4.17.22"}, conflicts), [])
  })

  test("a package that is not conflicted, with a suggestion for a typo", () => {
    const conflicts = [conflict({}), conflict({name: "react"})]
    const [typo] = findPickProblems({lodsh: "1.0.0"}, conflicts)
    assert.equal(typo?.name, "lodsh")
    assert.equal(typo?.spec, "1.0.0")
    assert.equal(typo?.message, "lodsh is not conflicted (did you mean lodash?). Conflicted packages: lodash, react")

    const [unrelated] = findPickProblems({express: "4.0.0"}, conflicts)
    assert.equal(unrelated?.message, "express is not conflicted. Conflicted packages: lodash, react")

    const [wrongCase] = findPickProblems({Lodash: "4.17.21"}, conflicts)
    assert.match(wrongCase!.message, /did you mean lodash\?/)
  })

  test("long lists of conflicted packages are shortened", () => {
    const conflicts = Array.from({length: 13}, (_, index) => conflict({name: `pkg-${String(index).padStart(2, "0")}`}))
    const [problem] = findPickProblems({other: "1.0.0"}, conflicts)
    assert.match(problem!.message, /pkg-00, pkg-01, .*pkg-09, and 3 more$/)
  })

  test("nothing conflicted at all", () => {
    assert.deepEqual(findPickProblems({lodash: "1.0.0"}, []), [
      {name: "lodash", spec: "1.0.0", message: "lodash is not conflicted: no package has conflicting versions"},
    ])
  })

  test("a package only conflicted in lockfile entries that the pick matches on neither side", () => {
    const conflicts = [
      conflict({
        kind: "lock",
        location: "node_modules/lodash",
        ours: "4.17.20",
        theirs: "4.17.21",
        pick: "4.17.22",
        file: "package-lock.json",
      }),
      conflict({kind: "lock", location: "node_modules/a/node_modules/lodash", ours: "3.0.0", theirs: "3.1.0"}),
    ]
    const [problem] = findPickProblems({lodash: "4.17.22"}, conflicts)
    assert.equal(
      problem?.message,
      'lodash@4.17.22 cannot be applied: lodash is only conflicted in installed lockfile entries, and neither side matches 4.17.22 (package-lock.json node_modules/lodash: ours 4.17.20, theirs 4.17.21; node_modules/a/node_modules/lodash: ours 3.0.0, theirs 3.1.0). Pick one of those versions, or resolve the conflicts first and then run "npm install lodash@4.17.22".'
    )
  })
})

describe("verifyVersionPicks", () => {
  const REGISTRY: Record<string, PackageVersions> = {
    lodash: {versions: ["4.17.19", "4.17.20", "4.17.21"], distTags: {latest: "4.17.21"}},
    "@scope/pkg": {versions: ["1.0.0", "2.0.0-beta.1"], distTags: {latest: "1.0.0", next: "2.0.0-beta.1"}},
    untagged: {versions: ["0.1.0"], distTags: {}},
  }

  function fakeLookup() {
    const calls: string[] = []
    const lookup = async (name: string) => {
      calls.push(name)
      return REGISTRY[name] ?? null
    }
    return {lookup, calls}
  }

  test("existing versions and ranges are confirmed, with the version they match", async () => {
    const {lookup} = fakeLookup()
    const results = await verifyVersionPicks(
      {lodash: "4.17.20", "@scope/pkg": "^2.0.0-0", "my-lodash": "npm:lodash@^4.17.0"},
      {lookup, cwd: process.cwd()}
    )
    assert.deepEqual(results, [
      {
        name: "lodash",
        spec: "4.17.20",
        status: "ok",
        message: "lodash@4.17.20 exists in the registry",
        version: "4.17.20",
      },
      {
        name: "@scope/pkg",
        spec: "^2.0.0-0",
        status: "ok",
        message: "@scope/pkg@^2.0.0-0 exists in the registry (newest match: 2.0.0-beta.1)",
        version: "2.0.0-beta.1",
      },
      {
        name: "my-lodash",
        spec: "npm:lodash@^4.17.0",
        status: "ok",
        message: "my-lodash@npm:lodash@^4.17.0 exists in the registry (newest match: 4.17.21)",
        version: "4.17.21",
      },
    ])
  })

  test("versions and ranges that do not exist are errors that mention the latest version", async () => {
    const {lookup} = fakeLookup()
    const results = await verifyVersionPicks(
      {lodash: "4.17.99", untagged: "^1.0.0", alias: "npm:@scope/pkg@3.0.0"},
      {lookup, cwd: process.cwd()}
    )
    assert.deepEqual(
      results.map(result => [result.status, result.message]),
      [
        ["error", "lodash@4.17.99 does not exist in the registry (latest is 4.17.21)"],
        ["error", "untagged@^1.0.0 matches no published version"],
        ["error", "alias@npm:@scope/pkg@3.0.0 does not exist in the registry (latest is 1.0.0)"],
      ]
    )
  })

  test("an unknown package is an error", async () => {
    const {lookup} = fakeLookup()
    const [result] = await verifyVersionPicks({nope: "1.0.0"}, {lookup, cwd: process.cwd()})
    assert.equal(result?.status, "error")
    assert.equal(result?.message, "nope@1.0.0: there is no package named nope in the registry")

    const [aliased] = await verifyVersionPicks({x: "npm:nope@1.0.0"}, {lookup, cwd: process.cwd()})
    assert.equal(aliased?.message, "x@npm:nope@1.0.0: there is no package named nope in the registry")
  })

  test("a failing lookup is an error that suggests skipping the check", async () => {
    const failing = async () => {
      throw new Error("registry unreachable")
    }
    const [result] = await verifyVersionPicks({lodash: "1.0.0"}, {lookup: failing, cwd: process.cwd()})
    assert.equal(result?.status, "error")
    assert.equal(
      result?.message,
      "lodash@1.0.0: could not check the registry (registry unreachable). Pass --no-version-check to skip this check."
    )

    // Lookups that throw synchronously, or throw something that is no Error
    const throwsSync = (() => {
      throw "boom"
    }) as any
    const [sync] = await verifyVersionPicks({lodash: "1.0.0"}, {lookup: throwsSync, cwd: process.cwd()})
    assert.match(sync!.message, /could not check the registry \(boom\)/)
  })

  test("each package is looked up once, however many picks need it", async () => {
    const {lookup, calls} = fakeLookup()
    await verifyVersionPicks(
      {lodash: "4.17.21", "lodash-alias": "npm:lodash@4.17.20", "other-alias": "npm:lodash@^4"},
      {lookup, cwd: process.cwd()}
    )
    assert.deepEqual(calls, ["lodash"])
  })

  test("file: specs are checked on disk, relative to the project", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pcr-picks-"))
    try {
      await mkdir(join(dir, "lib"))
      const {lookup, calls} = fakeLookup()
      const results = await verifyVersionPicks(
        {a: "file:lib", b: "link:./lib", c: "./lib", d: "file:missing", e: join(dir, "lib")},
        {lookup, cwd: dir}
      )
      assert.deepEqual(
        results.map(result => [result.name, result.status, result.message]),
        [
          ["a", "ok", `a@file:lib: ${join(dir, "lib")} exists`],
          ["b", "ok", `b@link:./lib: ${join(dir, "lib")} exists`],
          ["c", "ok", `c@./lib: ${join(dir, "lib")} exists`],
          ["d", "error", `d@file:missing: ${join(dir, "missing")} does not exist`],
          ["e", "ok", `e@${join(dir, "lib")}: ${join(dir, "lib")} exists`],
        ]
      )
      assert.deepEqual(calls, [], "the registry is not involved")
    } finally {
      await rm(dir, {recursive: true, force: true})
    }
  })

  test("~ in a file: spec is the home folder", async () => {
    const {lookup} = fakeLookup()
    const results = await verifyVersionPicks(
      {a: "file:~/pcr-surely-missing-folder", b: "~\\pcr-surely-missing-folder"},
      {lookup, cwd: process.cwd()}
    )
    const expected = resolve(homedir(), "pcr-surely-missing-folder")
    assert.deepEqual(
      results.map(result => result.message),
      [
        `a@file:~/pcr-surely-missing-folder: ${expected} does not exist`,
        `b@~\\pcr-surely-missing-folder: ${expected} does not exist`,
      ]
    )
  })

  test("git, URL and protocol specs cannot be checked and are used as given", async () => {
    const {lookup, calls} = fakeLookup()
    const results = await verifyVersionPicks(
      {a: "github:user/repo#v2", b: "https://example.com/b.tgz", c: "workspace:*"},
      {lookup, cwd: process.cwd()}
    )
    for (const result of results) {
      assert.equal(result.status, "unverified")
      assert.match(result.message, /is not a registry version, so it cannot be checked; it is used as given$/)
    }
    assert.deepEqual(calls, [])
  })

  test("specs that bypassed parsing (API callers) are still rejected", async () => {
    const {lookup} = fakeLookup()
    const results = await verifyVersionPicks({a: "not valid!", b: "latest", c: "npm:lodash"}, {lookup, cwd: "."})
    assert.deepEqual(
      results.map(result => [result.status, result.message]),
      [
        ["error", 'a@not valid!: "not valid!" is not a valid version or range'],
        ["error", "b@latest: dist-tags cannot be picked; pick a version or a range"],
        ["error", "c@npm:lodash: dist-tags cannot be picked; pick a version or a range"],
      ]
    )
  })
})
