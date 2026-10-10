/**
 * End-to-end tests of `--list`: the conflicted packages of package.json and
 * its lockfiles, with our, their and base versions, printed for people or as
 * JSON — without ever changing a file.
 */

import {strict as assert} from "assert"
import {test, describe, before, after} from "node:test"
import {readFile, writeFile} from "fs/promises"
import {join} from "node:path"
import {conflictedDocument, jsonLines, runCli, withTempDir} from "./cli-harness.js"
import {FakeRegistry, startFakeRegistry} from "./fake-registry.js"

const OURS = {
  name: "app",
  version: "1.1.0",
  dependencies: {lodash: "^4.17.19", react: "^18.2.0"},
  devDependencies: {typescript: "~5.4.5"},
}
const THEIRS = {
  name: "app",
  version: "1.2.0",
  dependencies: {lodash: "^4.17.21", react: "^18.3.1"},
  devDependencies: {typescript: "~5.6.2"},
}
const PACKAGE_JSON = conflictedDocument(OURS, THEIRS)

const entry = (name: string, version: string) => ({
  version,
  resolved: `https://registry.example/${name}/-/${name}-${version}.tgz`,
  integrity: `sha512-${name}-${version}`,
})

const lock = (lodash: string, react: string) => ({
  name: "app",
  lockfileVersion: 3,
  requires: true,
  packages: {
    "": {name: "app", dependencies: {lodash: "^4.17.0", react: "^18.2.0"}},
    "node_modules/lodash": entry("lodash", lodash),
    "node_modules/react": entry("react", react),
  },
})
const LOCKFILE = conflictedDocument(lock("4.17.19", "18.2.0"), lock("4.17.21", "18.3.1"))

async function setUp(dir: string, files: Record<string, string>): Promise<void> {
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content, "utf8")
  }
}

async function assertUnchanged(dir: string, files: Record<string, string>): Promise<void> {
  for (const [name, content] of Object.entries(files)) {
    assert.equal(await readFile(join(dir, name), "utf8"), content, `${name} must not change`)
  }
}

describe("--list", () => {
  let registry: FakeRegistry
  before(async () => {
    registry = await startFakeRegistry({
      lodash: ["4.17.19", "4.17.20", "4.17.21"],
      react: ["18.2.0", "18.3.1"],
      typescript: ["5.4.5", "5.5.4", "5.6.2"],
    })
  })
  after(() => registry.close())

  test("prints each conflicted package with our and their version, and changes nothing", async () => {
    await withTempDir(async dir => {
      const files = {"package.json": PACKAGE_JSON}
      await setUp(dir, files)

      const result = await runCli(["--list"], dir, registry.npmEnv)
      assert.equal(result.code, 0, result.stderr)
      assert.equal(result.stderr, "")
      assert.deepEqual(result.stdout.split("\n"), [
        "📋 package.json: 3 conflicted packages (strategy: highest)",
        "",
        "   Package     Where            Ours      Theirs    Resolved",
        "   lodash      dependencies     ^4.17.19  ^4.17.21  ^4.17.21",
        "   react       dependencies     ^18.2.0   ^18.3.1   ^18.3.1",
        "   typescript  devDependencies  ~5.4.5    ~5.6.2    ~5.6.2",
        "",
        "   Also conflicted: version (ours 1.1.0, theirs 1.2.0 → 1.2.0)",
        "",
        "Choose the version of a package with --pick <name>@<version>, for example --pick lodash@^4.17.21",
        "",
      ])
      await assertUnchanged(dir, files)
    })
  })

  test("--json prints the whole report as one JSON document", async () => {
    await withTempDir(async dir => {
      await setUp(dir, {"package.json": PACKAGE_JSON})

      const result = await runCli(["--list", "--json"], dir, registry.npmEnv)
      assert.equal(result.code, 0, result.stderr)
      const lines = jsonLines(result.stdout)
      assert.equal(lines.length, 1)
      const [report] = lines
      assert.equal(report.strategy, "highest")
      assert.equal(report.files.length, 1)
      assert.equal(report.files[0].file, "package.json")
      assert.equal(report.files[0].analyzed, true)
      assert.deepEqual(report.files[0].packages[0], {
        name: "lodash",
        kind: "spec",
        location: "dependencies",
        path: ["dependencies", "lodash"],
        ours: "^4.17.19",
        theirs: "^4.17.21",
        resolved: "^4.17.21",
        resolvedBy: "highest",
      })
      assert.deepEqual(
        report.files[0].packages.map((conflict: any) => conflict.name),
        ["lodash", "react", "typescript"]
      )
      assert.deepEqual(report.files[0].otherConflicts, [
        {field: "version", ours: "1.1.0", theirs: "1.2.0", resolved: "1.2.0"},
      ])
    })
  })

  test("lists the conflicted lockfile next to package.json", async () => {
    await withTempDir(async dir => {
      const files = {"package.json": PACKAGE_JSON, "package-lock.json": LOCKFILE}
      await setUp(dir, files)

      const result = await runCli(["--list", "--json"], dir, registry.npmEnv)
      assert.equal(result.code, 0, result.stderr)
      const [report] = jsonLines(result.stdout)
      assert.deepEqual(
        report.files.map((file: any) => file.file),
        ["package.json", "package-lock.json"]
      )
      assert.deepEqual(
        report.files[1].packages.map((c: any) => `${c.name} ${c.location} ${c.ours} ${c.theirs}`),
        ["lodash node_modules/lodash 4.17.19 4.17.21", "react node_modules/react 18.2.0 18.3.1"]
      )
      await assertUnchanged(dir, files)
    })
  })

  test("lists a conflicted lockfile even when package.json merged cleanly", async () => {
    await withTempDir(async dir => {
      await setUp(dir, {"package.json": JSON.stringify(THEIRS, null, 2), "package-lock.json": LOCKFILE})

      const result = await runCli(["--list"], dir, registry.npmEnv)
      assert.equal(result.code, 0, result.stderr)
      assert.match(result.stdout, /^📋 package-lock\.json: 2 conflicted packages \(strategy: highest\)/)
      assert.match(result.stdout, / {3}lodash {3}node_modules\/lodash {2}4\.17\.19 {2}4\.17\.21 {2}4\.17\.21\n/)
      assert.doesNotMatch(result.stdout, /📋 package\.json/)
    })
  })

  test("a lockfile without conflicts is left out", async () => {
    await withTempDir(async dir => {
      const files = {
        "package.json": PACKAGE_JSON,
        "package-lock.json": JSON.stringify(lock("4.17.21", "18.3.1"), null, 2),
      }
      await setUp(dir, files)

      const result = await runCli(["--list", "--json"], dir, registry.npmEnv)
      assert.equal(result.code, 0, result.stderr)
      const [report] = jsonLines(result.stdout)
      assert.deepEqual(
        report.files.map((file: any) => file.file),
        ["package.json"]
      )
      await assertUnchanged(dir, files)
    })
  })

  test("a lockfile targeted directly is listed on its own", async () => {
    await withTempDir(async dir => {
      await setUp(dir, {"package.json": PACKAGE_JSON, "package-lock.json": LOCKFILE})

      const result = await runCli(["package-lock.json", "--list", "--json"], dir, registry.npmEnv)
      assert.equal(result.code, 0, result.stderr)
      const [report] = jsonLines(result.stdout)
      assert.deepEqual(
        report.files.map((file: any) => file.file),
        ["package-lock.json"]
      )
    })
  })

  test("diff3 conflict markers add the common ancestor and leave one-sided changes out", async () => {
    await withTempDir(async dir => {
      const base = {...OURS, version: "1.0.0", dependencies: {lodash: "^4.17.15", react: "^18.2.0"}}
      await setUp(dir, {"package.json": conflictedDocument(OURS, THEIRS, base)})

      const result = await runCli(["--list"], dir, registry.npmEnv)
      assert.equal(result.code, 0, result.stderr)
      // react and typescript only changed on their side: no conflict to list
      assert.deepEqual(result.stdout.split("\n").slice(0, 4), [
        "📋 package.json: 1 conflicted package (strategy: highest)",
        "",
        "   Package  Where         Ours      Theirs    Base      Resolved",
        "   lodash   dependencies  ^4.17.19  ^4.17.21  ^4.17.15  ^4.17.21",
      ])
    })
  })

  test("the resolved column follows the strategy", async () => {
    await withTempDir(async dir => {
      await setUp(dir, {"package.json": PACKAGE_JSON})

      const result = await runCli(["--list", "--json", "--strategy", "lowest"], dir, registry.npmEnv)
      const [report] = jsonLines(result.stdout)
      assert.equal(report.strategy, "lowest")
      assert.deepEqual(
        report.files[0].packages.map((c: any) => [c.resolved, c.resolvedBy]),
        [
          ["^4.17.19", "lowest"],
          ["^18.2.0", "lowest"],
          ["~5.4.5", "lowest"],
        ]
      )
    })
  })

  test("says so when nothing is conflicted", async () => {
    await withTempDir(async dir => {
      await setUp(dir, {"package.json": JSON.stringify(OURS, null, 2)})

      const human = await runCli(["--list"], dir, registry.npmEnv)
      assert.equal(human.code, 0, human.stderr)
      assert.equal(human.stdout.trim(), "✅ No conflicted packages: no file has Git conflict markers")

      const json = await runCli(["--list", "--json"], dir, registry.npmEnv)
      assert.deepEqual(jsonLines(json.stdout), [{strategy: "highest", files: []}])
    })
  })

  test("notes lockfiles of other package managers without failing", async () => {
    await withTempDir(async dir => {
      const yarnLock = [
        "<<<<<<< HEAD",
        'lodash@^4.17.19:\n  version "4.17.19"',
        "=======",
        "lodash@^4.17.21:",
        ">>>>>>> feature",
        "",
      ]
      await setUp(dir, {"package.json": PACKAGE_JSON, "yarn.lock": yarnLock.join("\n")})

      const result = await runCli(["--list"], dir, registry.npmEnv)
      assert.equal(result.code, 0, result.stderr)
      assert.match(
        result.stdout,
        /⚠️ {2}yarn\.lock has conflicts that could not be analyzed: yarn resolves it when you run "yarn install"/
      )
    })
  })

  test("fails when a conflicted file cannot be analyzed", async () => {
    await withTempDir(async dir => {
      const garbage = [
        "{",
        "<<<<<<< HEAD",
        "  our garbage {{{",
        "=======",
        "  their garbage }}}",
        ">>>>>>> feature",
        "}",
      ]
      await setUp(dir, {"package.json": PACKAGE_JSON, "package-lock.json": garbage.join("\n")})

      const result = await runCli(["--list", "--json"], dir, registry.npmEnv)
      assert.equal(result.code, 1)
      const [report] = jsonLines(result.stdout)
      assert.equal(report.files[0].analyzed, true)
      assert.equal(report.files[1].file, "package-lock.json")
      assert.equal(report.files[1].analyzed, false)
      assert.equal(typeof report.files[1].reason, "string")
    })
  })

  test("the report is printed even with --quiet, since it is what was asked for", async () => {
    await withTempDir(async dir => {
      await setUp(dir, {"package.json": PACKAGE_JSON})
      const result = await runCli(["--list", "--quiet"], dir, registry.npmEnv)
      assert.equal(result.code, 0, result.stderr)
      assert.match(result.stdout, /3 conflicted packages/)
    })
  })

  test("never contacts the registry or runs a package manager without picks", async () => {
    await withTempDir(async dir => {
      const files = {"package.json": PACKAGE_JSON, "package-lock.json": LOCKFILE}
      await setUp(dir, files)
      const requests = registry.requests.length

      const result = await runCli(["--list"], dir, registry.npmEnv)
      assert.equal(result.code, 0, result.stderr)
      assert.equal(registry.requests.length, requests)
      await assertUnchanged(dir, files)
    })
  })

  test("previews picked versions, checked against the registry", async () => {
    await withTempDir(async dir => {
      const files = {"package.json": PACKAGE_JSON, "package-lock.json": LOCKFILE}
      await setUp(dir, files)

      const result = await runCli(
        ["--list", "--pick", "typescript@~5.5.4", "--pick", "react@18.2.0"],
        dir,
        registry.npmEnv
      )
      assert.equal(result.code, 0, result.stderr)
      assert.match(result.stdout, /typescript +devDependencies +~5\.4\.5 +~5\.6\.2 +~5\.5\.4 \(picked\)\n/)
      assert.match(result.stdout, /react +dependencies +\^18\.2\.0 +\^18\.3\.1 +18\.2\.0 \(picked\)\n/)
      assert.match(result.stdout, /react +node_modules\/react +18\.2\.0 +18\.3\.1 +18\.2\.0 \(picked\)\n/)
      assert.doesNotMatch(result.stdout, /Choose the version of a package/)
      assert(registry.requests.includes("typescript") && registry.requests.includes("react"))
      await assertUnchanged(dir, files)
    })
  })

  test("reports invalid picks after the list, and exits 1", async () => {
    await withTempDir(async dir => {
      await setUp(dir, {"package.json": PACKAGE_JSON})

      const result = await runCli(
        ["--list", "--json", "--pick", "lodsh@4.17.21", "--pick", "react@19.0.0", "--pick", "x@github:a/b"],
        dir,
        registry.npmEnv
      )
      assert.equal(result.code, 1)
      const [report] = jsonLines(result.stdout)
      assert.equal(report.files[0].packages.length, 3, "the list is still printed")
      assert.match(result.stderr, /❌ lodsh is not conflicted \(did you mean lodash\?\)/)
      assert.match(result.stderr, /❌ x is not conflicted/)
      assert.match(result.stderr, /❌ react@19\.0\.0 does not exist in the registry \(latest is 18\.3\.1\)/)
    })
  })

  test("warns about picks that cannot be checked", async () => {
    await withTempDir(async dir => {
      await setUp(dir, {"package.json": PACKAGE_JSON})

      const result = await runCli(["--list", "--pick", "lodash@github:lodash/lodash#4.17.21"], dir, registry.npmEnv)
      assert.equal(result.code, 0, result.stderr)
      assert.match(result.stderr, /⚠️ {2}lodash@github:lodash\/lodash#4\.17\.21 is not a registry version/)
    })
  })
})
