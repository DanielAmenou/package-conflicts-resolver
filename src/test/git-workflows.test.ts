/**
 * The merge driver under the Git operations that actually produce lockfile
 * conflicts: rebase, cherry-pick, stash pop, revert and squash merges.
 *
 * These all run the same three-way machinery as `git merge`, but rebase and
 * cherry-pick hand the driver its sides the other way round — "ours" is the
 * commit being replayed onto, "theirs" is the commit being replayed — so a
 * resolver that leans on side order rather than on the common ancestor gives
 * different answers depending on how the branches were combined.
 */

import {strict as assert} from "assert"
import {test, describe} from "node:test"
import {spawn} from "node:child_process"
import {mkdtemp, readFile, writeFile, rm} from "fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"

const CLI_PATH = join(__dirname, "..", "cli.js")

interface RunResult {
  code: number | null
  stdout: string
  stderr: string
}

function run(command: string, args: string[], cwd: string): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {cwd, stdio: ["ignore", "pipe", "pipe"]})
    let stdout = ""
    let stderr = ""
    child.stdout?.on("data", chunk => (stdout += chunk))
    child.stderr?.on("data", chunk => (stderr += chunk))
    child.on("error", reject)
    child.on("close", code => resolvePromise({code, stdout, stderr}))
  })
}

const pkg = (version: string, dependencies: Record<string, string>) =>
  JSON.stringify({name: "app", version, dependencies}, null, 2) + "\n"

const lockEntry = (name: string, version: string) => ({
  version,
  resolved: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
  integrity: `sha512-${name}-${version}`,
})

const lock = (rootDeps: Record<string, string>, versions: Record<string, string>) =>
  JSON.stringify(
    {
      name: "app",
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": {name: "app", dependencies: rootDeps},
        ...Object.fromEntries(
          Object.entries(versions).map(([name, version]) => [`node_modules/${name}`, lockEntry(name, version)])
        ),
      },
    },
    null,
    2
  ) + "\n"

/**
 * A repository with the driver configured and two diverged branches:
 *
 *   base    version 1.0.0, lodash ^4.17.20
 *   main    version 1.1.0, lodash ^4.17.21 (bumped), + express
 *   feature version 1.2.0, lodash ^4.17.20 (untouched), + react
 *
 * Both branches changed "version", so that is a genuine conflict; lodash and
 * the two added packages were each touched by one side only.
 */
async function withDivergedRepo<T>(fn: (dir: string, git: (args: string[]) => Promise<RunResult>) => Promise<T>) {
  const dir = await mkdtemp(join(tmpdir(), "pcr-workflow-"))
  const git = (args: string[]) => run("git", args, dir)

  try {
    await git(["init", "-b", "main"])
    await git(["config", "user.name", "Test"])
    await git(["config", "user.email", "test@example.com"])
    await git([
      "config",
      "merge.package-conflicts-resolver.driver",
      `"${process.execPath}" "${CLI_PATH}" merge-driver %A %O %B`,
    ])
    await writeFile(
      join(dir, ".gitattributes"),
      "package.json merge=package-conflicts-resolver\npackage-lock.json merge=package-conflicts-resolver\n"
    )

    await writeFile(join(dir, "package.json"), pkg("1.0.0", {lodash: "^4.17.20"}))
    await writeFile(join(dir, "package-lock.json"), lock({lodash: "^4.17.20"}, {lodash: "4.17.20"}))
    await git(["add", "-A"])
    await git(["commit", "-m", "base"])

    await git(["checkout", "-b", "feature"])
    await writeFile(join(dir, "package.json"), pkg("1.2.0", {lodash: "^4.17.20", react: "^18.0.0"}))
    await writeFile(
      join(dir, "package-lock.json"),
      lock({lodash: "^4.17.20", react: "^18.0.0"}, {lodash: "4.17.20", react: "18.2.0"})
    )
    await git(["add", "-A"])
    await git(["commit", "-m", "feature: add react"])

    await git(["checkout", "main"])
    await writeFile(join(dir, "package.json"), pkg("1.1.0", {lodash: "^4.17.21", express: "^4.18.0"}))
    await writeFile(
      join(dir, "package-lock.json"),
      lock({lodash: "^4.17.21", express: "^4.18.0"}, {lodash: "4.17.21", express: "4.18.0"})
    )
    await git(["add", "-A"])
    await git(["commit", "-m", "main: bump lodash, add express"])

    return await fn(dir, git)
  } finally {
    await rm(dir, {recursive: true, force: true})
  }
}

/**
 * What a correct three-way merge must produce, whichever side is "ours":
 * both branches changed the version, so the strategy decides it; every other
 * change was made by one branch only and must survive.
 */
const EXPECTED_DEPENDENCIES = {
  lodash: "^4.17.21", // only main touched it
  express: "^4.18.0", // added by main
  react: "^18.0.0", // added by feature
}

async function readPackage(dir: string): Promise<any> {
  return JSON.parse(await readFile(join(dir, "package.json"), "utf8"))
}

async function readLock(dir: string): Promise<any> {
  return JSON.parse(await readFile(join(dir, "package-lock.json"), "utf8"))
}

function assertLockMatchesExpectation(lockfile: any): void {
  assert.deepEqual(lockfile.packages[""].dependencies, EXPECTED_DEPENDENCIES)
  assert.equal(lockfile.packages["node_modules/lodash"].version, "4.17.21")
  assert.equal(lockfile.packages["node_modules/lodash"].integrity, "sha512-lodash-4.17.21")
  assert.equal(lockfile.packages["node_modules/express"].version, "4.18.0")
  assert.equal(lockfile.packages["node_modules/react"].version, "18.2.0")
}

describe("merge driver under different Git operations", () => {
  test("git merge resolves both files", async () => {
    await withDivergedRepo(async (dir, git) => {
      const merge = await git(["merge", "feature"])
      assert.equal(merge.code, 0, `${merge.stdout}\n${merge.stderr}`)

      const merged = await readPackage(dir)
      assert.equal(merged.version, "1.2.0", "both sides changed version: highest wins")
      assert.deepEqual(merged.dependencies, EXPECTED_DEPENDENCIES)
      assertLockMatchesExpectation(await readLock(dir))
    })
  })

  test("git rebase produces the same content as the merge, despite swapped sides", async () => {
    await withDivergedRepo(async (dir, git) => {
      await git(["checkout", "feature"])
      const rebase = await git(["rebase", "main"])
      assert.equal(rebase.code, 0, `rebase should auto-resolve:\n${rebase.stdout}\n${rebase.stderr}`)

      // During a rebase "ours" is main and "theirs" is the replayed commit —
      // the opposite of the merge above. The common ancestor makes the outcome
      // identical anyway.
      const rebased = await readPackage(dir)
      assert.equal(rebased.version, "1.2.0")
      assert.deepEqual(rebased.dependencies, EXPECTED_DEPENDENCIES)
      assertLockMatchesExpectation(await readLock(dir))

      const status = await git(["status", "--porcelain"])
      assert.equal(status.stdout.trim(), "", "the rebase must finish with a clean tree")
    })
  })

  test("git cherry-pick resolves the same way", async () => {
    await withDivergedRepo(async (dir, git) => {
      const pick = await git(["cherry-pick", "feature"])
      assert.equal(pick.code, 0, `cherry-pick should auto-resolve:\n${pick.stdout}\n${pick.stderr}`)

      const picked = await readPackage(dir)
      assert.equal(picked.version, "1.2.0")
      assert.deepEqual(picked.dependencies, EXPECTED_DEPENDENCIES)
      assertLockMatchesExpectation(await readLock(dir))
    })
  })

  test("git merge --squash resolves without committing", async () => {
    await withDivergedRepo(async (dir, git) => {
      const squash = await git(["merge", "--squash", "feature"])
      assert.equal(squash.code, 0, `${squash.stdout}\n${squash.stderr}`)

      const merged = await readPackage(dir)
      assert.equal(merged.version, "1.2.0")
      assert.deepEqual(merged.dependencies, EXPECTED_DEPENDENCIES)

      // A squash merge stages the result but leaves it uncommitted
      const status = await git(["status", "--porcelain"])
      assert.match(status.stdout, /^M {2}package\.json$/m)
    })
  })

  test("git stash pop resolves against uncommitted work", async () => {
    await withDivergedRepo(async (dir, git) => {
      // Stash a local edit, move HEAD, then pop it back on top
      await writeFile(
        join(dir, "package.json"),
        pkg("1.1.0", {lodash: "^4.17.21", express: "^4.18.0", axios: "^1.6.0"})
      )
      await git(["stash", "push", "-m", "wip"])

      await writeFile(join(dir, "package.json"), pkg("1.3.0", {lodash: "^4.17.21", express: "^4.18.0"}))
      await git(["add", "-A"])
      await git(["commit", "-m", "bump version"])

      const pop = await git(["stash", "pop"])
      assert.equal(pop.code, 0, `stash pop should auto-resolve:\n${pop.stdout}\n${pop.stderr}`)

      const merged = await readPackage(dir)
      assert.equal(merged.dependencies.axios, "^1.6.0", "the stashed addition must survive")
      assert.equal(merged.version, "1.3.0", "the committed bump must survive")
    })
  })

  test("git revert resolves against later changes", async () => {
    await withDivergedRepo(async (dir, git) => {
      await git(["merge", "feature"])

      // A later commit touches the same fields the revert wants to undo
      await writeFile(
        join(dir, "package.json"),
        pkg("1.4.0", {lodash: "^4.17.21", express: "^4.18.0", react: "^18.2.0"})
      )
      await git(["add", "-A"])
      await git(["commit", "-m", "later work"])

      const revert = await git(["revert", "--no-edit", "HEAD~2"])
      assert.equal(revert.code, 0, `revert should auto-resolve:\n${revert.stdout}\n${revert.stderr}`)

      const reverted = await readPackage(dir)
      assert.doesNotThrow(() => JSON.stringify(reverted))
      const status = await git(["status", "--porcelain"])
      assert.equal(status.stdout.trim(), "", "the revert must finish cleanly")
    })
  })

  test("a fast-forward merge never invokes the driver", async () => {
    await withDivergedRepo(async (dir, git) => {
      await git(["checkout", "-b", "linear", "main"])
      const before = await readFile(join(dir, "package.json"), "utf8")

      await git(["checkout", "main"])
      const merge = await git(["merge", "linear"])
      assert.equal(merge.code, 0, merge.stderr)
      assert.equal(await readFile(join(dir, "package.json"), "utf8"), before, "byte-identical, not rewritten")
    })
  })

  test("an octopus-style sequence of merges stays consistent", async () => {
    await withDivergedRepo(async (dir, git) => {
      // A third branch touching yet another package
      await git(["checkout", "-b", "third", "main~1"])
      await writeFile(join(dir, "package.json"), pkg("1.0.1", {lodash: "^4.17.20", vue: "^3.0.0"}))
      await writeFile(
        join(dir, "package-lock.json"),
        lock({lodash: "^4.17.20", vue: "^3.0.0"}, {lodash: "4.17.20", vue: "3.0.0"})
      )
      await git(["add", "-A"])
      await git(["commit", "-m", "third: add vue"])

      await git(["checkout", "main"])
      const first = await git(["merge", "feature"])
      assert.equal(first.code, 0, `${first.stdout}\n${first.stderr}`)
      const second = await git(["merge", "third"])
      assert.equal(second.code, 0, `${second.stdout}\n${second.stderr}`)

      const merged = await readPackage(dir)
      assert.deepEqual(Object.keys(merged.dependencies).sort(), ["express", "lodash", "react", "vue"])

      const lockfile = await readLock(dir)
      assert.deepEqual(
        Object.keys(lockfile.packages[""].dependencies).sort(),
        ["express", "lodash", "react", "vue"],
        "the lockfile root must track package.json across successive merges"
      )
      for (const name of ["express", "lodash", "react", "vue"]) {
        assert(lockfile.packages[`node_modules/${name}`], `${name} must have a lock entry`)
      }
    })
  })

  test("an inconsistent lockfile stops a rebase the same way it stops a merge", async () => {
    // A scenario where the two comparisons genuinely disagree: main only
    // refreshed the lockfile (leaving the range alone) while feature pinned
    // the dependency. The pin wins the range comparison, the refreshed
    // version wins the version comparison, and the two no longer match.
    const dir = await mkdtemp(join(tmpdir(), "pcr-workflow-"))
    const git = (args: string[]) => run("git", args, dir)

    try {
      await git(["init", "-b", "main"])
      await git(["config", "user.name", "Test"])
      await git(["config", "user.email", "test@example.com"])
      await git([
        "config",
        "merge.package-conflicts-resolver.driver",
        `"${process.execPath}" "${CLI_PATH}" merge-driver %A %O %B`,
      ])
      await writeFile(
        join(dir, ".gitattributes"),
        "package.json merge=package-conflicts-resolver\npackage-lock.json merge=package-conflicts-resolver\n"
      )

      await writeFile(join(dir, "package.json"), pkg("1.0.0", {lodash: "^4.0.0"}))
      await writeFile(join(dir, "package-lock.json"), lock({lodash: "^4.0.0"}, {lodash: "4.0.0"}))
      await git(["add", "-A"])
      await git(["commit", "-m", "base"])

      // feature pins lodash in both files
      await git(["checkout", "-b", "feature"])
      await writeFile(join(dir, "package.json"), pkg("1.2.0", {lodash: "4.17.20"}))
      await writeFile(join(dir, "package-lock.json"), lock({lodash: "4.17.20"}, {lodash: "4.17.20"}))
      await git(["add", "-A"])
      await git(["commit", "-m", "feature: pin lodash"])

      // main leaves the range alone and only refreshes the locked version
      await git(["checkout", "main"])
      await writeFile(join(dir, "package.json"), pkg("1.1.0", {lodash: "^4.0.0"}))
      await writeFile(join(dir, "package-lock.json"), lock({lodash: "^4.0.0"}, {lodash: "4.17.21"}))
      await git(["add", "-A"])
      await git(["commit", "-m", "main: refresh lockfile"])

      await git(["checkout", "feature"])
      const rebase = await git(["rebase", "main"])
      assert.notEqual(rebase.code, 0, `the rebase must stop:\n${rebase.stdout}\n${rebase.stderr}`)
      assert.match(rebase.stderr, /merged lockfile is not consistent/)
      assert.match(rebase.stderr, /requires lodash@4\.17\.20 but node_modules\/lodash is 4\.17\.21/)

      // package.json merged cleanly; only the lockfile is left for the user
      assert.equal((await readPackage(dir)).dependencies.lodash, "4.17.20")
      const lockContent = await readFile(join(dir, "package-lock.json"), "utf8")
      assert(!lockContent.includes("<<<<<<<"), "the worktree copy carries the merge, not markers")
      assert.equal(JSON.parse(lockContent).packages["node_modules/lodash"].version, "4.17.21")

      const status = await git(["status", "--porcelain"])
      assert.match(status.stdout, /^UU package-lock\.json$/m)

      // ...and the documented recovery finishes the rebase
      await writeFile(join(dir, "package-lock.json"), lock({lodash: "4.17.20"}, {lodash: "4.17.20"}))
      await git(["add", "package-lock.json"])
      const cont = await run("git", ["-c", "core.editor=true", "rebase", "--continue"], dir)
      assert.equal(cont.code, 0, `${cont.stdout}\n${cont.stderr}`)

      const finished = await git(["status", "--porcelain"])
      assert.equal(finished.stdout.trim(), "", "the rebase must end with a clean tree")
    } finally {
      await rm(dir, {recursive: true, force: true})
    }
  })
})
