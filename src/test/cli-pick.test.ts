/**
 * End-to-end tests of `--pick <name>@<version>`: picked packages get the
 * picked version, every other conflict the strategy, and nothing is written
 * unless every pick is valid, conflicted and exists in the registry.
 */

import {strict as assert} from "assert"
import {test, describe, before, after} from "node:test"
import {mkdir, readFile, writeFile} from "fs/promises"
import {join} from "node:path"
import {conflictedDocument, jsonLines, runCli, withTempDir} from "./cli-harness.js"
import {FakeRegistry, startFakeRegistry} from "./fake-registry.js"

const OURS = {
  name: "app",
  version: "1.1.0",
  dependencies: {lodash: "^4.17.19", react: "^18.2.0", internal: "^1.0.0"},
  devDependencies: {typescript: "~5.4.5"},
}
const THEIRS = {
  name: "app",
  version: "1.2.0",
  dependencies: {lodash: "^4.17.21", react: "^18.3.1", internal: "^1.1.0"},
  devDependencies: {typescript: "~5.6.2"},
}
const PACKAGE_JSON = conflictedDocument(OURS, THEIRS)

const entry = (name: string, version: string) => ({
  version,
  resolved: `https://registry.example/${name}/-/${name}-${version}.tgz`,
  integrity: `sha512-${name}-${version}`,
})

const lock = (
  rootDeps: Record<string, string>,
  versions: Record<string, string>,
  rootDevDeps: Record<string, string> = {}
) => ({
  name: "app",
  lockfileVersion: 3,
  requires: true,
  packages: {
    "": {name: "app", dependencies: rootDeps, devDependencies: rootDevDeps},
    ...Object.fromEntries(
      Object.entries(versions).map(([name, version]) => [`node_modules/${name}`, entry(name, version)])
    ),
  },
})

/** The lockfile of each branch: both changed every spec, and every locked version with it */
const LOCKFILE = conflictedDocument(
  lock(
    OURS.dependencies,
    {lodash: "4.17.19", react: "18.2.0", internal: "1.0.0", typescript: "5.4.5"},
    OURS.devDependencies
  ),
  lock(
    THEIRS.dependencies,
    {lodash: "4.17.21", react: "18.3.1", internal: "1.1.0", typescript: "5.6.2"},
    THEIRS.devDependencies
  )
)

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

const readJson = async (dir: string, name: string) => JSON.parse(await readFile(join(dir, name), "utf8"))

describe("--pick", () => {
  let registry: FakeRegistry
  before(async () => {
    registry = await startFakeRegistry({
      lodash: ["4.17.19", "4.17.20", "4.17.21"],
      react: ["18.2.0", "18.3.1"],
      typescript: ["5.4.5", "5.5.4", "5.6.2"],
    })
  })
  after(() => registry.close())

  const pick = (dir: string, args: string[]) => runCli(["--no-regenerate-lock", ...args], dir, registry.npmEnv)

  test("picked packages get the picked version, every other conflict the strategy", async () => {
    await withTempDir(async dir => {
      await setUp(dir, {"package.json": PACKAGE_JSON})

      const result = await pick(dir, ["--strategy", "lowest", "--pick", "typescript@~5.5.4", "--pick", "react@18.3.1"])
      assert.equal(result.code, 0, result.stderr)
      assert.match(result.stdout, /✅ typescript@~5\.5\.4 exists in the registry \(newest match: 5\.5\.4\)/)
      assert.match(result.stdout, /✅ react@18\.3\.1 exists in the registry/)
      assert.match(result.stdout, /Field: dependencies\.react\n.*\n.*\n {2}Resolved value: 18\.3\.1 \(pick\)/)

      const written = await readJson(dir, "package.json")
      assert.deepEqual(written, {
        name: "app",
        version: "1.1.0",
        dependencies: {lodash: "^4.17.19", react: "18.3.1", internal: "^1.0.0"},
        devDependencies: {typescript: "~5.5.4"},
      })
    })
  })

  test("the picked spec is written exactly as given, and the lockfile keeps the entry that matches it", async () => {
    await withTempDir(async dir => {
      await setUp(dir, {"package.json": PACKAGE_JSON, "package-lock.json": LOCKFILE})

      // highest would take react 18.3.1: the pick keeps our side instead
      const result = await pick(dir, ["--pick", "react@~18.2.0"])
      assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`)

      assert.equal((await readJson(dir, "package.json")).dependencies.react, "~18.2.0")
      const lockfile = await readJson(dir, "package-lock.json")
      assert.equal(lockfile.packages[""].dependencies.react, "~18.2.0")
      assert.deepEqual(lockfile.packages["node_modules/react"], entry("react", "18.2.0"))
      assert.deepEqual(lockfile.packages["node_modules/lodash"], entry("lodash", "4.17.21"), "strategy for the rest")
    })
  })

  test("a version neither branch locked leaves the lockfile inconsistent until npm regenerates it", async () => {
    await withTempDir(async dir => {
      await setUp(dir, {"package.json": PACKAGE_JSON, "package-lock.json": LOCKFILE})

      const result = await pick(dir, ["--pick", "lodash@4.17.20"])
      assert.equal(result.code, 1, "without regeneration the lockfile cannot match the pick")
      assert.match(result.stderr, /the root project requires lodash@4\.17\.20 but node_modules\/lodash is 4\.17\.21/)
      assert.match(result.stderr, /npm install --package-lock-only/)
      assert.equal((await readJson(dir, "package.json")).dependencies.lodash, "4.17.20")
    })
  })

  test("a conflict only in the lockfile can be picked when one side has the version", async () => {
    await withTempDir(async dir => {
      const packageJson = JSON.stringify({name: "app", dependencies: {lodash: "^4.17.0"}}, null, 2)
      const lockfile = conflictedDocument(
        lock({lodash: "^4.17.0"}, {lodash: "4.17.19"}),
        lock({lodash: "^4.17.0"}, {lodash: "4.17.21"})
      )
      await setUp(dir, {"package.json": packageJson, "package-lock.json": lockfile})

      const result = await pick(dir, ["--pick", "lodash@4.17.19"])
      assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`)
      assert.equal((await readJson(dir, "package-lock.json")).packages["node_modules/lodash"].version, "4.17.19")
      assert.equal(await readFile(join(dir, "package.json"), "utf8"), packageJson)
    })
  })

  test("a conflict only in the lockfile cannot be picked for a version neither side has", async () => {
    await withTempDir(async dir => {
      const files = {
        "package.json": JSON.stringify({name: "app", dependencies: {lodash: "^4.17.0"}}, null, 2),
        "package-lock.json": conflictedDocument(
          lock({lodash: "^4.17.0"}, {lodash: "4.17.19"}),
          lock({lodash: "^4.17.0"}, {lodash: "4.17.21"})
        ),
      }
      await setUp(dir, files)

      const result = await pick(dir, ["--pick", "lodash@4.17.20"])
      assert.equal(result.code, 1)
      assert.match(
        result.stderr,
        /❌ lodash@4\.17\.20 cannot be applied: lodash is only conflicted in installed lockfile entries, and neither side matches 4\.17\.20 \(package-lock\.json node_modules\/lodash: ours 4\.17\.19, theirs 4\.17\.21\)/
      )
      assert.match(result.stderr, /No file was changed/)
      await assertUnchanged(dir, files)
    })
  })

  test("invalid picks are refused before anything is read from the registry", async () => {
    await withTempDir(async dir => {
      const files = {"package.json": PACKAGE_JSON}
      await setUp(dir, files)
      const requests = registry.requests.length

      for (const [args, message] of [
        [["--pick", "lodash"], /❌ Invalid --pick: "lodash" is not <name>@<version>/],
        [["--pick", "lodash@latest"], /❌ Invalid --pick: lodash@latest: "latest" is a dist-tag/],
        [["--pick", "lodash@1.0.0", "--pick", "lodash@2.0.0"], /lodash is picked twice, as 1\.0\.0 and as 2\.0\.0/],
        [["--pick", "lodash@^1 garbage"], /"\^1 garbage" is not a valid version or range/],
      ] as Array<[string[], RegExp]>) {
        const result = await pick(dir, args)
        assert.equal(result.code, 1, args.join(" "))
        assert.match(result.stderr, message)
      }
      assert.equal(registry.requests.length, requests)
      await assertUnchanged(dir, files)
    })
  })

  test("packages that are not conflicted, versions that do not exist and unknown packages are all reported", async () => {
    await withTempDir(async dir => {
      const files = {"package.json": PACKAGE_JSON}
      await setUp(dir, files)

      const result = await pick(dir, [
        "--pick",
        "lodahs@4.17.21",
        "--pick",
        "typescript@5.9.9",
        "--pick",
        "react@^19.0.0",
        "--pick",
        "internal@1.2.0",
      ])
      assert.equal(result.code, 1)
      const errors = result.stderr.split("\n").filter(line => line.startsWith("❌"))
      assert.deepEqual(errors, [
        "❌ lodahs is not conflicted (did you mean lodash?). Conflicted packages: internal, lodash, react, typescript",
        "❌ typescript@5.9.9 does not exist in the registry (latest is 5.6.2)",
        "❌ react@^19.0.0 matches no published version (latest is 18.3.1)",
        "❌ internal@1.2.0: there is no package named internal in the registry",
      ])
      assert.match(result.stderr, /No file was changed\./)
      assert.doesNotMatch(result.stdout, /Found Git conflict markers/, "resolution never started")
      await assertUnchanged(dir, files)
    })
  })

  test("an unreachable registry is reported; --no-version-check skips the check", async () => {
    await withTempDir(async dir => {
      const files = {"package.json": PACKAGE_JSON}
      await setUp(dir, files)
      const unreachable = {...registry.npmEnv, npm_config_registry: "http://127.0.0.1:9/"}

      const failed = await runCli(["--no-regenerate-lock", "--pick", "internal@1.2.0"], dir, unreachable)
      assert.equal(failed.code, 1)
      assert.match(failed.stderr, /❌ internal@1\.2\.0: could not check the registry \(.*ECONNREFUSED.*\)/)
      assert.match(failed.stderr, /Pass --no-version-check to skip this check/)
      await assertUnchanged(dir, files)

      const skipped = await runCli(
        ["--no-regenerate-lock", "--pick", "internal@1.2.0", "--no-version-check"],
        dir,
        unreachable
      )
      assert.equal(skipped.code, 0, skipped.stderr)
      assert.match(skipped.stdout, /Picked versions were not checked against the registry \(--no-version-check\)/)
      assert.equal((await readJson(dir, "package.json")).dependencies.internal, "1.2.0")
    })
  })

  test("--no-version-check still refuses picks that cannot apply", async () => {
    await withTempDir(async dir => {
      await setUp(dir, {"package.json": PACKAGE_JSON})
      const result = await pick(dir, ["--no-version-check", "--pick", "express@4.0.0"])
      assert.equal(result.code, 1)
      assert.match(result.stderr, /❌ express is not conflicted/)
    })
  })

  test("file: picks are checked on disk, git picks are used as given with a warning", async () => {
    await withTempDir(async dir => {
      await setUp(dir, {"package.json": PACKAGE_JSON})
      await mkdir(join(dir, "vendor"))

      const missing = await pick(dir, ["--pick", "internal@file:./vendor/missing"])
      assert.equal(missing.code, 1)
      assert.match(missing.stderr, /❌ internal@file:\.\/vendor\/missing: .*missing does not exist/)

      const result = await pick(dir, [
        "--pick",
        "internal@file:./vendor",
        "--pick",
        "lodash@github:lodash/lodash#4.17.21",
      ])
      assert.equal(result.code, 0, result.stderr)
      assert.match(result.stdout, /✅ internal@file:\.\/vendor: .*vendor exists/)
      assert.match(
        result.stderr,
        /lodash@github:lodash\/lodash#4\.17\.21 is not a registry version, so it cannot be checked/
      )
      const written = await readJson(dir, "package.json")
      assert.equal(written.dependencies.internal, "file:./vendor")
      assert.equal(written.dependencies.lodash, "github:lodash/lodash#4.17.21")
    })
  })

  test("--dry-run checks the picks and shows them without writing", async () => {
    await withTempDir(async dir => {
      const files = {"package.json": PACKAGE_JSON, "package-lock.json": LOCKFILE}
      await setUp(dir, files)

      const result = await runCli(["--dry-run", "--pick", "react@18.2.0"], dir, registry.npmEnv)
      assert.equal(result.code, 0, result.stderr)
      assert.match(result.stdout, /✅ react@18\.2\.0 exists in the registry/)
      assert.match(result.stdout, /Resolved value: 18\.2\.0 \(pick\)/)
      assert.match(result.stdout, /Would write resolved file to package\.json/)
      await assertUnchanged(dir, files)
    })
  })

  test("--json keeps every stdout line machine-readable", async () => {
    await withTempDir(async dir => {
      await setUp(dir, {"package.json": PACKAGE_JSON})

      const result = await pick(dir, ["--json", "--pick", "react@18.2.0", "--pick", "lodash@github:lodash/lodash"])
      assert.equal(result.code, 0, result.stderr)
      const lines = jsonLines(result.stdout)
      assert(lines.some(line => line.level === "success" && line.message === "react@18.2.0 exists in the registry"))
      assert(lines.some(line => line.level === "warn" && /cannot be checked/.test(line.message)))
      const resolved = lines.find(line => line.message === "Resolved conflicts")
      const react = resolved.data.conflicts.find((conflict: any) => conflict.field === "dependencies.react")
      assert.deepEqual([react.resolvedValue, react.strategy, react.package], ["18.2.0", "pick", "react"])
    })
  })

  test("--quiet prints nothing when everything goes well", async () => {
    await withTempDir(async dir => {
      await setUp(dir, {"package.json": PACKAGE_JSON})
      const result = await pick(dir, ["--quiet", "--pick", "react@18.2.0"])
      assert.equal(result.code, 0, result.stderr)
      assert.equal(result.stdout, "")
      assert.equal(result.stderr, "")
      assert.equal((await readJson(dir, "package.json")).dependencies.react, "18.2.0")
    })
  })

  test("picking when nothing is conflicted fails", async () => {
    await withTempDir(async dir => {
      const files = {"package.json": JSON.stringify(OURS, null, 2)}
      await setUp(dir, files)
      const result = await pick(dir, ["--pick", "react@18.2.0"])
      assert.equal(result.code, 1)
      assert.match(result.stderr, /❌ react is not conflicted: no package has conflicting versions/)
      await assertUnchanged(dir, files)
    })
  })

  test("a target that cannot be resolved fails exactly as without picks", async () => {
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
      const files = {"package.json": garbage.join("\n")}
      await setUp(dir, files)
      const result = await pick(dir, ["--pick", "react@18.2.0"])
      assert.equal(result.code, 1)
      assert.match(result.stderr, /❌ Failed to resolve conflicts: /)
      await assertUnchanged(dir, files)
    })
  })

  test("picks apply to a lockfile targeted directly", async () => {
    await withTempDir(async dir => {
      await setUp(dir, {"package-lock.json": LOCKFILE})
      const result = await pick(dir, ["package-lock.json", "--pick", "react@18.2.0"])
      assert.equal(result.code, 0, result.stderr)
      const lockfile = await readJson(dir, "package-lock.json")
      assert.equal(lockfile.packages["node_modules/react"].version, "18.2.0")
      assert.equal(lockfile.packages[""].dependencies.react, "18.2.0")
    })
  })
})
