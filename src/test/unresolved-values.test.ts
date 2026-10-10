/**
 * Values both branches changed that are not versions: a script, the
 * description, a boolean, an object... The highest and lowest strategies have
 * no order for them, so a package.json leaves them for the user, between Git
 * conflict markers around just their property, while everything else merges.
 */

import {strict as assert} from "assert"
import {test, describe} from "node:test"
import {readFile, writeFile} from "fs/promises"
import {join} from "node:path"
import {ConflictParser} from "../conflict-parser.js"
import {PackageResolver} from "../package-resolver.js"
import {CliOptions} from "../types.js"
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

// A three-way merge: the description, private and the build script changed on both branches
const BASE = {
  name: "app",
  version: "1.0.0",
  description: "old",
  scripts: {build: "tsc", test: "jest"},
  dependencies: {lodash: "^4.17.20"},
}
const OURS = {
  name: "app",
  version: "1.1.0",
  description: "ours",
  private: true,
  scripts: {build: "tsc -b", test: "jest", lint: "eslint ."},
  dependencies: {lodash: "^4.17.21"},
}
const THEIRS = {
  name: "app",
  version: "1.2.0",
  description: "theirs",
  private: false,
  scripts: {build: "tsc && vite build", test: "vitest"},
  dependencies: {lodash: "^4.17.20", react: "^18.0.0"},
}

/**
 * What a run leaves in package.json for the three-way merge above, with
 * highest: every conflict shows the common ancestor, which did not have private
 */
const WRITTEN = [
  "{",
  '  "name": "app",',
  '  "version": "1.2.0",',
  "<<<<<<< ours",
  '  "description": "ours",',
  "||||||| base",
  '  "description": "old",',
  "=======",
  '  "description": "theirs",',
  ">>>>>>> theirs",
  "<<<<<<< ours",
  '  "private": true,',
  "||||||| base",
  "=======",
  '  "private": false,',
  ">>>>>>> theirs",
  '  "scripts": {',
  "<<<<<<< ours",
  '    "build": "tsc -b",',
  "||||||| base",
  '    "build": "tsc",',
  "=======",
  '    "build": "tsc && vite build",',
  ">>>>>>> theirs",
  '    "test": "vitest",',
  '    "lint": "eslint ."',
  "  },",
  '  "dependencies": {',
  '    "lodash": "^4.17.21",',
  '    "react": "^18.0.0"',
  "  }",
  "}",
  "",
].join("\n")

/** Merge, then write the result the way the CLI does, and return the file's text */
async function mergeAndWrite(
  base: unknown,
  ours: unknown,
  theirs: unknown,
  original = j(ours),
  strategy: CliOptions["strategy"] = "highest"
): Promise<string> {
  const merger = resolver(strategy)
  const result = await merger.mergeJsonContents(j(base), j(ours), j(theirs))
  assert.equal(result.resolved, true, result.errors.join(", "))
  return withTempDir(async dir => {
    const file = join(dir, "package.json")
    await merger.writeResolvedPackage(result.packageJson!, file, original, result.unresolved)
    return readFile(file, "utf8")
  })
}

describe("values that are not versions, in package.json", () => {
  for (const strategy of ["highest", "lowest"] as const) {
    test(`${strategy} leaves them for the user and merges everything else`, async () => {
      const result = await resolver(strategy).mergeJsonContents(j(BASE), j(OURS), j(THEIRS))
      assert.equal(result.resolved, true, result.errors.join(", "))

      assert.deepEqual(result.unresolved, [
        {
          field: "description",
          path: ["description"],
          reason: "not-a-version",
          ours: "ours",
          theirs: "theirs",
          base: "old",
        },
        {field: "private", path: ["private"], reason: "not-a-version", ours: true, theirs: false},
        {
          field: "scripts.build",
          path: ["scripts", "build"],
          reason: "not-a-version",
          ours: "tsc -b",
          theirs: "tsc && vite build",
          base: "tsc",
        },
      ])
      // Only the version was decided by the strategy; our values hold the places left open
      assert.deepEqual(
        result.conflicts.map(conflict => conflict.field),
        ["version"]
      )
      assert.deepEqual(result.packageJson, {
        name: "app",
        version: strategy === "highest" ? "1.2.0" : "1.1.0",
        description: "ours",
        private: true,
        scripts: {build: "tsc -b", test: "vitest", lint: "eslint ."},
        dependencies: {lodash: "^4.17.21", react: "^18.0.0"},
      })
    })
  }

  test("objects, arrays of objects, null and mixed types are no versions either, while numbers keep an order", async () => {
    const ours = {exports: "./index.js", contributors: [{name: "Ann"}], funding: null, config: {port: 1}}
    const theirs = {exports: {".": "./dist/index.js"}, contributors: [{name: "Bob"}], funding: "x", config: {port: 2}}

    const result = await resolver().mergeJsonContents("", j(ours), j(theirs))
    assert.deepEqual(
      result.unresolved?.map(conflict => conflict.field),
      ["exports", "contributors", "funding"]
    )
    assert.equal(result.packageJson!.config.port, 2)
  })

  test("ours and theirs decide them like any other conflict", async () => {
    const withOurs = await resolver("ours").mergeJsonContents(j(BASE), j(OURS), j(THEIRS))
    assert.deepEqual(withOurs.unresolved, [])
    assert.equal(withOurs.packageJson!.description, "ours")
    assert.equal(withOurs.packageJson!.scripts?.build, "tsc -b")

    const withTheirs = await resolver("theirs").mergeJsonContents(j(BASE), j(OURS), j(THEIRS))
    assert.deepEqual(withTheirs.unresolved, [])
    assert.equal(withTheirs.packageJson!.description, "theirs")
    assert.equal(withTheirs.packageJson!.private, false)
    assert.equal(withTheirs.packageJson!.scripts?.build, "tsc && vite build")
  })

  test("a value one branch changed, or both changed alike, is no conflict", async () => {
    const result = await resolver().mergeJsonContents(
      j({description: "old", scripts: {build: "tsc"}}),
      j({description: "new", scripts: {build: "tsc -b"}}),
      j({description: "old", scripts: {build: "tsc -b"}})
    )
    assert.deepEqual(result.unresolved, [])
    assert.deepEqual(result.packageJson, {description: "new", scripts: {build: "tsc -b"}})
  })

  test("versions, ranges and package manager specs are still decided", async () => {
    const result = await resolver().mergeJsonContents(
      "",
      j({version: "1.9.0", packageManager: "pnpm@9.1.0", engines: {node: ">=18"}, dependencies: {a: "^1.0.0"}}),
      j({version: "1.10.0", packageManager: "pnpm@10.0.0", engines: {node: ">=20"}, dependencies: {a: "^1.2.0"}})
    )
    assert.deepEqual(result.unresolved, [])
    assert.deepEqual(result.packageJson, {
      version: "1.10.0",
      packageManager: "pnpm@10.0.0",
      engines: {node: ">=20"},
      dependencies: {a: "^1.2.0"},
    })
  })

  test("a lockfile leaves nothing for the user: it keeps ours, and npm regenerates it", async () => {
    const lock = (license: string) => ({
      name: "app",
      lockfileVersion: 3,
      packages: {"": {name: "app", license}},
    })
    const result = await resolver().mergeJsonContents("", j(lock("MIT")), j(lock("ISC")))
    assert.deepEqual(result.unresolved, [])
    assert.equal(result.packageJson!.packages[""].license, "MIT")
    assert.deepEqual(
      result.conflicts.map(conflict => [conflict.field, conflict.strategy]),
      [["packages..license", "ours"]]
    )
  })

  test("conflict markers in the input leave the same values, with the base when diff3 markers have it", async () => {
    const twoWay = await resolver().resolveConflicts(conflictedDocument(OURS, THEIRS))
    assert.deepEqual(
      twoWay.unresolved?.map(conflict => [conflict.field, conflict.base]),
      [
        ["description", undefined],
        ["private", undefined],
        ["scripts.build", undefined],
        ["scripts.test", undefined],
      ],
      "without the ancestor, a script only one branch changed looks changed on both"
    )

    const threeWay = await resolver().resolveConflicts(conflictedDocument(OURS, THEIRS, BASE))
    assert.deepEqual(
      threeWay.unresolved?.map(conflict => [conflict.field, conflict.base]),
      [
        ["description", "old"],
        ["private", undefined],
        ["scripts.build", "tsc"],
      ]
    )
  })
})

describe("writing values left for the user", () => {
  test("only their properties get conflict markers; the rest reads as JSON.stringify writes it", async () => {
    assert.equal(await mergeAndWrite(BASE, OURS, THEIRS), WRITTEN)
  })

  test("the last property takes no comma, and values over several lines keep their indentation", async () => {
    const ours = {name: "app", exports: "./index.js"}
    const theirs = {name: "app", exports: {".": "./dist/index.js", "./package.json": "./package.json"}}
    const original = JSON.stringify(ours, null, 4).replace(/\n/g, "\r\n") + "\r\n"

    assert.equal(
      await mergeAndWrite({name: "app"}, ours, theirs, original),
      [
        "{",
        '    "name": "app",',
        "<<<<<<< ours",
        '    "exports": "./index.js"',
        "=======",
        '    "exports": {',
        '        ".": "./dist/index.js",',
        '        "./package.json": "./package.json"',
        "    }",
        ">>>>>>> theirs",
        "}",
        "",
      ].join("\r\n")
    )
  })

  test("tabs, and keys that need escaping", async () => {
    const ours = {scripts: {'say "hi"': "echo a", other: "x"}}
    const theirs = {scripts: {'say "hi"': "echo b", other: "x"}}
    const original = JSON.stringify(ours, null, "\t")

    assert.equal(
      await mergeAndWrite({scripts: {'say "hi"': "echo", other: "x"}}, ours, theirs, original),
      [
        "{",
        '\t"scripts": {',
        "<<<<<<< ours",
        '\t\t"say \\"hi\\"": "echo a",',
        "||||||| base",
        '\t\t"say \\"hi\\"": "echo",',
        "=======",
        '\t\t"say \\"hi\\"": "echo b",',
        ">>>>>>> theirs",
        '\t\t"other": "x"',
        "\t}",
        "}",
      ].join("\n")
    )
  })

  test("a document with nothing left to decide is written exactly as before", async () => {
    const ours = {name: "app", version: "1.1.0"}
    const written = await mergeAndWrite({name: "app", version: "1.0.0"}, ours, {name: "app", version: "1.2.0"})
    assert.equal(written, j({name: "app", version: "1.2.0"}))
  })

  test("the file finishes with ours or theirs, and highest leaves the same values again", async () => {
    assert.equal(ConflictParser.parseConflicts(WRITTEN).length, 3)

    const withOurs = await resolver("ours").resolveConflicts(WRITTEN)
    assert.deepEqual(withOurs.unresolved, [])
    assert.deepEqual(withOurs.packageJson, {
      name: "app",
      version: "1.2.0",
      description: "ours",
      private: true,
      scripts: {build: "tsc -b", test: "vitest", lint: "eslint ."},
      dependencies: {lodash: "^4.17.21", react: "^18.0.0"},
    })

    const withTheirs = await resolver("theirs").resolveConflicts(WRITTEN)
    assert.equal(withTheirs.packageJson!.description, "theirs")
    assert.equal(withTheirs.packageJson!.private, false)
    assert.equal(withTheirs.packageJson!.scripts?.build, "tsc && vite build")

    // A run with highest changes nothing: the same values stay open, written the same way
    const again = resolver()
    const result = await again.resolveConflicts(WRITTEN)
    assert.deepEqual(
      result.unresolved?.map(conflict => conflict.field),
      ["description", "private", "scripts.build"]
    )
    await withTempDir(async dir => {
      const file = join(dir, "package.json")
      await again.writeResolvedPackage(result.packageJson!, file, WRITTEN, result.unresolved)
      assert.equal(await readFile(file, "utf8"), WRITTEN)
    })
  })

  test("a dry run writes nothing", async () => {
    await withTempDir(async dir => {
      const file = join(dir, "package.json")
      const content = conflictedDocument(OURS, THEIRS, BASE)
      await writeFile(file, content, "utf8")

      const dryRun = resolver("highest", {dryRun: true})
      const result = await dryRun.resolveConflicts(content)
      await dryRun.writeResolvedPackage(result.packageJson!, file, content, result.unresolved)
      assert.equal(await readFile(file, "utf8"), content)
    })
  })
})

describe("values that are not versions in the block-based fallback", () => {
  // Our side is not valid JSON (a comment), so the semantic merge cannot read it
  const content = [
    "{",
    '  "version": "1.0.0",',
    '  "scripts": {',
    "<<<<<<< HEAD",
    '    "build": "tsc -b", // strict',
    '    "test": "jest"',
    "=======",
    '    "build": "tsc && vite build",',
    '    "test": "jest"',
    ">>>>>>> feature",
    "  }",
    "}",
  ].join("\n")

  test("it cannot leave one property open, so it resolves nothing and names the value", async () => {
    const result = await resolver().resolveConflicts(content)
    assert.equal(result.resolved, false)
    assert.deepEqual(result.errors, [
      "scripts.build changed on both branches and is not a version, which the highest strategy cannot decide: resolve it by hand, or with the ours or theirs strategy",
    ])
  })

  test("several values are named together", async () => {
    const several = [
      "{",
      '  "scripts": {',
      "<<<<<<< HEAD",
      '    "build": "tsc -b", // strict',
      '    "test": "jest"',
      "=======",
      '    "build": "tsc && vite build",',
      '    "test": "vitest"',
      ">>>>>>> feature",
      "  }",
      "}",
    ].join("\n")

    const result = await resolver("lowest").resolveConflicts(several)
    assert.equal(result.resolved, false)
    assert.deepEqual(result.errors, [
      "scripts.build, scripts.test changed on both branches and are not versions, which the lowest strategy cannot decide: resolve them by hand, or with the ours or theirs strategy",
    ])
  })

  test("a block without a version to go by is not decided either", async () => {
    const block = [
      "{",
      '  "version": "1.0.0",',
      '  "files":',
      "<<<<<<< HEAD",
      "  [",
      '    "dist"',
      "  ]",
      "=======",
      "  [",
      '    "lib" // old layout',
      "  ]",
      ">>>>>>> feature",
      "}",
    ].join("\n")

    const result = await resolver().resolveConflicts(block)
    assert.equal(result.resolved, false)
    assert.match(result.errors.join(", "), /^files changed on both branches and is not a version/)
  })

  test("ours and theirs still resolve it", async () => {
    const result = await resolver("theirs").resolveConflicts(content)
    assert.equal(result.resolved, true, result.errors.join(", "))
    assert.deepEqual(result.packageJson?.scripts, {build: "tsc && vite build", test: "jest"})
  })
})

describe("the CLI with values left for the user", () => {
  const ours = {name: "app", scripts: {build: "tsc -b", test: "jest"}, dependencies: {lodash: "^4.17.19"}}
  const theirs = {name: "app", scripts: {build: "tsc && vite build", test: "jest"}, dependencies: {lodash: "^4.17.21"}}
  const BUILD_CONFLICT = [
    "<<<<<<< ours",
    '    "build": "tsc -b",',
    "=======",
    '    "build": "tsc && vite build",',
    ">>>>>>> theirs",
  ].join("\n")

  test("writes them between markers, merges the rest, says how to finish and exits 1", async () => {
    await withTempDir(async dir => {
      const file = join(dir, "package.json")
      await writeFile(file, conflictedDocument(ours, theirs), "utf8")

      const result = await runCli(["--no-regenerate-lock"], dir)
      assert.equal(result.code, 1, result.stderr)
      assert(
        result.stderr.includes(
          [
            "⚠️  Left a value between conflict markers in package.json for you to decide:",
            "   - scripts.build: both branches changed it, and it is not a version",
            "   Everything else is merged. Edit it, or run again with --strategy ours or --strategy theirs.",
          ].join("\n")
        ),
        result.stderr
      )

      const written = await readFile(file, "utf8")
      assert(written.includes(BUILD_CONFLICT), written)
      assert.equal(ConflictParser.parseConflicts(written).length, 1)
      assert(written.includes('"lodash": "^4.17.21"'), "the dependency was merged")

      const finish = await runCli(["--strategy", "theirs", "--no-regenerate-lock"], dir)
      assert.equal(finish.code, 0, finish.stderr)
      assert.deepEqual(JSON.parse(await readFile(file, "utf8")), {
        name: "app",
        scripts: {build: "tsc && vite build", test: "jest"},
        dependencies: {lodash: "^4.17.21"},
      })
    })
  })

  test("--json reports them in a warning record, with both values", async () => {
    await withTempDir(async dir => {
      await writeFile(join(dir, "package.json"), conflictedDocument(ours, theirs), "utf8")

      const result = await runCli(["--json", "--no-regenerate-lock"], dir)
      assert.equal(result.code, 1)
      const warning = jsonLines(result.stdout).find(record => record.level === "warn")
      assert.deepEqual(warning.data, {
        unresolved: [
          {
            field: "scripts.build",
            path: ["scripts", "build"],
            reason: "not-a-version",
            ours: "tsc -b",
            theirs: "tsc && vite build",
          },
        ],
      })
    })
  })

  test("--dry-run changes nothing and still exits 1; --quiet keeps the warning", async () => {
    await withTempDir(async dir => {
      const file = join(dir, "package.json")
      const content = conflictedDocument(ours, theirs)
      await writeFile(file, content, "utf8")

      const dryRun = await runCli(["--dry-run"], dir)
      assert.equal(dryRun.code, 1)
      assert.match(dryRun.stderr, /Would leave a value between conflict markers in package\.json/)
      assert.equal(await readFile(file, "utf8"), content)

      const quiet = await runCli(["--quiet", "--no-regenerate-lock"], dir)
      assert.equal(quiet.code, 1)
      assert.equal(quiet.stdout, "")
      assert.match(quiet.stderr, /scripts\.build: both branches changed it, and it is not a version/)
    })
  })

  test("--list shows them as left for the user", async () => {
    await withTempDir(async dir => {
      await writeFile(join(dir, "package.json"), conflictedDocument(ours, theirs), "utf8")

      const list = await runCli(["--list"], dir)
      assert.equal(list.code, 0, list.stderr)
      assert(list.stdout.includes("   Left for you to decide: scripts.build (ours tsc -b, theirs tsc && vite build)"))

      const json = await runCli(["--list", "--json"], dir)
      const [report] = jsonLines(json.stdout)
      assert.deepEqual(report.files[0].unresolved, [
        {
          field: "scripts.build",
          path: ["scripts", "build"],
          reason: "not-a-version",
          ours: "tsc -b",
          theirs: "tsc && vite build",
        },
      ])
    })
  })

  test("the merge driver writes the markers and exits 1, so Git stops before committing", async () => {
    await withTempDir(async dir => {
      const [current, base, other] = ["current.json", "base.json", "other.json"].map(name => join(dir, name)) as [
        string,
        string,
        string,
      ]
      await writeFile(base, j({...ours, scripts: {build: "tsc", test: "jest"}}), "utf8")
      await writeFile(current, j(ours), "utf8")
      await writeFile(other, j(theirs), "utf8")

      const result = await runCli(["merge-driver", current, base, other], dir)
      assert.equal(result.code, 1)
      assert.deepEqual(result.stderr.trim().split("\n"), [
        "package-conflicts-resolver: left a value between conflict markers for you to decide:",
        "  - scripts.build: both branches changed it, and it is not a version",
        "package-conflicts-resolver: everything else is merged. Edit it, or run package-conflicts-resolver --strategy ours (or theirs) on the file.",
      ])
      // The driver knows the common ancestor, and shows it
      const written = await readFile(current, "utf8")
      assert(
        written.includes(
          [
            "<<<<<<< ours",
            '    "build": "tsc -b",',
            "||||||| base",
            '    "build": "tsc",',
            "=======",
            '    "build": "tsc && vite build",',
            ">>>>>>> theirs",
          ].join("\n")
        ),
        written
      )
      assert(written.includes('"lodash": "^4.17.21"'))
    })
  })
})

describe("a real git merge with values left for the user", () => {
  const git = (args: string[], cwd: string) => run("git", args, cwd)

  test("Git stops with only those values conflicted, and the CLI finishes the merge", async () => {
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
      await writePackage({name: "app", scripts: {build: "tsc"}, dependencies: {lodash: "^4.17.19"}})
      await commit("base")

      await git(["checkout", "-b", "feature"], dir)
      await writePackage({name: "app", scripts: {build: "tsc && vite build"}, dependencies: {lodash: "^4.17.19"}})
      await commit("feature")

      await git(["checkout", "main"], dir)
      await writePackage({name: "app", scripts: {build: "tsc -b"}, dependencies: {lodash: "^4.17.21"}})
      await commit("main")

      const merge = await git(["merge", "feature"], dir)
      assert.equal(merge.code, 1, `${merge.stdout}\n${merge.stderr}`)
      assert.match(`${merge.stdout}\n${merge.stderr}`, /CONFLICT \(content\): Merge conflict in package\.json/)
      assert.match(merge.stderr, /scripts\.build: both branches changed it, and it is not a version/)
      assert.equal((await git(["status", "--porcelain"], dir)).stdout.trim(), "UU package.json")

      const written = await readFile(join(dir, "package.json"), "utf8")
      assert.equal(ConflictParser.parseConflicts(written).length, 1)
      assert(written.includes('"lodash": "^4.17.21"'), "the dependency merged in the driver")

      const finish = await runCli(["--strategy", "ours", "--no-regenerate-lock"], dir)
      assert.equal(finish.code, 0, finish.stderr)
      assert.deepEqual(JSON.parse(await readFile(join(dir, "package.json"), "utf8")), {
        name: "app",
        scripts: {build: "tsc -b"},
        dependencies: {lodash: "^4.17.21"},
      })
      await commit("merge feature")
      assert.equal((await git(["status", "--porcelain"], dir)).stdout.trim(), "")
    })
  })
})
