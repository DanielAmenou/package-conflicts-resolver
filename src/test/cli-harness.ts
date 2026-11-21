/**
 * Helpers for tests that run the built CLI (and git) in temporary folders.
 */

import {spawn, SpawnOptions} from "node:child_process"
import {chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile} from "fs/promises"
import {tmpdir} from "node:os"
import {delimiter, dirname, join} from "node:path"
import {shellCommandLine} from "../process.js"

export const CLI_PATH = join(__dirname, "..", "cli.js")

export interface RunResult {
  code: number | null
  stdout: string
  stderr: string
}

/** Run a command to completion; `shell` is for Windows .cmd shims such as npm.cmd */
export function run(
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
  shell = false
): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    const options: SpawnOptions = {cwd, env: {...process.env, ...env}, stdio: ["ignore", "pipe", "pipe"]}
    // Quoted like the CLI quotes it: Node warns about arguments handed to a shell (DEP0190)
    const child = shell
      ? spawn(shellCommandLine(command, args), {...options, shell: true})
      : spawn(command, args, options)
    let stdout = ""
    let stderr = ""
    child.stdout!.on("data", chunk => (stdout += chunk))
    child.stderr!.on("data", chunk => (stderr += chunk))
    child.on("error", reject)
    child.on("close", code => resolvePromise({code, stdout, stderr}))
  })
}

export function runCli(args: string[], cwd: string, env: Record<string, string> = {}): Promise<RunResult> {
  return run(process.execPath, [CLI_PATH, ...args], cwd, env)
}

/**
 * Run the CLI behind a slow reader that leaves its stdout unread for `delayMs`.
 * The pipe fills up, so the end of a large output is still queued when the
 * command finishes: a command that exits without flushing loses it.
 */
export function runCliWithSlowReader(
  args: string[],
  cwd: string,
  delayMs: number,
  env: Record<string, string> = {}
): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      cwd,
      env: {...process.env, ...env},
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    // Paused before a listener is attached, so no data flows until resume()
    child.stdout.pause()
    child.stdout.on("data", chunk => (stdout += chunk))
    setTimeout(() => child.stdout.resume(), delayMs)
    child.stderr.on("data", chunk => (stderr += chunk))
    child.on("error", reject)
    child.on("close", code => resolvePromise({code, stdout, stderr}))
  })
}

/** Run `fn` in a fresh temporary folder (its canonical path, so it compares with what child processes report) */
export async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "pcr-e2e-")))
  try {
    return await fn(dir)
  } finally {
    await removeDir(dir)
  }
}

/**
 * Remove a temporary folder. On Windows a folder stays busy (EBUSY, EPERM)
 * for a moment after the processes that used it exit, or while an antivirus
 * scans the files they wrote: removal is retried for a few seconds.
 */
export function removeDir(dir: string): Promise<void> {
  return rm(dir, {recursive: true, force: true, maxRetries: 10, retryDelay: 100})
}

/** A document conflicted as a whole: ours above, theirs below (and the base between them, diff3 style) */
export function conflictedDocument(ours: unknown, theirs: unknown, base?: unknown): string {
  const body = (value: unknown) => JSON.stringify(value, null, 2).split("\n").slice(1, -1)
  return [
    "{",
    "<<<<<<< HEAD",
    ...body(ours),
    ...(base !== undefined ? ["||||||| base", ...body(base)] : []),
    "=======",
    ...body(theirs),
    ">>>>>>> feature",
    "}",
    "",
  ].join("\n")
}

/** JSON lines printed on stdout, each parsed (throws on a line that is not JSON) */
export function jsonLines(stdout: string): any[] {
  return stdout
    .split("\n")
    .filter(line => line.trim() !== "")
    .map(line => JSON.parse(line))
}

/** Run git in a folder; the test fails when git does, unless `mayFail` (a merge that is expected to conflict) */
export async function git(dir: string, args: string[], mayFail = false): Promise<RunResult> {
  const result = await run("git", args, dir)
  if (!mayFail && result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${result.code}):\n${result.stdout}\n${result.stderr}`)
  }
  return result
}

/**
 * Run `fn` in a fresh Git repository, on branch main, with an identity to
 * commit with. `scratch` is the folder the repository is in, for files that
 * must stay out of it.
 */
export function withRepo<T>(fn: (dir: string, scratch: string) => Promise<T>): Promise<T> {
  return withTempDir(async scratch => {
    const dir = join(scratch, "repo")
    await mkdir(dir)
    await git(dir, ["init", "-b", "main"])
    await git(dir, ["config", "user.name", "Test"])
    await git(dir, ["config", "user.email", "test@example.com"])
    // Whatever the machine's own Git configuration prefers
    await git(dir, ["config", "merge.conflictStyle", "merge"])
    return fn(dir, scratch)
  })
}

/** Write files (path from `dir` → content), creating their folders, and commit everything */
export async function commitFiles(dir: string, files: Record<string, string>, message: string): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const file = join(dir, path)
    await mkdir(dirname(file), {recursive: true})
    await writeFile(file, content, "utf8")
  }
  await git(dir, ["add", "-A"])
  await git(dir, ["commit", "-m", message])
}

/** The package manager stubs are shell scripts, which Windows cannot run: pass as a test's `skip` option */
export const STUBS_NEED_POSIX = process.platform === "win32" ? "stubbed executables need a POSIX shell" : false

export interface PackageManagerStubs {
  /** Environment for runCli: the stubs come first on PATH, ahead of the real package managers */
  env: Record<string, string>
  /** What the stubs were run with so far, each as "<command>|<folder>|<arguments>" */
  invocations(): Promise<string[]>
}

/**
 * Put fake npm, pnpm, yarn and bun executables in `root`, to run the CLI's
 * lockfile regeneration without a network or a real install. They record how
 * they were called, and write the content of PCR_STUB_LOCK_CONTENT, when it
 * is set, to package-lock.json in the folder they run in.
 */
export async function stubPackageManagers(root: string): Promise<PackageManagerStubs> {
  const bin = join(root, "stub-bin")
  const log = join(root, "stub-invocations.log")
  await mkdir(bin)
  await writeFile(log, "", "utf8")

  const source = [
    "#!/bin/sh",
    'printf "%s|%s|%s\\n" "${0##*/}" "$PWD" "$*" >> "$PCR_STUB_LOG"',
    'if [ -n "$PCR_STUB_LOCK_CONTENT" ]; then',
    '  printf "%s" "$PCR_STUB_LOCK_CONTENT" > "$PWD/package-lock.json"',
    "fi",
    'exit "${PCR_STUB_EXIT:-0}"',
  ].join("\n")
  for (const command of ["npm", "pnpm", "yarn", "bun"]) {
    await writeFile(join(bin, command), source, "utf8")
    await chmod(join(bin, command), 0o755)
  }

  return {
    env: {PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`, PCR_STUB_LOG: log},
    async invocations() {
      return (await readFile(log, "utf8")).split("\n").filter(line => line.trim() !== "")
    },
  }
}
