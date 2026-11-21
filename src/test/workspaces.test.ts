/**
 * Lockfiles at the root of a workspace.
 *
 * In a monorepo the packages have no lockfile of their own: resolving
 * packages/a/package.json has to resolve and regenerate the lockfile at the
 * workspace root. The root is only looked for inside the Git repository, and
 * only counts when it lists the package among its workspaces.
 */

import {strict as assert} from "assert"
import {test, describe} from "node:test"
import {mkdir, readFile, symlink, writeFile} from "fs/promises"
import {join} from "node:path"
import {findRepoRoot} from "../git.js"
import {findLockfileDir, matchesWorkspace, pnpmWorkspacePackages, workspacePatterns} from "../workspaces.js"
import {
  STUBS_NEED_POSIX,
  commitFiles,
  conflictedDocument,
  git,
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

const ROOT = j({name: "root", private: true, workspaces: ["packages/*"]})

/** A workspace member, and the root lockfile that locks it */
const member = (name: string, version: string, lodash: string) =>
  j({name, version, dependencies: {lodash: `^${lodash}`}})

const rootLock = (members: Record<string, {version: string; lodash: string}>, locked: string) =>
  j({
    name: "root",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": {name: "root", workspaces: ["packages/*"]},
      ...Object.fromEntries(
        Object.keys(members).map(name => [`node_modules/${name}`, {resolved: `packages/${name}`, link: true}])
      ),
      "node_modules/lodash": lockEntry("lodash", locked),
      ...Object.fromEntries(
        Object.entries(members).map(([name, {version, lodash}]) => [
          `packages/${name}`,
          {name, version, dependencies: {lodash: `^${lodash}`}},
        ])
      ),
    },
  })

/** The files of a monorepo whose members all depend on the same lodash */
function monorepo(version: string, lodash: string, names: string[] = ["a"]): Record<string, string> {
  return {
    "package.json": ROOT,
    "package-lock.json": rootLock(Object.fromEntries(names.map(name => [name, {version, lodash}])), lodash),
    ...Object.fromEntries(names.map(name => [`packages/${name}/package.json`, member(name, version, lodash)])),
  }
}

/** Merge a feature branch into main, both having changed every member and the root lockfile */
async function conflictingMerge(
  dir: string,
  names: string[] = ["a"],
  extra: Record<string, string> = {}
): Promise<void> {
  await commitFiles(dir, {...monorepo("1.0.0", "4.17.19", names), ...extra}, "base")
  await git(dir, ["checkout", "-b", "feature"])
  await commitFiles(dir, monorepo("1.2.0", "4.17.21", names), "feature")
  await git(dir, ["checkout", "main"])
  await commitFiles(dir, monorepo("1.1.0", "4.17.20", names), "main")
  const merge = await git(dir, ["merge", "feature"], true)
  assert.notEqual(merge.code, 0, `the merge was expected to conflict:\n${merge.stdout}`)
}

const readJson = async (dir: string, file: string) => JSON.parse(await readFile(join(dir, file), "utf8"))
const hasMarkers = async (dir: string, file: string) => /^<{7}/m.test(await readFile(join(dir, file), "utf8"))

describe("the lockfile at the root of a workspace", () => {
  test("is resolved with the package.json of a member", async () => {
    await withRepo(async dir => {
      await conflictingMerge(dir)
      assert.equal(await hasMarkers(dir, "package-lock.json"), true)

      const result = await runCli(["packages/a/package.json", "--no-regenerate-lock"], dir)
      assert.equal(result.code, 0, result.stderr)
      assert.match(result.stdout, /Found Git conflict markers in package-lock\.json, resolving/)

      assert.deepEqual(await readJson(dir, "packages/a/package.json"), JSON.parse(member("a", "1.2.0", "4.17.21")))
      const lockfile = await readJson(dir, "package-lock.json")
      assert.deepEqual(lockfile.packages["packages/a"], {
        name: "a",
        version: "1.2.0",
        dependencies: {lodash: "^4.17.21"},
      })
      assert.equal(lockfile.packages["node_modules/lodash"].version, "4.17.21")
    })
  })

  test(
    "is regenerated at the root, and named by its path from the current folder",
    {skip: STUBS_NEED_POSIX},
    async () => {
      await withRepo(async (dir, scratch) => {
        await conflictingMerge(dir)
        const stubs = await stubPackageManagers(scratch)

        // Run from the member's own folder, on its package.json
        const result = await runCli([], join(dir, "packages", "a"), stubs.env)
        assert.equal(result.code, 0, result.stderr)
        const lockfile = join("..", "..", "package-lock.json")
        assert(result.stdout.includes(`Found Git conflict markers in ${lockfile}, resolving`), result.stdout)
        assert(result.stdout.includes(`Regenerated ${lockfile}`), result.stdout)
        assert.deepEqual(await stubs.invocations(), [`npm|${dir}|install --package-lock-only`])
        assert.equal(await hasMarkers(dir, "package-lock.json"), false)
      })
    }
  )

  test("--list shows its conflicts next to the member's", async () => {
    await withRepo(async dir => {
      await conflictingMerge(dir)
      const result = await runCli(["packages/a/package.json", "--list", "--json"], dir)
      assert.equal(result.code, 0, result.stderr)
      assert.deepEqual(
        JSON.parse(result.stdout).files.map((file: any) => file.file),
        ["packages/a/package.json", "package-lock.json"]
      )
    })
  })

  test("waits for the other members that are still conflicted", {skip: STUBS_NEED_POSIX}, async () => {
    await withRepo(async (dir, scratch) => {
      await conflictingMerge(dir, ["a", "b"])
      const stubs = await stubPackageManagers(scratch)

      const first = await runCli(["packages/a/package.json"], dir, stubs.env)
      assert.equal(first.code, 0, first.stderr)
      const other = join("packages", "b", "package.json")
      assert(
        first.stderr.includes(
          `Lockfiles were not regenerated: ${other} still has conflicts. Once it is resolved, run "npm install --package-lock-only".`
        ),
        first.stderr
      )
      assert.deepEqual(await stubs.invocations(), [], "npm cannot read a package.json with conflict markers")
      assert.equal(await hasMarkers(dir, "package-lock.json"), false, "the lockfile is merged all the same")

      // The last member: nothing is left in npm's way
      const second = await runCli(["packages/b/package.json"], dir, stubs.env)
      assert.equal(second.code, 0, second.stderr)
      assert.deepEqual(await stubs.invocations(), [`npm|${dir}|install --package-lock-only`])
    })
  })

  test(
    "does not wait for a conflicted package.json that is none of its workspaces",
    {skip: STUBS_NEED_POSIX},
    async () => {
      await withRepo(async (dir, scratch) => {
        // examples/demo is conflicted too, but npm does not read it to make the root lockfile
        const demo = (version: string) => ({"examples/demo/package.json": member("demo", version, "4.17.19")})
        await commitFiles(dir, {...monorepo("1.0.0", "4.17.19"), ...demo("1.0.0")}, "base")
        await git(dir, ["checkout", "-b", "feature"])
        await commitFiles(dir, {...monorepo("1.2.0", "4.17.21"), ...demo("1.2.0")}, "feature")
        await git(dir, ["checkout", "main"])
        await commitFiles(dir, {...monorepo("1.1.0", "4.17.20"), ...demo("1.1.0")}, "main")
        await git(dir, ["merge", "feature"], true)
        assert.equal(await hasMarkers(dir, "examples/demo/package.json"), true)

        const stubs = await stubPackageManagers(scratch)
        const result = await runCli(["packages/a/package.json"], dir, stubs.env)
        assert.equal(result.code, 0, result.stderr)
        assert.deepEqual(await stubs.invocations(), [`npm|${dir}|install --package-lock-only`])
      })
    }
  )

  test("a workspace without a lockfile has nothing waiting to be regenerated", async () => {
    await withRepo(async dir => {
      const files = (version: string) => ({
        "package.json": ROOT,
        "packages/a/package.json": member("a", version, "4.17.19"),
        "packages/b/package.json": member("b", version, "4.17.19"),
      })
      await commitFiles(dir, files("1.0.0"), "base")
      await git(dir, ["checkout", "-b", "feature"])
      await commitFiles(dir, files("1.2.0"), "feature")
      await git(dir, ["checkout", "main"])
      await commitFiles(dir, files("1.1.0"), "main")
      await git(dir, ["merge", "feature"], true)

      const result = await runCli(["packages/a/package.json"], dir)
      assert.equal(result.code, 0, result.stderr)
      assert.equal((await readJson(dir, "packages/a/package.json")).version, "1.2.0")
      assert.doesNotMatch(result.stderr, /Lockfiles were not regenerated/)
      assert.equal(
        await hasMarkers(dir, "packages/b/package.json"),
        true,
        "only the file that was asked for is resolved"
      )
    })
  })

  test("is not regenerated while the member has values left to decide, and the run says where to", async () => {
    await withRepo(async dir => {
      const withScript = (version: string, build: string) =>
        j({name: "a", version, scripts: {build}, dependencies: {lodash: "^4.17.19"}})
      await commitFiles(
        dir,
        {...monorepo("1.0.0", "4.17.19"), "packages/a/package.json": withScript("1.0.0", "tsc")},
        "base"
      )
      await git(dir, ["checkout", "-b", "feature"])
      await commitFiles(dir, {"packages/a/package.json": withScript("1.0.0", "vite build")}, "feature")
      await git(dir, ["checkout", "main"])
      await commitFiles(dir, {"packages/a/package.json": withScript("1.0.0", "tsc -b")}, "main")
      await git(dir, ["merge", "feature"], true)

      const result = await runCli([], join(dir, "packages", "a"))
      assert.equal(result.code, 1)
      assert(
        result.stderr.includes(
          `Lockfiles were not regenerated: once package.json is decided, run "npm install --package-lock-only" in ${join("..", "..")}.`
        ),
        result.stderr
      )
    })
  })

  test("a pnpm workspace is resolved by pnpm, at its root", {skip: STUBS_NEED_POSIX}, async () => {
    await withRepo(async (dir, scratch) => {
      const files = (version: string, lodash: string) => ({
        "package.json": j({name: "root", private: true}),
        "pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n",
        "pnpm-lock.yaml": `lockfileVersion: '9.0'\nlodash: ${lodash}\n`,
        "apps/web/package.json": member("web", version, lodash),
      })
      await commitFiles(dir, files("1.0.0", "4.17.19"), "base")
      await git(dir, ["checkout", "-b", "feature"])
      await commitFiles(dir, files("1.2.0", "4.17.21"), "feature")
      await git(dir, ["checkout", "main"])
      await commitFiles(dir, files("1.1.0", "4.17.20"), "main")
      await git(dir, ["merge", "feature"], true)
      assert.equal(await hasMarkers(dir, "pnpm-lock.yaml"), true)

      const stubs = await stubPackageManagers(scratch)
      const result = await runCli(["apps/web/package.json"], dir, stubs.env)
      // The stub does not rewrite the lockfile, so its markers are still there: what matters is where pnpm ran
      assert.deepEqual([...new Set(await stubs.invocations())], [`pnpm|${dir}|install --lockfile-only`])
      assert.match(result.stderr, /pnpm-lock\.yaml has Git conflicts that this tool does not merge directly/)
    })
  })
})

describe("a lockfile above a package.json that is not its workspace root", () => {
  test("is left alone when the package is not among the workspaces", {skip: STUBS_NEED_POSIX}, async () => {
    await withRepo(async (dir, scratch) => {
      // examples/demo has no lockfile, and is not a workspace of the root
      await conflictingMerge(dir, ["a"], {"examples/demo/package.json": member("demo", "1.0.0", "4.17.19")})
      await git(dir, ["checkout", "-q", "main", "--", "packages/a/package.json"])
      const demo = join(dir, "examples", "demo", "package.json")
      await writeFile(
        demo,
        conflictedDocument(
          JSON.parse(member("demo", "1.1.0", "4.17.20")),
          JSON.parse(member("demo", "1.2.0", "4.17.21"))
        )
      )

      const stubs = await stubPackageManagers(scratch)
      const result = await runCli(["examples/demo/package.json"], dir, stubs.env)
      assert.equal(result.code, 0, result.stderr)
      assert.equal((await readJson(dir, "examples/demo/package.json")).version, "1.2.0")
      assert.equal(await hasMarkers(dir, "package-lock.json"), true, "the root lockfile is another project's")
      assert.deepEqual(await stubs.invocations(), [])
    })
  })

  test("is not looked for outside a Git repository", {skip: STUBS_NEED_POSIX}, async () => {
    await withTempDir(async dir => {
      const files = monorepo("1.0.0", "4.17.19")
      for (const [path, content] of Object.entries(files)) {
        await mkdir(join(dir, path, ".."), {recursive: true})
        await writeFile(join(dir, path), content)
      }
      await writeFile(
        join(dir, "packages", "a", "package.json"),
        conflictedDocument(JSON.parse(member("a", "1.1.0", "4.17.20")), JSON.parse(member("a", "1.2.0", "4.17.21")))
      )

      const stubs = await stubPackageManagers(dir)
      const result = await runCli(["packages/a/package.json"], dir, stubs.env)
      assert.equal(result.code, 0, result.stderr)
      assert.deepEqual(await stubs.invocations(), [], "without a repository, nothing says where the project ends")
    })
  })
})

describe("finding the folder of a package's lockfiles", () => {
  /** A repository with the given files, all empty objects unless given */
  async function withFiles<T>(files: Record<string, string>, fn: (dir: string) => Promise<T>): Promise<T> {
    return withRepo(async dir => {
      await commitFiles(dir, files, "files")
      return fn(dir)
    })
  }

  test("its own folder when it has a lockfile, even inside a workspace", async () => {
    await withFiles(
      {
        "package.json": ROOT,
        "package-lock.json": "{}\n",
        "packages/a/package.json": "{}\n",
        "packages/a/yarn.lock": "\n",
      },
      async dir => {
        assert.equal(await findLockfileDir(dir), dir)
        assert.equal(await findLockfileDir(join(dir, "packages", "a")), join(dir, "packages", "a"))
      }
    )
  })

  test("the workspace root, however deep the package is", async () => {
    await withFiles(
      {
        "package.json": j({workspaces: {packages: ["packages/**"]}}),
        "yarn.lock": "\n",
        "packages/group/deep/package.json": "{}\n",
      },
      async dir => {
        assert.equal(await findLockfileDir(join(dir, "packages", "group", "deep")), dir)
      }
    )
  })

  test("a workspace root that is not the repository root", async () => {
    await withFiles(
      {
        "package.json": "{}\n",
        "package-lock.json": "{}\n",
        "frontend/package.json": j({workspaces: ["apps/*"]}),
        "frontend/package-lock.json": "{}\n",
        "frontend/apps/web/package.json": "{}\n",
      },
      async dir => {
        assert.equal(await findLockfileDir(join(dir, "frontend", "apps", "web")), join(dir, "frontend"))
      }
    )
  })

  test("the nearest lockfile ends the search, whether or not it is the package's", async () => {
    await withFiles(
      {
        "package.json": j({workspaces: ["**"]}),
        "package-lock.json": "{}\n",
        // A project of its own, with a lockfile and no workspaces
        "tools/package.json": "{}\n",
        "tools/package-lock.json": "{}\n",
        "tools/cli/package.json": "{}\n",
      },
      async dir => {
        const cli = join(dir, "tools", "cli")
        assert.equal(await findLockfileDir(cli), cli)
      }
    )
  })

  test("its own folder when no folder above lists it, has a lockfile, or declares workspaces", async () => {
    await withFiles(
      {"package.json": j({workspaces: ["packages/*"]}), "package-lock.json": "{}\n", "docs/package.json": "{}\n"},
      async dir => assert.equal(await findLockfileDir(join(dir, "docs")), join(dir, "docs"))
    )
    await withFiles({"package.json": ROOT, "packages/a/package.json": "{}\n"}, async dir =>
      assert.equal(await findLockfileDir(join(dir, "packages", "a")), join(dir, "packages", "a"))
    )
    await withFiles({"package-lock.json": "{}\n", "packages/a/package.json": "{}\n"}, async dir =>
      assert.equal(await findLockfileDir(join(dir, "packages", "a")), join(dir, "packages", "a"))
    )
  })

  test(
    "a package reached through a symbolic link is on its own: its parents are not the repository's folders",
    {skip: process.platform === "win32" ? "creating symbolic links needs privileges on Windows" : false},
    async () => {
      await withRepo(async (dir, scratch) => {
        await commitFiles(
          dir,
          {"package.json": ROOT, "package-lock.json": "{}\n", "packages/a/package.json": "{}\n"},
          "files"
        )
        // A lockfile above the link, which the search must not reach
        await writeFile(join(scratch, "package.json"), j({workspaces: ["**"]}))
        await writeFile(join(scratch, "package-lock.json"), "{}\n")
        const link = join(scratch, "link")
        await symlink(join(dir, "packages", "a"), link)

        assert.equal(await findRepoRoot(link), undefined)
        assert.equal(await findLockfileDir(link), link)
        assert.equal(await findLockfileDir(join(dir, "packages", "a")), dir)
      })
    }
  )

  test("a root whose package.json cannot be read declares no workspaces", async () => {
    await withFiles({"package-lock.json": "{}\n", "packages/a/package.json": "{}\n"}, async dir => {
      await writeFile(join(dir, "package.json"), '{"workspaces": ["packages/*"')
      assert.deepEqual(await workspacePatterns(dir), [])
      assert.equal(await findLockfileDir(join(dir, "packages", "a")), join(dir, "packages", "a"))
    })
  })

  test("the workspaces of a root package.json that is conflicted itself are those of both branches", async () => {
    await withFiles(
      {"package-lock.json": "{}\n", "apps/web/package.json": "{}\n", "libs/ui/package.json": "{}\n"},
      async dir => {
        await writeFile(
          join(dir, "package.json"),
          conflictedDocument({name: "root", workspaces: ["apps/*"]}, {name: "root", workspaces: ["libs/*"]})
        )
        assert.deepEqual(await workspacePatterns(dir), ["apps/*", "libs/*"])
        assert.equal(await findLockfileDir(join(dir, "apps", "web")), dir)
        assert.equal(await findLockfileDir(join(dir, "libs", "ui")), dir)
      }
    )
  })
})

describe("workspace patterns", () => {
  const matches = (pattern: string | string[], member: string) => matchesWorkspace([pattern].flat(), member)

  test("a folder name, with and without wildcards", () => {
    assert.equal(matches("packages/a", "packages/a"), true)
    assert.equal(matches("packages/a", "packages/ab"), false)
    assert.equal(matches("packages/*", "packages/a"), true)
    assert.equal(matches("packages/*", "packages/@scope/a"), false, "* stays within one folder")
    assert.equal(matches("packages/*", "packages"), false)
    assert.equal(matches("packages/*", "other/a"), false)
    assert.equal(matches("packages/lib-*", "packages/lib-ui"), true)
    assert.equal(matches("packages/lib-*", "packages/app-ui"), false)
    assert.equal(matches("packages/?", "packages/a"), true)
    assert.equal(matches("packages/?", "packages/ab"), false)
    assert.equal(matches("*", "app"), true)
    assert.equal(matches("*", "packages/app"), false)
  })

  test("** spans folders", () => {
    assert.equal(matches("packages/**", "packages/a"), true)
    assert.equal(matches("packages/**", "packages/group/a"), true)
    assert.equal(matches("packages/**/ui", "packages/ui"), true)
    assert.equal(matches("packages/**/ui", "packages/a/b/ui"), true)
    assert.equal(matches("packages/**/ui", "packages/a/b/api"), false)
    assert.equal(matches("**", "anything/at/all"), true)
  })

  test("braces list alternatives", () => {
    assert.equal(matches("{apps,packages}/*", "apps/web"), true)
    assert.equal(matches("{apps,packages}/*", "packages/ui"), true)
    assert.equal(matches("{apps,packages}/*", "tools/cli"), false)
    assert.equal(matches("packages/{a,b}", "packages/b"), true)
    assert.equal(matches("packages/{a,b", "packages/a"), false, "unbalanced braces match nothing")
  })

  test("a pattern is written with or without ./, a trailing slash or backslashes", () => {
    for (const pattern of ["./packages/*", "packages/*/", "packages\\*", " packages/* "]) {
      assert.equal(matches(pattern, "packages/a"), true, pattern)
    }
  })

  test("! excludes, and node_modules is never a workspace", () => {
    assert.equal(matches(["packages/*", "!packages/legacy"], "packages/a"), true)
    assert.equal(matches(["packages/*", "!packages/legacy"], "packages/legacy"), false)
    assert.equal(matches(["!packages/legacy"], "packages/a"), false, "an exclusion includes nothing")
    assert.equal(matches("**", "packages/a/node_modules/dep"), false)
    assert.equal(matches([], "packages/a"), false)
  })

  test("characters that mean something to a regular expression are plain characters", () => {
    assert.equal(matches("pkgs/a.b", "pkgs/a.b"), true)
    assert.equal(matches("pkgs/a.b", "pkgs/axb"), false)
    assert.equal(matches("pkgs/a+(b)", "pkgs/a+(b)"), true)
    assert.equal(
      matches("pkgs/[ab]", "pkgs/a"),
      false,
      "character classes are not supported: no match, rather than too many"
    )
  })

  test("the packages of a pnpm-workspace.yaml", () => {
    assert.deepEqual(
      pnpmWorkspacePackages(
        [
          "# pnpm workspace",
          "packages:",
          "  - 'apps/*'",
          '  - "packages/**"   # every package',
          "  - tools/cli # the CLI",
          "  - '!**/test/**'",
          "",
          "catalog:",
          "  - not-a-package",
        ].join("\n")
      ),
      ["apps/*", "packages/**", "tools/cli", "!**/test/**"]
    )
    assert.deepEqual(pnpmWorkspacePackages('packages: ["apps/*", packages/*]\n'), ["apps/*", "packages/*"])
    assert.deepEqual(pnpmWorkspacePackages("catalog:\n  react: ^18.0.0\n"), [])
  })

  test("a conflicted pnpm-workspace.yaml gives the packages of both branches", () => {
    assert.deepEqual(
      pnpmWorkspacePackages(
        [
          "packages:",
          "  - 'apps/*'",
          "<<<<<<< HEAD",
          "  - 'libs/*'",
          "=======",
          "  - 'tools/*'",
          ">>>>>>> feature",
          "",
        ].join("\n")
      ),
      ["apps/*", "libs/*", "tools/*"]
    )
  })
})
