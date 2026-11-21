/**
 * The CLI in a real repository, on files Git left conflicted.
 *
 * Git keeps the three versions of a conflicted file in its index. The CLI
 * merges those, which is the merge driver's own three-way merge, instead of
 * the two sides between default conflict markers, where the common ancestor
 * is missing. It goes by the markers again as soon as the file was changed
 * after the merge, and treats a merged lockfile Git still lists as conflicted
 * as work left to do.
 */

import {strict as assert} from "assert"
import {test, describe} from "node:test"
import {readFile, rm, writeFile} from "fs/promises"
import {join} from "node:path"
import {findRepoRoot, listUnmerged, onBothBranches, readMergeVersions} from "../git.js"
import {
  CLI_PATH,
  STUBS_NEED_POSIX,
  commitFiles,
  git,
  jsonLines,
  runCli,
  stubPackageManagers,
  withRepo,
  withTempDir,
} from "./cli-harness.js"

const j = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`

const lockEntry = (name: string, version: string) => ({
  version,
  resolved: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
  integrity: `sha512-${name}-${version}`,
})

const lock = (dependencies: Record<string, string>, versions: Record<string, string>) =>
  j({
    name: "app",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": {name: "app", dependencies},
      ...Object.fromEntries(
        Object.entries(versions).map(([name, version]) => [`node_modules/${name}`, lockEntry(name, version)])
      ),
    },
  })

const pkg = (dependencies: Record<string, string>, fields: Record<string, unknown> = {}) =>
  j({name: "app", version: "1.0.0", ...fields, dependencies})

const readJson = async (dir: string, file: string) => JSON.parse(await readFile(join(dir, file), "utf8"))

/**
 * Commit a base, a feature branch and a main branch that each change the
 * files, then merge feature into main, which is expected to conflict.
 */
async function conflictingMerge(
  dir: string,
  base: Record<string, string>,
  ours: Record<string, string>,
  theirs: Record<string, string>
): Promise<void> {
  await commitFiles(dir, base, "base")
  await git(dir, ["checkout", "-b", "feature"])
  await commitFiles(dir, theirs, "feature")
  await git(dir, ["checkout", "main"])
  await commitFiles(dir, ours, "main")
  const merge = await git(dir, ["merge", "feature"], true)
  assert.notEqual(merge.code, 0, `the merge was expected to conflict:\n${merge.stdout}`)
}

/**
 * We removed left-pad and bumped lodash; they added express and bumped lodash
 * to a lower version than ours, on the line next to left-pad: one conflict
 * covers all three, in package.json and in the lockfile.
 */
const BASE = {
  "package.json": pkg({"left-pad": "^1.3.0", lodash: "^4.17.20", zod: "^3.0.0"}),
  "package-lock.json": lock(
    {"left-pad": "^1.3.0", lodash: "^4.17.20", zod: "^3.0.0"},
    {"left-pad": "1.3.0", lodash: "4.17.20", zod: "3.0.0"}
  ),
}
const OURS = {
  "package.json": pkg({lodash: "^4.17.22", zod: "^3.0.0"}),
  "package-lock.json": lock({lodash: "^4.17.22", zod: "^3.0.0"}, {lodash: "4.17.22", zod: "3.0.0"}),
}
const THEIRS = {
  "package.json": pkg({express: "^4.18.0", "left-pad": "^1.3.0", lodash: "^4.17.21", zod: "^3.0.0"}),
  "package-lock.json": lock(
    {express: "^4.18.0", "left-pad": "^1.3.0", lodash: "^4.17.21", zod: "^3.0.0"},
    {express: "4.18.0", "left-pad": "1.3.0", lodash: "4.17.21", zod: "3.0.0"}
  ),
}
const MERGED_DEPENDENCIES = {express: "^4.18.0", lodash: "^4.17.22", zod: "^3.0.0"}

describe("the CLI merges the versions in Git's index", () => {
  test("a dependency we removed stays removed, in package.json and in the lockfile", async () => {
    await withRepo(async dir => {
      await conflictingMerge(dir, BASE, OURS, THEIRS)
      const conflicted = await readFile(join(dir, "package.json"), "utf8")
      assert.match(conflicted, /^<{7} HEAD/m)
      assert.doesNotMatch(conflicted, /^\|{7}/m, "default conflict markers carry no common ancestor")

      const result = await runCli(["--no-regenerate-lock"], dir)
      assert.equal(result.code, 0, result.stderr)
      assert.match(result.stdout, /Merging our version, theirs and their common ancestor from Git's index/)

      const merged = await readJson(dir, "package.json")
      assert.deepEqual(merged.dependencies, MERGED_DEPENDENCIES)
      assert.deepEqual(Object.keys(merged.dependencies), ["express", "lodash", "zod"], "express is in its place")

      const lockfile = await readJson(dir, "package-lock.json")
      assert.deepEqual(lockfile.packages[""].dependencies, MERGED_DEPENDENCIES)
      assert.deepEqual(Object.keys(lockfile.packages), [
        "",
        "node_modules/express",
        "node_modules/lodash",
        "node_modules/zod",
      ])
      assert.equal(lockfile.packages["node_modules/lodash"].version, "4.17.22")
    })
  })

  test("the result is the one the merge driver gives for the same merge", async () => {
    const viaDriver = await withRepo(async dir => {
      await git(dir, [
        "config",
        "merge.package-conflicts-resolver.driver",
        `"${process.execPath}" "${CLI_PATH}" merge-driver %A %O %B`,
      ])
      await commitFiles(dir, {".gitattributes": "package*.json merge=package-conflicts-resolver\n", ...BASE}, "base")
      await git(dir, ["checkout", "-b", "feature"])
      await commitFiles(dir, THEIRS, "feature")
      await git(dir, ["checkout", "main"])
      await commitFiles(dir, OURS, "main")
      await git(dir, ["merge", "feature"])
      return [await readJson(dir, "package.json"), await readJson(dir, "package-lock.json")]
    })

    const viaCli = await withRepo(async dir => {
      await conflictingMerge(dir, BASE, OURS, THEIRS)
      const result = await runCli(["--no-regenerate-lock", "--quiet"], dir)
      assert.equal(result.code, 0, result.stderr)
      return [await readJson(dir, "package.json"), await readJson(dir, "package-lock.json")]
    })

    assert.deepEqual(viaCli, viaDriver)
    assert.equal(JSON.stringify(viaCli), JSON.stringify(viaDriver), "with the keys in the same order")
  })

  test("--list shows the common ancestor, and only what both branches changed", async () => {
    await withRepo(async dir => {
      await conflictingMerge(dir, BASE, OURS, THEIRS)
      const before = await readFile(join(dir, "package.json"), "utf8")

      const result = await runCli(["--list", "--json"], dir)
      assert.equal(result.code, 0, result.stderr)
      const report = JSON.parse(result.stdout)
      assert.deepEqual(
        report.files.map((file: any) => [file.file, file.packages.map((conflict: any) => conflict.name)]),
        [
          ["package.json", ["lodash"]],
          ["package-lock.json", ["lodash", "lodash"]],
        ]
      )
      assert.deepEqual(
        [report.files[0].packages[0].base, report.files[0].packages[0].ours, report.files[0].packages[0].theirs],
        ["^4.17.20", "^4.17.22", "^4.17.21"]
      )
      assert.equal(await readFile(join(dir, "package.json"), "utf8"), before, "--list changes nothing")
    })
  })

  test("--pick and --dry-run work on the index versions too", async () => {
    await withRepo(async dir => {
      await conflictingMerge(dir, BASE, OURS, THEIRS)
      const before = await readFile(join(dir, "package.json"), "utf8")

      const dryRun = await runCli(["--dry-run"], dir)
      assert.equal(dryRun.code, 0, dryRun.stderr)
      assert.equal(await readFile(join(dir, "package.json"), "utf8"), before)

      const picked = await runCli(["--pick", "lodash@4.17.21", "--no-version-check", "--no-regenerate-lock"], dir)
      assert.equal(picked.code, 0, picked.stderr)
      assert.deepEqual((await readJson(dir, "package.json")).dependencies, {...MERGED_DEPENDENCIES, lodash: "4.17.21"})
      assert.equal((await readJson(dir, "package-lock.json")).packages["node_modules/lodash"].version, "4.17.21")
    })
  })

  test("--json reports where the versions came from", async () => {
    await withRepo(async dir => {
      await conflictingMerge(dir, BASE, OURS, THEIRS)
      const result = await runCli(["--json", "--no-regenerate-lock"], dir)
      assert.equal(result.code, 0, result.stderr)
      const messages = jsonLines(result.stdout).map(record => record.message)
      assert(messages.includes("Merging our version, theirs and their common ancestor from Git's index"), result.stdout)
    })
  })

  test("in a rebase, ours is the branch being rebased onto, as in the conflict markers", async () => {
    await withRepo(async dir => {
      await commitFiles(dir, {"package.json": pkg({lodash: "^4.17.20"}, {description: "base"})}, "base")
      await git(dir, ["checkout", "-b", "feature"])
      await commitFiles(dir, {"package.json": pkg({lodash: "^4.17.21"}, {description: "feature"})}, "feature")
      await git(dir, ["checkout", "main"])
      await commitFiles(dir, {"package.json": pkg({lodash: "^4.17.22"}, {description: "main"})}, "main")
      await git(dir, ["checkout", "feature"])
      const rebase = await git(dir, ["rebase", "main"], true)
      assert.notEqual(rebase.code, 0, "the rebase was expected to stop")

      const result = await runCli(["--strategy", "ours", "--no-regenerate-lock"], dir)
      assert.equal(result.code, 0, result.stderr)
      const merged = await readJson(dir, "package.json")
      assert.equal(merged.description, "main")
      assert.equal(merged.dependencies.lodash, "^4.17.22")
    })
  })

  test("a file in a subfolder is found from any folder", async () => {
    await withRepo(async dir => {
      const at = (files: Record<string, string>) => ({"services/api/package.json": files["package.json"] as string})
      await conflictingMerge(dir, at(BASE), at(OURS), at(THEIRS))

      const result = await runCli(["services/api/package.json"], dir)
      assert.equal(result.code, 0, result.stderr)
      assert.match(result.stdout, /from Git's index/)
      assert.deepEqual((await readJson(dir, "services/api/package.json")).dependencies, MERGED_DEPENDENCIES)
    })
  })
})

describe("the CLI goes by the conflict markers once the file was changed", () => {
  /** Two conflicts far enough apart for Git to keep them apart: the description, and the dependencies */
  const fields = (description: string) => ({description, license: "MIT", main: "index.js", types: "index.d.ts"})
  const base = {"package.json": pkg({a: "^1.0.0", b: "^1.0.0"}, fields("base"))}
  const ours = {"package.json": pkg({b: "^1.1.0"}, fields("ours"))}
  const theirs = {"package.json": pkg({a: "^1.0.0", b: "^1.2.0"}, fields("theirs"))}

  test("a conflict resolved by hand and a value edited by hand are kept", async () => {
    await withRepo(async dir => {
      await conflictingMerge(dir, base, ours, theirs)
      const file = join(dir, "package.json")
      const conflicted = await readFile(file, "utf8")
      assert.equal(conflicted.match(/^<{7} /gm)?.length, 2, conflicted)

      // The description decided by hand, and the license changed on the way
      const edited = conflicted
        .replace(
          /<{7} [^\n]*\r?\n[^\n]*"description": "ours",\r?\n={7}\r?\n[^\n]*\n>{7} [^\n]*\n/,
          '  "description": "mine",\n'
        )
        .replace('"license": "MIT"', '"license": "ISC"')
      assert.equal(edited.match(/^<{7} /gm)?.length, 1, edited)
      await writeFile(file, edited, "utf8")

      const result = await runCli(["--no-regenerate-lock"], dir)
      assert.equal(result.code, 0, result.stderr)
      assert.match(result.stdout, /The file was edited or resolved in part since the merge/)

      const merged = await readJson(dir, "package.json")
      assert.equal(merged.description, "mine")
      assert.equal(merged.license, "ISC")
      assert.equal(merged.dependencies.b, "^1.2.0", "the conflict that was left is resolved")
    })
  })

  test("a second run only decides the values the first one left", async () => {
    await withRepo(async dir => {
      // Both branches changed the build script (left for the user) and lodash (decided by "highest")
      await conflictingMerge(
        dir,
        {"package.json": pkg({lodash: "^4.17.20"}, {scripts: {build: "tsc"}})},
        {"package.json": pkg({lodash: "^4.17.22"}, {scripts: {build: "tsc -b"}})},
        {"package.json": pkg({lodash: "^4.17.21"}, {scripts: {build: "vite build"}})}
      )

      const first = await runCli(["--no-regenerate-lock"], dir)
      assert.equal(first.code, 1, "the script is left for the user")
      assert.match(first.stdout, /from Git's index/)
      const left = await readFile(join(dir, "package.json"), "utf8")
      assert.match(left, /<{7} ours\r?\n\s+"build": "tsc -b"\r?\n\|{7} base\r?\n\s+"build": "tsc"\r?\n={7}/)

      // Git still has the three versions: merging them again with "theirs" would also take their lodash
      assert.equal(onBothBranches((await listUnmerged(dir)).get("package.json")), true)
      const second = await runCli(["--strategy", "theirs", "--no-regenerate-lock"], dir)
      assert.equal(second.code, 0, second.stderr)
      assert.match(second.stdout, /resolving what is left between its conflict markers/)

      const merged = await readJson(dir, "package.json")
      assert.equal(merged.scripts.build, "vite build")
      assert.equal(merged.dependencies.lodash, "^4.17.22", "decided by the first run, with highest")
    })
  })

  test("a file with conflict markers that Git does not list as conflicted is resolved from them", async () => {
    await withRepo(async dir => {
      const only = (files: Record<string, string>) => ({"package.json": files["package.json"] as string})
      await conflictingMerge(dir, only(BASE), only(OURS), only(THEIRS))
      // Added by mistake, markers and all: Git no longer has the three versions
      await git(dir, ["add", "package.json"])

      const result = await runCli(["--no-regenerate-lock"], dir)
      assert.equal(result.code, 0, result.stderr)
      assert.doesNotMatch(result.stdout, /Git's index/)
      // Without the common ancestor, our removal of left-pad cannot be told from their addition
      assert.equal((await readJson(dir, "package.json")).dependencies["left-pad"], "^1.3.0")
    })
  })
})

describe("reading Git's index", () => {
  test("the three versions are read whole, whatever their size and characters", async () => {
    await withRepo(async dir => {
      // Larger than a pipe's buffer, with characters of two, three and four bytes all along
      const filler = Object.fromEntries(Array.from({length: 4000}, (_, index) => [`key-${index}`, `é ✓ 😀 ${index}`]))
      const version = (description: string) => j({name: "app", description, filler})
      await conflictingMerge(
        dir,
        {"package.json": version("base")},
        {"package.json": version("ours — ünïcödé")},
        {"package.json": version("theirs — 日本語")}
      )

      const versions = await readMergeVersions(join(dir, "package.json"))
      assert.equal(versions?.base, version("base"))
      assert.equal(versions?.ours, version("ours — ünïcödé"))
      assert.equal(versions?.theirs, version("theirs — 日本語"))
      assert(Buffer.byteLength(versions.ours) > 100_000)
    })
  })

  test("a file both branches added has no common ancestor", async () => {
    await withRepo(async dir => {
      await conflictingMerge(
        dir,
        {"README.md": "x\n"},
        {"package.json": pkg({a: "^1.0.0"})},
        {
          "package.json": pkg({a: "^2.0.0"}),
        }
      )
      assert.deepEqual(await readMergeVersions(join(dir, "package.json")), {
        ours: pkg({a: "^1.0.0"}),
        theirs: pkg({a: "^2.0.0"}),
      })
    })
  })

  test("there are no versions for a file that is not conflicted, that a branch deleted, or outside a repository", async () => {
    await withRepo(async dir => {
      await commitFiles(dir, {"package.json": pkg({a: "^1.0.0"}), "other.json": "{}\n"}, "base")
      await git(dir, ["checkout", "-b", "feature"])
      await commitFiles(dir, {"package.json": pkg({a: "^2.0.0"})}, "feature")
      await git(dir, ["checkout", "main"])
      await git(dir, ["rm", "-q", "package.json"])
      await git(dir, ["commit", "-m", "main"])
      await git(dir, ["merge", "feature"], true)

      // They changed a file we deleted: Git has their version and the ancestor's, but none of ours
      const unmerged = await listUnmerged(dir)
      assert.deepEqual([...unmerged.keys()], ["package.json"])
      assert.equal(onBothBranches(unmerged.get("package.json")), false)
      assert.equal(await readMergeVersions(join(dir, "package.json")), undefined)
      assert.equal(await readMergeVersions(join(dir, "other.json")), undefined)
      assert.equal(await readMergeVersions(join(dir, "missing.json")), undefined)
    })

    await withTempDir(async dir => {
      await writeFile(join(dir, "package.json"), "{}\n")
      assert.equal(await readMergeVersions(join(dir, "package.json")), undefined)
      assert.equal(await findRepoRoot(dir), undefined)
      assert.deepEqual(await listUnmerged(dir), new Map())
      assert.equal(await findRepoRoot(join(dir, "missing")), undefined)
    })
  })

  test("the repository root is found from any folder in it", async () => {
    await withRepo(async dir => {
      await commitFiles(dir, {"packages/a/src/index.js": "\n"}, "base")
      assert.equal(await findRepoRoot(dir), dir)
      assert.equal(await findRepoRoot(join(dir, "packages", "a", "src")), dir)
      assert.equal(await findRepoRoot(join(dir, ".git")), undefined)
    })
  })
})

describe("a lockfile Git still lists as conflicted, without conflict markers", () => {
  /**
   * How the merge driver leaves a lockfile whose merge is not consistent:
   * main only refreshed the locked lodash, feature pinned it. package.json
   * merges to the pin, and the lockfile to the refreshed version.
   */
  async function inconsistentLockfile(dir: string): Promise<void> {
    await git(dir, [
      "config",
      "merge.package-conflicts-resolver.driver",
      `"${process.execPath}" "${CLI_PATH}" merge-driver %A %O %B`,
    ])
    const files = (spec: string, locked: string, version: string) => ({
      "package.json": pkg({lodash: spec}, {version}),
      "package-lock.json": lock({lodash: spec}, {lodash: locked}),
    })
    await commitFiles(
      dir,
      {".gitattributes": "package*.json merge=package-conflicts-resolver\n", ...files("^4.0.0", "4.0.0", "1.0.0")},
      "base"
    )
    await git(dir, ["checkout", "-b", "feature"])
    await commitFiles(dir, files("4.17.20", "4.17.20", "1.2.0"), "feature")
    await git(dir, ["checkout", "main"])
    await commitFiles(dir, files("^4.0.0", "4.17.21", "1.1.0"), "main")

    const merge = await git(dir, ["merge", "feature"], true)
    assert.match(merge.stderr, /leaving the lockfile marked as conflicted/)
    assert.doesNotMatch(await readFile(join(dir, "package-lock.json"), "utf8"), /^<{7}/m)
    assert.match((await git(dir, ["status", "--porcelain"])).stdout, /^UU package-lock\.json$/m)
  }

  test("is regenerated", {skip: STUBS_NEED_POSIX}, async () => {
    await withRepo(async (dir, scratch) => {
      await inconsistentLockfile(dir)
      const stubs = await stubPackageManagers(scratch)
      const regenerated = lock({lodash: "4.17.20"}, {lodash: "4.17.20"})

      const result = await runCli([], dir, {...stubs.env, PCR_STUB_LOCK_CONTENT: regenerated})
      assert.equal(result.code, 0, result.stderr)
      assert.match(result.stdout, /package-lock\.json has no conflict markers, but Git still lists it as conflicted/)
      assert.match(result.stdout, /Regenerated package-lock\.json/)
      assert.doesNotMatch(result.stdout, /No Git conflict markers found/)
      assert.deepEqual(await stubs.invocations(), [`npm|${dir}|install --package-lock-only`])
      assert.equal(await readFile(join(dir, "package-lock.json"), "utf8"), regenerated)
    })
  })

  test("is reported as inconsistent when it is not regenerated", async () => {
    await withRepo(async dir => {
      await inconsistentLockfile(dir)
      const before = await readFile(join(dir, "package-lock.json"), "utf8")

      const result = await runCli(["--no-regenerate-lock"], dir)
      assert.equal(result.code, 1)
      assert.match(result.stderr, /package-lock\.json was merged but its dependency graph is not consistent/)
      assert.match(result.stderr, /the root project requires lodash@4\.17\.20 but node_modules\/lodash is 4\.17\.21/)

      const dryRun = await runCli(["--dry-run"], dir)
      assert.equal(dryRun.code, 0, dryRun.stderr)
      assert.match(
        dryRun.stderr,
        /package-lock\.json has 1 unsatisfied dependency; regenerating it with npm fixes this/
      )

      // Given as the file to resolve, it is the same work
      const asTarget = await runCli(["package-lock.json", "--no-regenerate-lock", "--quiet"], dir)
      assert.equal(asTarget.code, 1)
      assert.match(asTarget.stderr, /package-lock\.json was merged but its dependency graph is not consistent/)

      assert.equal(await readFile(join(dir, "package-lock.json"), "utf8"), before, "none of these runs writes")
    })
  })

  test("is still inconsistent, and says so, when regenerating fails", {skip: STUBS_NEED_POSIX}, async () => {
    await withRepo(async (dir, scratch) => {
      await inconsistentLockfile(dir)
      const stubs = await stubPackageManagers(scratch)

      const result = await runCli([], dir, {...stubs.env, PCR_STUB_EXIT: "1"})
      assert.equal(result.code, 1)
      assert.match(result.stderr, /Failed to regenerate package-lock\.json/)
      assert.match(result.stderr, /its dependency graph is not consistent/)
    })
  })

  test("needs nothing but `git add` when it is consistent", async () => {
    await withRepo(async dir => {
      await inconsistentLockfile(dir)
      // Fixed by hand, and not added yet
      await writeFile(join(dir, "package-lock.json"), lock({lodash: "4.17.20"}, {lodash: "4.17.20"}))

      const result = await runCli(["--no-regenerate-lock"], dir)
      assert.equal(result.code, 0, result.stderr)
      assert.match(result.stdout, /package-lock\.json is consistent: run "git add" on it to mark it as resolved/)
    })
  })

  test("is not blamed for a dependency that was unsatisfied on a branch already", async () => {
    await withRepo(async dir => {
      // On every branch, "a" asks for a version of "b" that is not the locked one
      const files = (lodash: string) => {
        const document = JSON.parse(lock({a: "^1.0.0", lodash: `^${lodash}`}, {a: "1.0.0", b: "1.0.0", lodash}))
        document.packages["node_modules/a"].dependencies = {b: "^2.0.0"}
        return {"package.json": pkg({a: "^1.0.0", lodash: `^${lodash}`}), "package-lock.json": j(document)}
      }
      await conflictingMerge(dir, files("4.17.19"), files("4.17.20"), files("4.17.21"))
      // Both files resolved by hand, to their branch, and not added yet
      await writeFile(join(dir, "package.json"), files("4.17.21")["package.json"])
      await writeFile(join(dir, "package-lock.json"), files("4.17.21")["package-lock.json"])

      const result = await runCli(["--no-regenerate-lock"], dir)
      assert.equal(result.code, 0, result.stderr)
      assert.match(result.stdout, /package-lock\.json is consistent/)
    })
  })

  test("is left alone when a branch deleted it", {skip: STUBS_NEED_POSIX}, async () => {
    await withRepo(async (dir, scratch) => {
      await commitFiles(
        dir,
        {"package.json": pkg({lodash: "^4.0.0"}), "package-lock.json": lock({lodash: "^4.0.0"}, {lodash: "4.0.0"})},
        "base"
      )
      await git(dir, ["checkout", "-b", "feature"])
      await commitFiles(dir, {"package-lock.json": lock({lodash: "^4.0.0"}, {lodash: "4.17.21"})}, "feature")
      await git(dir, ["checkout", "main"])
      await git(dir, ["rm", "-q", "package-lock.json"])
      await git(dir, ["commit", "-m", "main: no lockfile"])
      await git(dir, ["merge", "feature"], true)
      assert.match((await git(dir, ["status", "--porcelain"])).stdout, /^DU package-lock\.json$/m)

      const stubs = await stubPackageManagers(scratch)
      const result = await runCli([], dir, stubs.env)
      assert.equal(result.code, 0, result.stderr)
      assert.match(result.stdout, /No Git conflict markers found in package\.json/)
      assert.deepEqual(await stubs.invocations(), [], "whether the lockfile should exist is not npm's to decide")
    })
  })

  test("a package.json in that state is not touched, and the run says what is left", async () => {
    await withRepo(async dir => {
      await conflictingMerge(dir, BASE, OURS, THEIRS)
      await rm(join(dir, "package-lock.json"))
      await git(dir, ["rm", "-q", "--cached", "package-lock.json"])
      // Resolved by hand, to our version, and not added yet
      await writeFile(join(dir, "package.json"), OURS["package.json"])

      const result = await runCli([], dir)
      assert.equal(result.code, 0, result.stderr)
      assert.match(result.stdout, /No Git conflict markers found in package\.json/)
      assert.match(result.stdout, /Git still lists package\.json as conflicted/)
      assert.match(result.stdout, /git add package\.json/)
      assert.doesNotMatch(result.stdout, /package-conflicts-resolver setup/)
      assert.equal(await readFile(join(dir, "package.json"), "utf8"), OURS["package.json"])

      const json = await runCli(["--json"], dir)
      assert.deepEqual(jsonLines(json.stdout)[0].data, {conflicts: 0, unmerged: true})
    })
  })
})
