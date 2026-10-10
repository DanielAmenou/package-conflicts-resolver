/**
 * Helpers for tests that run the built CLI (and git) in temporary folders.
 */

import {spawn} from "node:child_process"
import {mkdtemp, realpath, rm} from "fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"

export const CLI_PATH = join(__dirname, "..", "cli.js")

export interface RunResult {
  code: number | null
  stdout: string
  stderr: string
}

/** Run a command to completion; `shell` is for Windows .cmd shims such as npm.cmd (arguments are not quoted) */
export function run(
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
  shell = false
): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {cwd, env: {...process.env, ...env}, stdio: ["ignore", "pipe", "pipe"], shell})
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", chunk => (stdout += chunk))
    child.stderr.on("data", chunk => (stderr += chunk))
    child.on("error", reject)
    child.on("close", code => resolvePromise({code, stdout, stderr}))
  })
}

export function runCli(args: string[], cwd: string, env: Record<string, string> = {}): Promise<RunResult> {
  return run(process.execPath, [CLI_PATH, ...args], cwd, env)
}

/** Run `fn` in a fresh temporary folder (its canonical path, so it compares with what child processes report) */
export async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "pcr-e2e-")))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, {recursive: true, force: true})
  }
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
