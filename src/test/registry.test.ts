/**
 * Registry lookups for picked versions: interpreting `npm view` output, and
 * running the real npm CLI against a local fake registry (so the project's
 * npm configuration path is exercised without a network).
 */

import {strict as assert} from "assert"
import {test, describe, before, after} from "node:test"
import {mkdtemp, readFile, writeFile} from "fs/promises"
import {tmpdir} from "node:os"
import {delimiter, join} from "node:path"
import {createNpmVersionLookup, parseNpmViewOutput, DEFAULT_LOOKUP_TIMEOUT_MS} from "../registry.js"
import {needsShell, runCommand, shellCommandLine} from "../process.js"
import {FakeRegistry, startFakeRegistry} from "./fake-registry.js"
import {removeDir} from "./cli-harness.js"

const ok = (stdout: string) => ({code: 0, stdout, stderr: ""})

describe("parseNpmViewOutput", () => {
  test("reads versions and dist-tags", () => {
    const stdout = JSON.stringify({versions: ["1.0.0", "1.1.0"], "dist-tags": {latest: "1.1.0", next: "2.0.0-rc.1"}})
    assert.deepEqual(parseNpmViewOutput(ok(stdout)), {
      versions: ["1.0.0", "1.1.0"],
      distTags: {latest: "1.1.0", next: "2.0.0-rc.1"},
    })
  })

  test("tolerates a single version printed as a string, and missing or malformed fields", () => {
    assert.deepEqual(parseNpmViewOutput(ok(JSON.stringify({versions: "1.0.0"}))), {versions: ["1.0.0"], distTags: {}})
    assert.deepEqual(parseNpmViewOutput(ok(JSON.stringify({versions: [1, "2.0.0", null], "dist-tags": []}))), {
      versions: ["2.0.0"],
      distTags: {},
    })
    assert.deepEqual(parseNpmViewOutput(ok(JSON.stringify({"dist-tags": {latest: "1.0.0", broken: 3}}))), {
      versions: [],
      distTags: {latest: "1.0.0"},
    })
  })

  test("no output means no published versions", () => {
    assert.deepEqual(parseNpmViewOutput(ok("")), {versions: [], distTags: {}})
    assert.deepEqual(parseNpmViewOutput(ok("\n  \n")), {versions: [], distTags: {}})
  })

  test("output that is not a JSON object is an error", () => {
    assert.throws(() => parseNpmViewOutput(ok("npm WARN something")), /npm view printed something that is not JSON/)
    assert.throws(() => parseNpmViewOutput(ok('["1.0.0"]')), /npm view printed an unexpected result/)
    assert.throws(() => parseNpmViewOutput(ok("null")), /npm view printed an unexpected result/)
  })

  test("E404 means the registry does not have the package, wherever npm prints it", () => {
    const json = JSON.stringify({error: {code: "E404", summary: "Not Found - GET https://r/nope"}})
    assert.equal(parseNpmViewOutput({code: 1, stdout: json, stderr: ""}), null)
    assert.equal(
      parseNpmViewOutput({code: 1, stdout: "", stderr: "npm error code E404\nnpm error 404 Not Found"}),
      null
    )
  })

  test("other failures carry npm's own explanation", () => {
    const summary = "FetchError: request to http://127.0.0.1:9/lodash failed, reason: connect ECONNREFUSED"
    const json = JSON.stringify({error: {code: "ECONNREFUSED", summary, detail: "proxy?"}})
    assert.throws(() => parseNpmViewOutput({code: 1, stdout: json, stderr: ""}), {message: summary})
    // npm versions that print the JSON error on stderr
    assert.throws(() => parseNpmViewOutput({code: 1, stdout: "", stderr: json}), {message: summary})

    // Without JSON: the first telling "npm error" line
    const stderr = [
      "npm error code ECONNREFUSED",
      "npm error syscall connect",
      "npm error errno ECONNREFUSED",
      "npm error FetchError: request failed, reason: connect ECONNREFUSED",
      "npm error A complete log of this run can be found in: /tmp/x.log",
    ].join("\n")
    assert.throws(() => parseNpmViewOutput({code: 1, stdout: "", stderr}), {
      message: "FetchError: request failed, reason: connect ECONNREFUSED",
    })
    assert.throws(() => parseNpmViewOutput({code: 1, stdout: "", stderr: "npm ERR! code E500\nnpm ERR! 500 Oops\n"}), {
      message: "500 Oops",
    })

    // A blank JSON summary falls back to stderr, and nothing at all to the exit code
    const blank = JSON.stringify({error: {code: "EX", summary: "  "}})
    assert.throws(() => parseNpmViewOutput({code: 1, stdout: blank, stderr: "npm error broken"}), {message: "broken"})
    assert.throws(() => parseNpmViewOutput({code: 2, stdout: "", stderr: ""}), {
      message: "npm view exited with code 2",
    })
    assert.throws(() => parseNpmViewOutput({code: null, stdout: "{}", stderr: "npm error code X\n"}), {
      message: "npm view exited with code null",
    })
  })
})

describe("runCommand", () => {
  const node = process.execPath

  test("captures output and the exit code", async () => {
    const result = await runCommand(node, [
      "-e",
      'process.stdout.write("out"); process.stderr.write("err"); process.exit(3)',
    ])
    assert.deepEqual(result, {code: 3, stdout: "out", stderr: "err"})
  })

  test("runs in the given directory with the given environment", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pcr-run-"))
    try {
      const result = await runCommand(node, ["-e", "console.log(process.cwd(), process.env.PCR_TEST_VALUE)"], {
        cwd: dir,
        env: {...process.env, PCR_TEST_VALUE: "set"},
      })
      assert.equal(result.code, 0)
      assert.match(result.stdout, /set/)
    } finally {
      await removeDir(dir)
    }
  })

  test("rejects when the command cannot be started", async () => {
    await assert.rejects(runCommand("pcr-no-such-command-anywhere", []), {code: "ENOENT"})
  })

  test("kills a command that runs too long", async () => {
    const started = Date.now()
    await assert.rejects(runCommand(node, ["-e", "setTimeout(() => {}, 30000)"], {timeoutMs: 200}), {
      message: "timed out after 0.2s",
    })
    assert(Date.now() - started < 10000, "must not wait for the command")
  })

  test("a command that finishes in time is not affected by the timeout", async () => {
    const result = await runCommand(node, ["-e", "console.log('quick')"], {timeoutMs: 30000})
    assert.equal(result.stdout.trim(), "quick")
  })

  test("a package manager runs without a deprecation warning, through the Windows shell too", async () => {
    // --throw-deprecation turns the warning Node 24 gives for arguments handed to a shell (DEP0190) into a failure
    const processModule = JSON.stringify(join(__dirname, "..", "process.js"))
    const script = `require(${processModule}).runCommand("npm", ["--version"]).then(result => process.exit(result.code))`
    const result = await runCommand(node, ["--throw-deprecation", "-e", script])
    assert.equal(result.code, 0, result.stderr)
    assert.doesNotMatch(result.stderr, /DeprecationWarning|DEP0190/)
  })

  test(
    "on timeout, a command run through the Windows shell is stopped with what it started",
    {skip: process.platform !== "win32" && "only Windows runs package managers through a shell"},
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "pcr-tree-"))
      const pidFile = join(dir, "pid")
      let pid: number | undefined
      try {
        // An npm shim that starts a node process, as npm.cmd does, which never ends by itself
        const code = "require('fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)"
        await writeFile(join(dir, "npm.cmd"), `@"${process.execPath}" -e "${code}" "${pidFile}"\r\n`)
        const pathKey = Object.keys(process.env).find(key => key.toUpperCase() === "PATH") ?? "PATH"
        const env = {...process.env, [pathKey]: `${dir}${delimiter}${process.env[pathKey] ?? ""}`}

        await assert.rejects(runCommand("npm", [], {env, timeoutMs: 3000}), {message: "timed out after 3s"})
        pid = Number(await readFile(pidFile, "utf8"))
        assert.throws(() => process.kill(pid as number, 0), {code: "ESRCH"}, "the node process must be stopped too")
      } finally {
        try {
          if (pid !== undefined) process.kill(pid)
        } catch {
          // already stopped
        }
        await removeDir(dir)
      }
    }
  )
})

describe("shellCommandLine", () => {
  test("plain arguments go as they are", () => {
    assert.equal(
      shellCommandLine("npm", ["view", "@scope/pkg", "versions", "--json", "--fetch-retries=1"]),
      "npm view @scope/pkg versions --json --fetch-retries=1"
    )
    assert.equal(shellCommandLine("pnpm", ["install", "--lockfile-only"]), "pnpm install --lockfile-only")
  })

  test("spaces and the characters cmd.exe interprets are kept literal between double quotes", () => {
    assert.equal(
      shellCommandLine("npm", ["view", "a b", "x&y", "^1.0.0", "(a)", "<b>|c", ""]),
      'npm view "a b" "x&y" "^1.0.0" "(a)" "<b>|c" ""'
    )
  })

  test("backslashes right before the closing quote are doubled, so that they do not escape it", () => {
    assert.equal(shellCommandLine("npm", ["C:\\my dir\\"]), 'npm "C:\\my dir\\\\"')
    assert.equal(shellCommandLine("npm", ["C:\\dir\\file"]), 'npm "C:\\dir\\file"')
  })

  test("refuses what cmd.exe cannot carry safely", () => {
    for (const arg of ['say "hi"', "%PATH%", "wow!", "two\nlines", "carriage\rreturn"]) {
      assert.throws(
        () => shellCommandLine("npm", [arg]),
        /cannot be passed to a command through the Windows shell/,
        arg
      )
    }
  })
})

describe("needsShell", () => {
  test("only package manager shims on Windows need a shell", () => {
    for (const command of ["npm", "npx", "yarn", "pnpm", "bun"]) {
      assert.equal(needsShell(command, "win32"), true, command)
      assert.equal(needsShell(command, "linux"), false, command)
      assert.equal(needsShell(command, "darwin"), false, command)
    }
    assert.equal(needsShell("git", "win32"), false)
    assert.equal(needsShell("where", "win32"), false)
    assert.equal(needsShell("npm"), process.platform === "win32", "defaults to the current platform")
  })
})

describe("createNpmVersionLookup (real npm, fake registry)", () => {
  let registry: FakeRegistry
  let dir: string
  const savedEnv: Record<string, string | undefined> = {}

  before(async () => {
    registry = await startFakeRegistry({
      lodash: ["4.17.20", "4.17.21"],
      "@scope/pkg": {versions: ["1.0.0", "2.0.0-beta.1"], distTags: {latest: "1.0.0", next: "2.0.0-beta.1"}},
    })
    dir = await mkdtemp(join(tmpdir(), "pcr-registry-"))
    // npm inherits this process's environment
    for (const [key, value] of Object.entries(registry.npmEnv)) {
      savedEnv[key] = process.env[key]
      process.env[key] = value
    }
  })

  after(async () => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await registry.close()
    await removeDir(dir)
  })

  test("lists the published versions and dist-tags", async () => {
    const lookup = createNpmVersionLookup({cwd: dir})
    assert.deepEqual(await lookup("lodash"), {versions: ["4.17.20", "4.17.21"], distTags: {latest: "4.17.21"}})
  })

  test("scoped packages", async () => {
    const lookup = createNpmVersionLookup({cwd: dir})
    assert.deepEqual(await lookup("@scope/pkg"), {
      versions: ["1.0.0", "2.0.0-beta.1"],
      distTags: {latest: "1.0.0", next: "2.0.0-beta.1"},
    })
  })

  test("an unknown package resolves to null", async () => {
    assert.equal(await createNpmVersionLookup({cwd: dir})("not-in-the-registry"), null)
  })

  test("a registry failure rejects with npm's explanation", async () => {
    await assert.rejects(createNpmVersionLookup({cwd: dir})("broken"), /500/)
  })

  test("a registry that never answers is given up on", async () => {
    await assert.rejects(
      createNpmVersionLookup({cwd: dir, timeoutMs: 1500})("hanging"),
      /npm view timed out after 1.5s/
    )
  })

  test("an invalid name never reaches the command line", async () => {
    const before = registry.requests.length
    await assert.rejects(createNpmVersionLookup({cwd: dir})("foo & calc"), /"foo & calc" is not a valid package name/)
    assert.equal(registry.requests.length, before)
  })

  test(
    "a missing npm is reported as such",
    {skip: process.platform === "win32" && "cmd reports it differently"},
    async () => {
      const path = process.env.PATH
      process.env.PATH = dir // a folder without npm
      try {
        await assert.rejects(createNpmVersionLookup({cwd: dir})("lodash"), {message: "npm was not found on PATH"})
      } finally {
        process.env.PATH = path
      }
    }
  )

  test("waits a minute by default", () => {
    assert.equal(DEFAULT_LOOKUP_TIMEOUT_MS, 60000)
  })
})
