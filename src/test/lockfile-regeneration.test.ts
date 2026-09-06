/**
 * Tests for the lockfile regeneration flow: which package manager command is
 * run, where it runs, and how its outcome changes the CLI's exit code.
 *
 * The package managers are stubbed by putting fake executables first on PATH,
 * so these tests exercise the real spawn/exit-code logic without a network or
 * a real npm install.
 */

import {strict as assert} from "assert"
import {test, describe} from "node:test"
import {spawn} from "node:child_process"
import {chmod, mkdir, mkdtemp, readFile, realpath, writeFile, rm} from "fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"

const CLI_PATH = join(__dirname, "..", "cli.js")

// The package-manager stubs rely on a #!/bin/sh shebang, which Windows cannot
// execute. The behavior under test is platform-independent, so skip there.
const SKIP_ON_WINDOWS = process.platform === "win32" ? "stubbed executables need a POSIX shell" : false

interface CliResult {
  code: number | null
  stdout: string
  stderr: string
}

/** Every stub invocation, as "<command>|<cwd>|<args>" */
type Invocations = string[]

interface Harness {
  dir: string
  /** Commands the stubs recorded, in order */
  invocations(): Promise<Invocations>
  run(args: string[], env?: Record<string, string>, cwd?: string): Promise<CliResult>
}

/**
 * The stub runs with PATH pointing only at the stub directory (so a package
 * manager can be made genuinely absent), which means it must use shell
 * builtins only — no basename, no cp.
 */
const STUB_SOURCE = [
  "#!/bin/sh",
  // Record the command name, the directory it ran in, and its arguments
  'printf "%s|%s|%s\\n" "${0##*/}" "$PWD" "$*" >> "$PCR_STUB_LOG"',
  // Optionally stand in for a package manager rewriting a lockfile
  'if [ -n "$PCR_STUB_LOCK_CONTENT" ]; then',
  '  printf "%s" "$PCR_STUB_LOCK_CONTENT" > "$PWD/package-lock.json"',
  "fi",
  'if [ -n "$PCR_STUB_YARN_CONTENT" ]; then',
  '  printf "%s" "$PCR_STUB_YARN_CONTENT" > "$PWD/yarn.lock"',
  "fi",
  'if [ -z "$PCR_STUB_EXIT" ]; then exit 0; fi',
  'exit "$PCR_STUB_EXIT"',
].join("\n")

/**
 * Create a temp project with fake npm/pnpm/yarn/bun executables ahead of the
 * real ones on PATH. `commands` limits which stubs exist, so a missing
 * package manager can be simulated.
 */
async function withHarness<T>(
  fn: (harness: Harness) => Promise<T>,
  commands: string[] = ["npm", "pnpm", "yarn", "bun"]
): Promise<T> {
  // macOS puts temp dirs behind a symlink (/var -> /private/var), and a shell's
  // $PWD is always the resolved path, so canonicalize here to keep the
  // directory the stubs report comparable with the one the test set up.
  const root = await realpath(await mkdtemp(join(tmpdir(), "pcr-regen-")))
  const binDir = join(root, "bin")
  const dir = join(root, "project")
  const log = join(root, "invocations.log")
  await mkdir(binDir)
  await mkdir(dir)
  await writeFile(log, "", "utf8")

  for (const command of commands) {
    const path = join(binDir, command)
    await writeFile(path, STUB_SOURCE, "utf8")
    await chmod(path, 0o755)
  }

  const harness: Harness = {
    dir,
    async invocations() {
      const content = await readFile(log, "utf8")
      return content.split("\n").filter(line => line.trim() !== "")
    },
    run(args, env = {}, cwd = dir) {
      return new Promise((resolvePromise, reject) => {
        const child = spawn(process.execPath, [CLI_PATH, ...args], {
          cwd,
          stdio: ["ignore", "pipe", "pipe"],
          env: {...process.env, PATH: binDir, PCR_STUB_LOG: log, ...env},
        })
        let stdout = ""
        let stderr = ""
        child.stdout.on("data", chunk => (stdout += chunk))
        child.stderr.on("data", chunk => (stderr += chunk))
        child.on("error", reject)
        child.on("close", code => resolvePromise({code, stdout, stderr}))
      })
    },
  }

  try {
    return await fn(harness)
  } finally {
    await rm(root, {recursive: true, force: true})
  }
}

const j = (value: unknown) => JSON.stringify(value, null, 2) + "\n"

const lockEntry = (name: string, version: string) => ({
  version,
  resolved: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
  integrity: `sha512-${name}-${version}`,
})

const lock = (rootDeps: Record<string, string>, versions: Record<string, string>) =>
  j({
    name: "app",
    version: "1.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": {name: "app", version: "1.0.0", dependencies: rootDeps},
      ...Object.fromEntries(
        Object.entries(versions).map(([name, version]) => [`node_modules/${name}`, lockEntry(name, version)])
      ),
    },
  })

const CONFLICTED_PACKAGE_JSON = [
  "{",
  '  "name": "app",',
  "<<<<<<< HEAD",
  '  "version": "1.1.0",',
  "=======",
  '  "version": "1.2.0",',
  ">>>>>>> feature",
  '  "dependencies": {',
  '    "foo": "^1.0.0"',
  "  }",
  "}",
  "",
].join("\n")

/** A lockfile whose merge leaves the root spec unsatisfied */
const CONFLICTED_INCONSISTENT_LOCK = [
  "{",
  '  "name": "app",',
  '  "lockfileVersion": 3,',
  '  "packages": {',
  '    "": {',
  '      "name": "app",',
  '      "dependencies": {',
  "<<<<<<< HEAD",
  '        "foo": "^1.0.0"',
  "=======",
  '        "foo": "1.2.0"',
  ">>>>>>> feature",
  "      }",
  "    },",
  '    "node_modules/foo": {',
  "<<<<<<< HEAD",
  '      "version": "1.5.0",',
  '      "integrity": "sha512-a"',
  "=======",
  '      "version": "1.2.0",',
  '      "integrity": "sha512-b"',
  ">>>>>>> feature",
  "    }",
  "  }",
  "}",
  "",
].join("\n")

/** A lockfile this tool cannot merge at all: neither side is parseable */
const UNMERGEABLE_LOCK = [
  "{",
  '  "name": "app",',
  "<<<<<<< HEAD",
  "  our garbage {{{",
  "=======",
  "  their garbage }}}",
  ">>>>>>> feature",
  "}",
  "",
].join("\n")

describe("npm lockfile regeneration", {skip: SKIP_ON_WINDOWS}, () => {
  test("runs 'npm install --package-lock-only' in the project directory after a merge", async () => {
    await withHarness(async harness => {
      await writeFile(join(harness.dir, "package.json"), CONFLICTED_PACKAGE_JSON, "utf8")
      await writeFile(join(harness.dir, "package-lock.json"), lock({foo: "^1.0.0"}, {foo: "1.5.0"}), "utf8")

      const result = await harness.run([])
      assert.equal(result.code, 0, result.stderr)

      const invocations = await harness.invocations()
      assert.equal(invocations.length, 1, `expected exactly one command, got: ${invocations.join(" / ")}`)
      assert.equal(invocations[0], `npm|${harness.dir}|install --package-lock-only`)
      assert.match(result.stdout, /Regenerating package-lock\.json with npm/)
      assert.match(result.stdout, /Regenerated package-lock\.json/)
    })
  })

  test("regenerates in the package.json's directory, not the current one", async () => {
    await withHarness(async harness => {
      await writeFile(join(harness.dir, "package.json"), CONFLICTED_PACKAGE_JSON, "utf8")
      await writeFile(join(harness.dir, "package-lock.json"), lock({foo: "^1.0.0"}, {foo: "1.5.0"}), "utf8")

      // Run from the parent directory, targeting the project by path
      const parent = join(harness.dir, "..")
      const result = await harness.run([join(harness.dir, "package.json")], {}, parent)
      assert.equal(result.code, 0, result.stderr)

      const invocations = await harness.invocations()
      assert.equal(invocations.length, 1)
      assert.equal(invocations[0], `npm|${harness.dir}|install --package-lock-only`)
    })
  })

  test("regeneration heals an inconsistent lockfile and the command exits 0", async () => {
    await withHarness(async harness => {
      // What npm would produce: the pin honored on both sides
      const healed = lock({foo: "1.2.0"}, {foo: "1.2.0"})

      await writeFile(join(harness.dir, "package.json"), j({name: "app", dependencies: {foo: "1.2.0"}}), "utf8")
      await writeFile(join(harness.dir, "package-lock.json"), CONFLICTED_INCONSISTENT_LOCK, "utf8")

      const result = await harness.run([], {PCR_STUB_LOCK_CONTENT: healed})
      assert.equal(result.code, 0, result.stderr)
      assert.doesNotMatch(result.stderr, /not consistent/, "a healed lockfile must not be reported")

      const written = JSON.parse(await readFile(join(harness.dir, "package-lock.json"), "utf8"))
      assert.equal(written.packages["node_modules/foo"].version, "1.2.0")
    })
  })

  test("an inconsistent lockfile is reported and exits 1 when regeneration fails", async () => {
    await withHarness(async harness => {
      await writeFile(join(harness.dir, "package.json"), j({name: "app", dependencies: {foo: "1.2.0"}}), "utf8")
      await writeFile(join(harness.dir, "package-lock.json"), CONFLICTED_INCONSISTENT_LOCK, "utf8")

      const result = await harness.run([], {PCR_STUB_EXIT: "1"})
      assert.equal(result.code, 1)
      assert.match(result.stderr, /Failed to regenerate package-lock\.json/)
      assert.match(result.stdout, /You may need to run "npm install --package-lock-only" manually/)
      assert.match(result.stderr, /not consistent/)
      assert.match(result.stderr, /the root project requires foo@1\.2\.0 but node_modules\/foo is 1\.5\.0/)
    })
  })

  test("npm resolving a lockfile this tool could not merge clears the failure", async () => {
    await withHarness(async harness => {
      const healed = lock({foo: "^1.0.0"}, {foo: "1.5.0"})

      await writeFile(join(harness.dir, "package.json"), CONFLICTED_PACKAGE_JSON, "utf8")
      await writeFile(join(harness.dir, "package-lock.json"), UNMERGEABLE_LOCK, "utf8")

      const result = await harness.run([], {PCR_STUB_LOCK_CONTENT: healed})
      assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`)
      assert.match(result.stdout, /package-lock\.json was regenerated by npm and no longer has conflicts/)

      const written = await readFile(join(harness.dir, "package-lock.json"), "utf8")
      assert(!written.includes("<<<<<<<"))
    })
  })

  test("a lockfile npm could not fix keeps its conflict markers and exits 1", async () => {
    await withHarness(async harness => {
      await writeFile(join(harness.dir, "package.json"), CONFLICTED_PACKAGE_JSON, "utf8")
      await writeFile(join(harness.dir, "package-lock.json"), UNMERGEABLE_LOCK, "utf8")

      // npm "succeeds" but leaves the file untouched (no PCR_STUB_LOCK_SOURCE)
      const result = await harness.run([])
      assert.equal(result.code, 1)
      assert.match(result.stderr, /package-lock\.json still has Git conflict markers/)
      assert.match(result.stderr, /npm install --package-lock-only/)
      assert((await readFile(join(harness.dir, "package-lock.json"), "utf8")).includes("<<<<<<<"))
    })
  })

  test("a missing package manager is reported without crashing", async () => {
    await withHarness(
      async harness => {
        await writeFile(join(harness.dir, "package.json"), CONFLICTED_PACKAGE_JSON, "utf8")
        await writeFile(join(harness.dir, "package-lock.json"), lock({foo: "^1.0.0"}, {foo: "1.5.0"}), "utf8")

        const result = await harness.run([])
        assert.equal(result.code, 0, result.stderr)
        assert.match(result.stderr, /Failed to regenerate package-lock\.json/)
        assert.match(result.stdout, /You may need to run "npm install --package-lock-only" manually/)
      },
      [] // no package managers installed at all
    )
  })

  test("--no-regenerate-lock runs no package manager", async () => {
    await withHarness(async harness => {
      await writeFile(join(harness.dir, "package.json"), CONFLICTED_PACKAGE_JSON, "utf8")
      await writeFile(join(harness.dir, "package-lock.json"), lock({foo: "^1.0.0"}, {foo: "1.5.0"}), "utf8")

      const result = await harness.run(["--no-regenerate-lock"])
      assert.equal(result.code, 0, result.stderr)
      assert.deepEqual(await harness.invocations(), [])
    })
  })

  test("--dry-run runs no package manager and leaves files untouched", async () => {
    await withHarness(async harness => {
      const original = lock({foo: "^1.0.0"}, {foo: "1.5.0"})
      await writeFile(join(harness.dir, "package.json"), CONFLICTED_PACKAGE_JSON, "utf8")
      await writeFile(join(harness.dir, "package-lock.json"), original, "utf8")

      const result = await harness.run(["--dry-run"])
      assert.equal(result.code, 0, result.stderr)
      assert.deepEqual(await harness.invocations(), [])
      assert.equal(await readFile(join(harness.dir, "package.json"), "utf8"), CONFLICTED_PACKAGE_JSON)
      assert.equal(await readFile(join(harness.dir, "package-lock.json"), "utf8"), original)
    })
  })

  test("a project with no lockfile at all runs nothing", async () => {
    await withHarness(async harness => {
      await writeFile(join(harness.dir, "package.json"), CONFLICTED_PACKAGE_JSON, "utf8")

      const result = await harness.run([])
      assert.equal(result.code, 0, result.stderr)
      assert.deepEqual(await harness.invocations(), [])
    })
  })

  test("npm-shrinkwrap.json is regenerated with the same npm command, only once", async () => {
    await withHarness(async harness => {
      await writeFile(join(harness.dir, "package.json"), CONFLICTED_PACKAGE_JSON, "utf8")
      await writeFile(join(harness.dir, "package-lock.json"), lock({foo: "^1.0.0"}, {foo: "1.5.0"}), "utf8")
      await writeFile(join(harness.dir, "npm-shrinkwrap.json"), lock({foo: "^1.0.0"}, {foo: "1.5.0"}), "utf8")

      const result = await harness.run([])
      assert.equal(result.code, 0, result.stderr)

      const invocations = await harness.invocations()
      assert.equal(invocations.length, 1, "npm must not be run twice for two npm lockfiles")
    })
  })
})

describe("other package managers", {skip: SKIP_ON_WINDOWS}, () => {
  const conflictedYarnLock = [
    "# yarn lockfile v1",
    "<<<<<<< HEAD",
    "lodash@^4.17.21:",
    '  version "4.17.21"',
    "=======",
    "lodash@^4.17.20:",
    '  version "4.17.20"',
    ">>>>>>> feature",
    "",
  ].join("\n")

  test("pnpm-lock.yaml is delegated to 'pnpm install --lockfile-only'", async () => {
    await withHarness(async harness => {
      await writeFile(join(harness.dir, "package.json"), CONFLICTED_PACKAGE_JSON, "utf8")
      await writeFile(join(harness.dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8")
      await writeFile(join(harness.dir, "package-lock.json"), lock({foo: "^1.0.0"}, {foo: "1.5.0"}), "utf8")

      const result = await harness.run([])
      assert.equal(result.code, 0, result.stderr)

      const invocations = await harness.invocations()
      assert(
        invocations.some(line => line.startsWith(`npm|${harness.dir}|install --package-lock-only`)),
        `npm should regenerate its own lockfile: ${invocations.join(" / ")}`
      )
      assert(
        invocations.some(line => line.startsWith(`pnpm|${harness.dir}|install --lockfile-only`)),
        `pnpm should regenerate its own lockfile: ${invocations.join(" / ")}`
      )
    })
  })

  test("a conflicted yarn.lock in a Berry project is fixed with --mode update-lockfile", async () => {
    await withHarness(async harness => {
      await writeFile(join(harness.dir, "package.json"), j({name: "app", packageManager: "yarn@4.1.0"}), "utf8")
      await writeFile(join(harness.dir, "yarn.lock"), conflictedYarnLock, "utf8")

      const result = await harness.run([], {PCR_STUB_YARN_CONTENT: "# yarn lockfile v1\n"})
      assert.equal(result.code, 0, result.stderr)

      const invocations = await harness.invocations()
      assert.equal(invocations[0], `yarn|${harness.dir}|install --mode update-lockfile`)
      assert.match(result.stdout, /Resolved yarn\.lock via "yarn install --mode update-lockfile"/)
      assert(!(await readFile(join(harness.dir, "yarn.lock"), "utf8")).includes("<<<<<<<"))
    })
  })

  test("a conflicted yarn.lock in a classic project prints the manual command and exits 1", async () => {
    await withHarness(async harness => {
      await writeFile(join(harness.dir, "package.json"), j({name: "app"}), "utf8")
      await writeFile(join(harness.dir, "yarn.lock"), conflictedYarnLock, "utf8")

      const result = await harness.run([])
      assert.equal(result.code, 1)
      assert.deepEqual(await harness.invocations(), [], "yarn classic has no lockfile-only mode to run")
      assert.match(result.stderr, /yarn\.lock has Git conflicts that this tool does not merge directly/)
      assert.match(result.stderr, /Run "yarn install"/)
    })
  })

  test("a yarn.lock left conflicted by its own package manager still exits 1", async () => {
    await withHarness(async harness => {
      await writeFile(join(harness.dir, "package.json"), j({name: "app", packageManager: "yarn@4.1.0"}), "utf8")
      await writeFile(join(harness.dir, "yarn.lock"), conflictedYarnLock, "utf8")

      // yarn "succeeds" but does not rewrite the file
      const result = await harness.run([])
      assert.equal(result.code, 1)
      assert.match(result.stderr, /yarn\.lock has Git conflicts/)
    })
  })

  test("never creates a lockfile for a package manager the project does not use", async () => {
    await withHarness(async harness => {
      await writeFile(join(harness.dir, "package.json"), CONFLICTED_PACKAGE_JSON, "utf8")
      await writeFile(join(harness.dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8")

      const result = await harness.run([])
      assert.equal(result.code, 0, result.stderr)

      const invocations = await harness.invocations()
      assert.equal(invocations.length, 1)
      assert(invocations[0]!.startsWith("pnpm|"), `only pnpm should run, got: ${invocations.join(" / ")}`)
    })
  })
})

describe("output contracts during regeneration", {skip: SKIP_ON_WINDOWS}, () => {
  test("--json keeps every stdout line parseable while regenerating", async () => {
    await withHarness(async harness => {
      await writeFile(join(harness.dir, "package.json"), CONFLICTED_PACKAGE_JSON, "utf8")
      await writeFile(join(harness.dir, "package-lock.json"), lock({foo: "^1.0.0"}, {foo: "1.5.0"}), "utf8")

      const result = await harness.run(["--json"])
      assert.equal(result.code, 0, result.stderr)

      const lines = result.stdout.split("\n").filter(line => line.trim() !== "")
      assert(lines.length > 0, "expected JSON output")
      for (const line of lines) {
        assert.doesNotThrow(() => JSON.parse(line), `not valid JSON: ${line}`)
      }
      assert(
        lines.some(line => JSON.parse(line).message.includes("Regenerated package-lock.json")),
        "the regeneration result must still be reported, as JSON"
      )
    })
  })

  test("--json stays parseable when the package manager writes to stdout itself", async () => {
    await withHarness(async harness => {
      await writeFile(join(harness.dir, "package.json"), CONFLICTED_PACKAGE_JSON, "utf8")
      await writeFile(join(harness.dir, "package-lock.json"), lock({foo: "^1.0.0"}, {foo: "1.5.0"}), "utf8")

      // A real `npm install` prints progress; it must not leak into --json stdout
      const noisyNpm = join(harness.dir, "..", "bin", "npm")
      await writeFile(
        noisyNpm,
        ["#!/bin/sh", 'printf "added 42 packages in 3s\\n"', 'printf "npm notice something\\n" >&2', "exit 0"].join(
          "\n"
        ),
        "utf8"
      )
      await chmod(noisyNpm, 0o755)

      const result = await harness.run(["--json"])
      assert.equal(result.code, 0, result.stderr)
      for (const line of result.stdout.split("\n").filter(line => line.trim() !== "")) {
        assert.doesNotThrow(() => JSON.parse(line), `not valid JSON: ${line}`)
      }
    })
  })

  test("--quiet prints nothing on stdout while regenerating", async () => {
    await withHarness(async harness => {
      await writeFile(join(harness.dir, "package.json"), CONFLICTED_PACKAGE_JSON, "utf8")
      await writeFile(join(harness.dir, "package-lock.json"), lock({foo: "^1.0.0"}, {foo: "1.5.0"}), "utf8")

      const result = await harness.run(["--quiet"])
      assert.equal(result.code, 0, result.stderr)
      assert.equal(result.stdout.trim(), "")
      assert.equal((await harness.invocations()).length, 1, "regeneration still runs when quiet")
    })
  })

  test("--quiet stays silent even when regeneration fails", async () => {
    await withHarness(async harness => {
      await writeFile(join(harness.dir, "package.json"), CONFLICTED_PACKAGE_JSON, "utf8")
      await writeFile(join(harness.dir, "package-lock.json"), lock({foo: "^1.0.0"}, {foo: "1.5.0"}), "utf8")

      const result = await harness.run(["--quiet"], {PCR_STUB_EXIT: "1"})
      assert.equal(result.code, 0, result.stderr)
      assert.equal(result.stdout.trim(), "")
      assert.equal(result.stderr.trim(), "")
    })
  })
})
