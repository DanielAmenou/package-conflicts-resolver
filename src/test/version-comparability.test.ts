/**
 * Version specs that have no order between them: a git URL and a range, two
 * tarballs, dist-tags, aliases of different packages... The highest and
 * lowest strategies only order what semver can read, the same way on both
 * sides; they never compare specs by digits that happen to be in them (a
 * commit hash, a file name). A package.json leaves the rest for the user.
 */

import {strict as assert} from "assert"
import {test, describe} from "node:test"
import {readFile, writeFile} from "fs/promises"
import {join} from "node:path"
import {PackageResolver} from "../package-resolver.js"
import {VersionResolver} from "../version-resolver.js"
import {CliOptions} from "../types.js"
import {conflictedDocument, jsonLines, runCli, withTempDir} from "./cli-harness.js"

const resolve = (ours: string, theirs: string, strategy: CliOptions["strategy"] = "highest") =>
  VersionResolver.resolveVersion(ours, theirs, strategy)

/** Both strategies order the pair, and each picks the expected side */
function assertOrdered(ours: string, theirs: string, highest: string, lowest: string): void {
  for (const [strategy, expected] of [
    ["highest", highest],
    ["lowest", lowest],
  ] as const) {
    const result = resolve(ours, theirs, strategy)
    assert.equal(result.comparable, true, `${strategy}("${ours}", "${theirs}"): ${result.reason}`)
    assert.equal(result.resolved, expected, `${strategy}("${ours}", "${theirs}")`)
  }
}

/** Neither strategy finds an order, whichever side the specs are on: ours is kept */
function assertNotComparable(ours: string, theirs: string): void {
  for (const strategy of ["highest", "lowest"] as const) {
    for (const [a, b] of [
      [ours, theirs],
      [theirs, ours],
    ] as const) {
      const result = resolve(a, b, strategy)
      assert.equal(result.comparable, false, `${strategy}("${a}", "${b}") should not be comparable: ${result.reason}`)
      assert.equal(result.resolved, a, `${strategy}("${a}", "${b}") keeps ours`)
      assert.match(result.reason, /not comparable/)
    }
  }
}

describe("which version specs can be ordered", () => {
  test("registry versions and ranges", () => {
    assertOrdered("1.2.3", "1.10.0", "1.10.0", "1.2.3")
    assertOrdered("^1.0.0", "^2.0.0", "^2.0.0", "^1.0.0")
    assertOrdered(">=18", ">=20", ">=20", ">=18")
    assertOrdered("1.x", "2.x", "2.x", "1.x")
    assertOrdered("*", "^1.0.0", "^1.0.0", "*")
    assertOrdered("", "^1.0.0", "^1.0.0", "")
    assertOrdered("v1.0.0", "1.0.1", "1.0.1", "v1.0.0")
  })

  test("npm: aliases of the same package compare by their versions", () => {
    assertOrdered("npm:foo@^1.0.0", "npm:foo@^2.0.0", "npm:foo@^2.0.0", "npm:foo@^1.0.0")
    assertOrdered("npm:@scope/foo@1.0.0", "npm:@scope/foo@1.1.0", "npm:@scope/foo@1.1.0", "npm:@scope/foo@1.0.0")
  })

  test("aliases of different packages, or without a version, have no order", () => {
    assertNotComparable("npm:foo@^1.0.0", "npm:bar@^2.0.0")
    assertNotComparable("npm:foo@1.0.0", "^2.0.0")
    assertNotComparable("npm:foo", "npm:foo@^2.0.0")
    assertNotComparable("npm:foo@latest", "npm:foo@^1.0.0")
  })

  test("workspace: specs compare by their ranges, but not with registry ranges", () => {
    assertOrdered("workspace:^1.0.0", "workspace:^1.2.0", "workspace:^1.2.0", "workspace:^1.0.0")
    assertOrdered("workspace:*", "workspace:^1.0.0", "workspace:^1.0.0", "workspace:*")
    assertNotComparable("workspace:*", "^1.0.0")
    assertNotComparable("workspace:^", "workspace:~")
  })

  test("git specs of the same repository compare by tags that are versions, or semver: ranges", () => {
    assertOrdered("github:u/r#v1.0.0", "github:u/r#v2.0.0", "github:u/r#v2.0.0", "github:u/r#v1.0.0")
    assertOrdered(
      "github:u/r#semver:^1.0.0",
      "github:u/r#semver:^1.2.0",
      "github:u/r#semver:^1.2.0",
      "github:u/r#semver:^1.0.0"
    )
    assertOrdered("u/r#1.0.0", "u/r#2.0.0", "u/r#2.0.0", "u/r#1.0.0")
    assertOrdered(
      "git+ssh://git@github.com:u/r.git#v1.0.0",
      "git+ssh://git@github.com:u/r.git#v1.1.0",
      "git+ssh://git@github.com:u/r.git#v1.1.0",
      "git+ssh://git@github.com:u/r.git#v1.0.0"
    )
  })

  test("commit hashes, branches and other repositories have no order", () => {
    // The digits of a hash are no version: 123 < 456 says nothing about the commits
    assertNotComparable("github:u/r#abc123", "github:u/r#def456")
    assertNotComparable("github:u/r#main", "github:u/r#v2.0.0")
    assertNotComparable("github:u/r#v1.0.0", "github:other/r#v2.0.0")
    assertNotComparable("github:u/r", "github:u/r#v1.0.0")
    assertNotComparable("github:u/r#v2.0.0", "^1.0.0")
  })

  test("tarballs and file: paths have no order, whatever digits their names contain", () => {
    assertNotComparable("https://example.com/foo-1.2.3.tgz", "https://example.com/foo-1.3.0.tgz")
    assertNotComparable("file:../foo-1.0.0.tgz", "file:../foo-2.0.0.tgz")
    assertNotComparable("file:../foo", "^1.0.0")
    assertNotComparable("link:../a", "link:../b")
  })

  test("near-semver strings and unsatisfiable ranges have no order", () => {
    assertNotComparable("v1.2", "1.3.0.0")
    assertNotComparable("1.3.0.0", "1.3.0.1")
    assertNotComparable(">2.0.0 <1.0.0", "^1.5.0")
  })

  test("dist-tags and other protocols have no order, except with themselves", () => {
    assertNotComparable("latest", "next")
    assertNotComparable("latest", "^1.0.0")
    assertNotComparable("catalog:", "^1.0.0")
    assertNotComparable("$foo", "^2.0.0")
    assert.equal(resolve("latest", "latest").comparable, true)
    assert.equal(resolve("github:u/r#main", "github:u/r#main").comparable, true)
  })

  test("corepack specs compare within the same package manager, hashes and all", () => {
    assertOrdered("pnpm@8.15.0", "pnpm@9.1.0", "pnpm@9.1.0", "pnpm@8.15.0")
    assertOrdered("pnpm@9.1.0+sha512.abc", "pnpm@10.0.0+sha512.def", "pnpm@10.0.0+sha512.def", "pnpm@9.1.0+sha512.abc")
    assertNotComparable("pnpm@9.1.0", "yarn@4.0.0")
  })

  test("ours and theirs never need an order", () => {
    for (const strategy of ["ours", "theirs"] as const) {
      const result = resolve("github:u/r#abc", "file:../x", strategy)
      assert.equal(result.comparable, true)
      assert.equal(result.resolved, strategy === "ours" ? "github:u/r#abc" : "file:../x")
    }
  })

  test("for every pair: the order does not depend on the side, and without one ours is kept", () => {
    const specs = [
      "1.0.0",
      "2.0.0-beta.1",
      "^1.2.0",
      "~1.2.0",
      "1.x",
      "*",
      "",
      "latest",
      "v1.2",
      "1.2.3.4",
      "npm:foo@^1.0.0",
      "npm:foo@^2.0.0",
      "npm:bar@^1.0.0",
      "workspace:*",
      "workspace:^1.0.0",
      "github:u/r#v1.0.0",
      "github:u/r#v2.0.0",
      "github:u/r#abc123",
      "file:../x-1.0.0.tgz",
      "https://example.com/x-2.0.0.tgz",
      "pnpm@9.0.0",
      "yarn@4.0.0",
    ]
    for (const ours of specs) {
      for (const theirs of specs) {
        for (const strategy of ["highest", "lowest"] as const) {
          const result = resolve(ours, theirs, strategy)
          const swapped = resolve(theirs, ours, strategy)
          const pair = `${strategy}("${ours}", "${theirs}")`
          assert.equal(result.comparable, swapped.comparable, `${pair}: comparable one way only`)
          assert(result.resolved === ours || result.resolved === theirs, `${pair} invented "${result.resolved}"`)
          if (!result.comparable) {
            assert.equal(result.resolved, ours, `${pair}: no order keeps ours`)
          }
        }
      }
    }
  })
})

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

describe("specs that cannot be compared, in package.json", () => {
  const base = {
    name: "app",
    packageManager: "pnpm@9.0.0",
    dependencies: {foo: "^1.0.0", bar: "file:../bar-1.0.0.tgz", baz: "npm:baz@^1.0.0", qux: "github:u/qux#abc123"},
  }
  const ours = {
    name: "app",
    packageManager: "pnpm@9.1.0",
    dependencies: {
      foo: "github:u/foo#v1.5.0",
      bar: "file:../bar-1.1.0.tgz",
      baz: "npm:baz@^1.1.0",
      qux: "github:u/qux#abc124",
    },
  }
  const theirs = {
    name: "app",
    packageManager: "yarn@4.1.0",
    dependencies: {foo: "^2.0.0", bar: "file:../bar-2.0.0.tgz", baz: "npm:baz@^2.0.0", qux: "github:u/qux#def456"},
  }

  for (const strategy of ["highest", "lowest"] as const) {
    test(`${strategy} leaves them for the user, and still decides the specs it can order`, async () => {
      const result = await resolver(strategy).mergeJsonContents(j(base), j(ours), j(theirs))
      assert.equal(result.resolved, true, result.errors.join(", "))
      assert.deepEqual(
        result.unresolved?.map(conflict => [
          conflict.field,
          conflict.reason,
          conflict.ours,
          conflict.theirs,
          conflict.base,
        ]),
        [
          ["packageManager", "not-comparable", "pnpm@9.1.0", "yarn@4.1.0", "pnpm@9.0.0"],
          ["dependencies.foo", "not-comparable", "github:u/foo#v1.5.0", "^2.0.0", "^1.0.0"],
          [
            "dependencies.bar",
            "not-comparable",
            "file:../bar-1.1.0.tgz",
            "file:../bar-2.0.0.tgz",
            "file:../bar-1.0.0.tgz",
          ],
          ["dependencies.qux", "not-comparable", "github:u/qux#abc124", "github:u/qux#def456", "github:u/qux#abc123"],
        ]
      )
      // Our specs hold the places left open; the aliases of the same package were ordered
      assert.deepEqual(result.packageJson, {
        ...ours,
        dependencies: {...ours.dependencies, baz: strategy === "highest" ? "npm:baz@^2.0.0" : "npm:baz@^1.1.0"},
      })
    })
  }

  test("the dependencies among them are package conflicts too, so a version can be picked for them", async () => {
    const result = await resolver().mergeJsonContents(j(base), j(ours), j(theirs))
    assert.deepEqual(
      result.packageConflicts?.map(conflict => [conflict.name, conflict.resolved, conflict.resolvedBy]),
      [
        ["foo", null, "user"],
        ["bar", null, "user"],
        ["baz", "npm:baz@^2.0.0", "highest"],
        ["qux", null, "user"],
      ]
    )
  })

  test("ours, theirs and a picked version decide them", async () => {
    const withOurs = await resolver("ours").mergeJsonContents(j(base), j(ours), j(theirs))
    assert.deepEqual(withOurs.unresolved, [])
    assert.deepEqual(withOurs.packageJson, ours)

    const withTheirs = await resolver("theirs").mergeJsonContents(j(base), j(ours), j(theirs))
    assert.deepEqual(withTheirs.unresolved, [])
    assert.deepEqual(withTheirs.packageJson, theirs)

    const picked = await resolver("highest", {picks: {foo: "^2.1.0", qux: "github:u/qux#v3.0.0"}}).mergeJsonContents(
      j(base),
      j(ours),
      j(theirs)
    )
    assert.equal(picked.packageJson!.dependencies?.foo, "^2.1.0")
    assert.equal(picked.packageJson!.dependencies?.qux, "github:u/qux#v3.0.0")
    assert.deepEqual(
      picked.unresolved?.map(conflict => conflict.field),
      ["packageManager", "dependencies.bar"]
    )
  })

  test("the package's own version, when semver cannot read it, is left for the user too", async () => {
    const result = await resolver().mergeJsonContents(
      j({name: "app", version: "1.0.0"}),
      j({name: "app", version: "1.0.0.1"}),
      j({name: "app", version: "1.0.1"})
    )
    assert.deepEqual(
      result.unresolved?.map(conflict => [conflict.field, conflict.reason]),
      [["version", "not-comparable"]]
    )
    assert.deepEqual(result.packageConflicts, [], "the version of the package itself is no dependency")
  })

  test("a lockfile keeps ours, and says ours decided", async () => {
    const lock = (spec: string, version: string, integrity: string) => ({
      name: "app",
      lockfileVersion: 1,
      requires: true,
      dependencies: {foo: {version, from: spec, integrity}},
    })
    const result = await resolver().mergeJsonContents(
      "",
      j(lock("github:u/foo#v1", "github:u/foo#aaaa", "sha512-a")),
      j(lock("github:u/foo#v2", "github:u/foo#bbbb", "sha512-b"))
    )
    assert.deepEqual(result.unresolved, [], "a lockfile leaves nothing for the user")
    assert.equal((result.packageJson as any).dependencies.foo.version, "github:u/foo#aaaa")
    assert.deepEqual(
      result.packageConflicts?.map(conflict => [conflict.location, conflict.resolved, conflict.resolvedBy]),
      [["node_modules/foo", "github:u/foo#aaaa", "ours"]]
    )

    const rootSpec = (foo: string) => ({name: "app", lockfileVersion: 3, packages: {"": {dependencies: {foo}}}})
    const spec = await resolver().mergeJsonContents("", j(rootSpec("github:u/foo#v1")), j(rootSpec("^2.0.0")))
    assert.equal(spec.packageJson!.packages[""].dependencies.foo, "github:u/foo#v1")
    assert.deepEqual(
      spec.packageConflicts?.map(conflict => [conflict.location, conflict.resolvedBy]),
      [["root › dependencies", "ours"]]
    )
  })
})

describe("specs that cannot be compared, in the block-based fallback", () => {
  // Our side is not valid JSON (a comment), so the semantic merge cannot read it
  const dependencies = [
    "{",
    '  "name": "app",',
    '  "dependencies": {',
    "<<<<<<< HEAD",
    '    "foo": "github:u/foo#v1.0.0", // pinned',
    '    "lodash": "^4.17.21"',
    "=======",
    '    "foo": "^2.0.0",',
    '    "lodash": "^4.17.20"',
    ">>>>>>> feature",
    "  }",
    "}",
  ].join("\n")

  test("it cannot leave one spec open, so it resolves nothing and names the spec", async () => {
    const result = await resolver().resolveConflicts(dependencies)
    assert.equal(result.resolved, false)
    assert.deepEqual(result.errors, [
      "dependencies.foo changed on both branches to versions that cannot be compared, which the highest strategy cannot decide: resolve it by hand, or with the ours or theirs strategy",
    ])
  })

  test("theirs, or a version picked for the package, resolves it", async () => {
    const withTheirs = await resolver("theirs").resolveConflicts(dependencies)
    assert.equal(withTheirs.resolved, true, withTheirs.errors.join(", "))
    assert.deepEqual(withTheirs.packageJson!.dependencies, {foo: "^2.0.0", lodash: "^4.17.20"})

    const picked = await resolver("highest", {picks: {foo: "^2.0.0"}}).resolveConflicts(dependencies)
    assert.equal(picked.resolved, true, picked.errors.join(", "))
    assert.deepEqual(picked.packageJson!.dependencies, {foo: "^2.0.0", lodash: "^4.17.21"})
  })

  test("values that are not versions and specs that cannot be compared are named together", async () => {
    const content = [
      "{",
      '  "scripts": {',
      "<<<<<<< HEAD",
      '    "build": "tsc -b", // strict',
      '    "test": "jest"',
      "=======",
      '    "build": "tsc && vite build",',
      '    "test": "jest"',
      ">>>>>>> feature",
      "  },",
      '  "dependencies": {',
      "<<<<<<< HEAD",
      '    "foo": "github:u/foo#v1.0.0"',
      "=======",
      '    "foo": "^2.0.0"',
      ">>>>>>> feature",
      "  }",
      "}",
    ].join("\n")

    const result = await resolver().resolveConflicts(content)
    assert.equal(result.resolved, false)
    assert.deepEqual(result.errors, [
      "scripts.build changed on both branches and is not a version, and dependencies.foo changed on both branches to versions that cannot be compared, which the highest strategy cannot decide: resolve them by hand, or with the ours or theirs strategy",
    ])
  })

  test("the package's own version is not decided either", async () => {
    const content = [
      "{",
      '  "name": "app",',
      "<<<<<<< HEAD",
      '  "version": "1.0.0.1", // build number',
      "=======",
      '  "version": "1.0.1",',
      ">>>>>>> feature",
      '  "private": true',
      "}",
    ].join("\n")

    const result = await resolver("lowest").resolveConflicts(content)
    assert.equal(result.resolved, false)
    assert.match(
      result.errors.join(", "),
      /^version changed on both branches to versions that cannot be compared, which the lowest strategy/
    )
  })

  test("a lock entry fragment with versions that cannot be compared keeps ours, as the semantic merge does", async () => {
    const entry = (version: string, comment = "") => [
      '    "node_modules/foo": {',
      `      "version": "${version}",${comment}`,
      `      "resolved": "git+ssh://git@github.com/u/foo.git#${version.slice(-4)}"`,
      "    }",
    ]
    const content = [
      "{",
      '  "name": "app",',
      '  "lockfileVersion": 3,',
      '  "packages": {',
      "<<<<<<< HEAD",
      ...entry("github:u/foo#aaaa"),
      "=======",
      // Their side cannot be parsed, and ours is kept
      ...entry("github:u/foo#bbbb", " // theirs"),
      ">>>>>>> feature",
      "  }",
      "}",
    ].join("\n")

    const result = await resolver().resolveConflicts(content)
    assert.equal(result.resolved, true, result.errors.join(", "))
    assert.equal(result.packageJson!.packages["node_modules/foo"].version, "github:u/foo#aaaa")
    assert.deepEqual(
      result.packageConflicts?.map(conflict => conflict.resolvedBy),
      ["ours"]
    )
  })
})

describe("the CLI with specs that cannot be compared", () => {
  const base = {name: "app", dependencies: {foo: "^1.0.0"}}
  const ours = {name: "app", dependencies: {foo: "github:u/foo#v1.5.0"}}
  const theirs = {name: "app", dependencies: {foo: "^2.0.0"}}

  test("the merge driver names them with both specs, suggests --pick and exits 1", async () => {
    await withTempDir(async dir => {
      const [current, ancestor, other] = ["current.json", "base.json", "other.json"].map(name => join(dir, name)) as [
        string,
        string,
        string,
      ]
      await writeFile(ancestor, j(base), "utf8")
      await writeFile(current, j(ours), "utf8")
      await writeFile(other, j(theirs), "utf8")

      const result = await runCli(["merge-driver", current, ancestor, other], dir)
      assert.equal(result.code, 1)
      assert.deepEqual(result.stderr.trim().split("\n"), [
        "package-conflicts-resolver: left a value between conflict markers for you to decide:",
        "  - dependencies.foo: both branches changed it, to versions that cannot be compared (github:u/foo#v1.5.0 and ^2.0.0)",
        "package-conflicts-resolver: everything else is merged. Edit it, or run package-conflicts-resolver --pick <package>@<version> or --strategy ours (or theirs) on the file.",
      ])
      assert.equal(
        await readFile(current, "utf8"),
        [
          "{",
          '  "name": "app",',
          '  "dependencies": {',
          "<<<<<<< ours",
          '    "foo": "github:u/foo#v1.5.0"',
          "||||||| base",
          '    "foo": "^1.0.0"',
          "=======",
          '    "foo": "^2.0.0"',
          ">>>>>>> theirs",
          "  }",
          "}",
          "",
        ].join("\n")
      )
    })
  })

  test("--list shows them as left for you, and the hint picks one of them", async () => {
    await withTempDir(async dir => {
      await writeFile(join(dir, "package.json"), conflictedDocument(ours, theirs, base), "utf8")

      const list = await runCli(["--list"], dir)
      assert.equal(list.code, 0, list.stderr)
      const lines = list.stdout.split("\n")
      assert(
        lines.some(line =>
          /^ {3}foo +dependencies +github:u\/foo#v1\.5\.0 +\^2\.0\.0 +\^1\.0\.0 +\(left for you\)$/.test(line)
        ),
        list.stdout
      )
      assert(!list.stdout.includes("Left for you to decide:"), "a package left for you is only in the table")
      assert(
        lines.includes("Choose the version of a package with --pick <name>@<version>, for example --pick foo@^2.0.0")
      )

      const [report] = jsonLines((await runCli(["--list", "--json"], dir)).stdout)
      assert.deepEqual(report.files[0].unresolved, [
        {
          field: "dependencies.foo",
          path: ["dependencies", "foo"],
          reason: "not-comparable",
          ours: "github:u/foo#v1.5.0",
          theirs: "^2.0.0",
          base: "^1.0.0",
        },
      ])
    })
  })

  test("a run says why they were left, and --pick resolves them", async () => {
    await withTempDir(async dir => {
      const file = join(dir, "package.json")
      await writeFile(file, conflictedDocument(ours, theirs, base), "utf8")

      const open = await runCli(["--no-regenerate-lock"], dir)
      assert.equal(open.code, 1)
      assert(
        open.stderr.includes(
          [
            "⚠️  Left a value between conflict markers in package.json for you to decide:",
            "   - dependencies.foo: both branches changed it, to versions that cannot be compared (github:u/foo#v1.5.0 and ^2.0.0)",
            "   Everything else is merged. Edit it, or run again with --pick <package>@<version>, --strategy ours or --strategy theirs.",
          ].join("\n")
        ),
        open.stderr
      )

      const picked = await runCli(["--pick", "foo@^2.0.0", "--no-version-check", "--no-regenerate-lock"], dir)
      assert.equal(picked.code, 0, picked.stderr)
      assert.deepEqual(JSON.parse(await readFile(file, "utf8")), {name: "app", dependencies: {foo: "^2.0.0"}})
    })
  })
})
