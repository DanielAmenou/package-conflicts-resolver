/**
 * The package entry point (package.json "main"): it exports exactly the public
 * API, and the programmatic usage the README shows works through it.
 */

import {strict as assert} from "assert"
import {test, describe} from "node:test"
import {readFile} from "fs/promises"
import {join} from "node:path"
import * as api from "../index.js"
import {conflictedDocument, withTempDir} from "./cli-harness.js"

/** Every runtime export of the entry point: adding or removing one changes the public API */
const PUBLIC_EXPORTS = [
  "ConflictParser",
  "LOCKFILES",
  "Logger",
  "PackageResolver",
  "RESOLUTION_STRATEGIES",
  "STABLE_PACKAGE_JSON_FIELDS",
  "VersionResolver",
  "classifyVersionSpec",
  "createNpmVersionLookup",
  "detectPackageManager",
  "findLockfiles",
  "findPickProblems",
  "formatConflictReport",
  "formatLockfileIssues",
  "isNpmLockfile",
  "isValidPackageName",
  "lockedVersionSatisfies",
  "normalizeVersionPicks",
  "parseJsonLenient",
  "parseNpmViewOutput",
  "parseVersionPick",
  "parseVersionPicks",
  "reportFile",
  "resolveLockfileDependency",
  "validateLockfile",
  "verifyVersionPicks",
]

const OPTIONS = {
  strategy: "highest",
  dryRun: false,
  quiet: true,
  json: false,
  verbose: false,
  regenerateLock: false,
} as const

const CONFLICTED = [
  "{",
  '  "name": "app",',
  '  "dependencies": {',
  "<<<<<<< HEAD",
  '    "lodash": "^4.17.20",',
  '    "express": "^4.18.0"',
  "=======",
  '    "lodash": "^4.17.21",',
  '    "react": "^18.0.0"',
  ">>>>>>> feature",
  "  }",
  "}",
  "",
].join("\n")

describe("public API", () => {
  test("the entry point exports exactly the public values, all defined", () => {
    assert.deepEqual(Object.keys(api).sort(), [...PUBLIC_EXPORTS].sort())
    for (const name of PUBLIC_EXPORTS) {
      assert.notEqual(api[name as keyof typeof api], undefined, name)
    }
    assert.deepEqual(Object.keys(api.RESOLUTION_STRATEGIES), ["highest", "lowest", "ours", "theirs"])
  })

  test("resolves a conflicted package.json and writes it", async () => {
    await withTempDir(async dir => {
      const resolver = new api.PackageResolver(OPTIONS)
      const result = await resolver.resolveConflicts(CONFLICTED)
      assert(result.resolved && result.packageJson, result.errors.join(", "))

      const file = join(dir, "package.json")
      await resolver.writeResolvedPackage(result.packageJson, file)
      assert.deepEqual(JSON.parse(await readFile(file, "utf8")), {
        name: "app",
        dependencies: {lodash: "^4.17.21", express: "^4.18.0", react: "^18.0.0"},
      })

      const lodash = result.packageConflicts?.find(conflict => conflict.name === "lodash")
      assert.equal(lodash?.resolved, "^4.17.21")
      assert.equal(lodash?.resolvedBy, "highest")
    })
  })

  test("picks a version and checks the pick with a custom lookup", async () => {
    await withTempDir(async dir => {
      const picks = {lodash: "4.17.20"}
      const picked = await new api.PackageResolver({...OPTIONS, picks}).resolveConflicts(CONFLICTED)
      assert.equal(picked.packageJson?.dependencies?.lodash, "4.17.20")
      assert.deepEqual(api.findPickProblems(picks, picked.packageConflicts ?? []), [])

      const lookup = async (name: string) =>
        name === "lodash" ? {versions: ["4.17.20", "4.17.21"], distTags: {latest: "4.17.21"}} : null
      const checks = await api.verifyVersionPicks(picks, {lookup, cwd: dir})
      assert.deepEqual(
        checks.map(check => [check.name, check.status]),
        [["lodash", "ok"]]
      )
    })
  })

  test("reports what a merged lockfile does not satisfy, and validates lockfiles on their own", async () => {
    const lock = (rootSpec: string, version: string) => ({
      name: "app",
      lockfileVersion: 3,
      packages: {
        "": {name: "app", dependencies: {foo: rootSpec}},
        "node_modules/foo": {version, integrity: `sha512-${version}`},
      },
    })

    const lockResult = await new api.PackageResolver(OPTIONS).resolveConflicts(
      conflictedDocument(lock("^1.0.0", "1.5.0"), lock("1.2.0", "1.2.0"))
    )
    assert.equal(lockResult.resolved, true, lockResult.errors.join(", "))
    assert.equal(lockResult.lockfileIssues?.length, 1)
    assert.match(lockResult.lockfileIssues?.[0]?.message ?? "", /requires foo@1\.2\.0 but node_modules\/foo is 1\.5\.0/)

    const consistent = lock("^1.0.0", "1.5.0")
    assert.equal(api.isNpmLockfile(consistent), true)
    assert.deepEqual(api.validateLockfile(consistent), [])
    const issues = api.validateLockfile(consistent, {name: "app", dependencies: {foo: "1.2.0"}})
    assert.equal(issues.length, 1)
    assert.match(api.formatLockfileIssues(issues).join("\n"), /foo/)
  })
})
