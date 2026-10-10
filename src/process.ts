/**
 * Child process helpers shared by the CLI and the registry lookup.
 */

import {spawn, ChildProcess, SpawnOptions} from "node:child_process"

/** Package manager CLIs that are installed as .cmd shims on Windows */
const WINDOWS_SHIMS = ["npm", "npx", "yarn", "pnpm", "bun"]

/** How long a command that was killed gets to exit before its run is given up on anyway */
const KILL_GRACE_MS = 5000

/**
 * Whether a command must run through a shell. On Windows, package manager
 * CLIs are .cmd shims that cannot be spawned directly (plain spawn fails with
 * EINVAL on Node 20+): they run through cmd.exe, with the command line that
 * shellCommandLine() quotes.
 */
export function needsShell(command: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32" && WINDOWS_SHIMS.includes(command)
}

/**
 * A command line for cmd.exe running a .cmd shim, which reads its arguments
 * a second time. Plain arguments go as they are, any other between double
 * quotes, which keep spaces and the characters cmd.exe interprets (& | < > ^
 * and parentheses) literal through both reads. Double quotes, percent signs,
 * exclamation marks and line breaks cannot be carried safely: an argument with
 * one is refused.
 */
export function shellCommandLine(command: string, args: readonly string[]): string {
  return [command, ...args.map(quoteForCmd)].join(" ")
}

function quoteForCmd(arg: string): string {
  if (/["%!\r\n]/.test(arg)) {
    throw new Error(`${JSON.stringify(arg)} cannot be passed to a command through the Windows shell`)
  }
  if (/^[\w@+=:./~-]+$/.test(arg)) {
    return arg
  }
  // Backslashes right before the closing quote would escape it: double them
  return `"${arg.replace(/(\\+)$/, "$1$1")}"`
}

/**
 * Spawn a command cross-platform (see needsShell). Given a shell and an array
 * of arguments, Node would only join them with spaces, and warns about it
 * (DEP0190): they are quoted into the command line here instead.
 */
export function spawnCommand(command: string, args: string[], options: SpawnOptions = {}): ChildProcess {
  return needsShell(command)
    ? spawn(shellCommandLine(command, args), {...options, shell: true})
    : spawn(command, args, options)
}

export interface CommandOutput {
  /** Exit code, or null when the process was ended by a signal */
  code: number | null
  stdout: string
  stderr: string
}

export interface RunCommandOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  /** Kill the command and reject when it runs longer than this */
  timeoutMs?: number
}

/**
 * Run a command to completion and capture its output. Rejects when the
 * command cannot be started, or does not finish within `timeoutMs`: it is
 * then stopped with everything it started, and the promise rejects once it
 * has exited. A non-zero exit code is not an error here, callers inspect
 * `code`.
 */
export function runCommand(command: string, args: string[], options: RunCommandOptions = {}): Promise<CommandOutput> {
  return new Promise((resolve, reject) => {
    const child = spawnCommand(command, args, {cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"]})
    let stdout = ""
    let stderr = ""
    let settled = false
    let timedOut: Error | undefined
    const timers: NodeJS.Timeout[] = []

    const settle = (finish: () => void) => {
      if (settled) return
      settled = true
      timers.forEach(clearTimeout)
      finish()
    }

    if (options.timeoutMs !== undefined) {
      const timeoutMs = options.timeoutMs
      timers.push(
        setTimeout(() => {
          const error = new Error(`timed out after ${timeoutMs / 1000}s`)
          timedOut = error
          killTree(child, needsShell(command))
          // Should it not exit, end it for good, and give up on it
          timers.push(
            setTimeout(() => {
              child.kill("SIGKILL")
              settle(() => reject(error))
            }, KILL_GRACE_MS)
          )
        }, timeoutMs)
      )
    }

    child.stdout!.on("data", chunk => (stdout += chunk))
    child.stderr!.on("data", chunk => (stderr += chunk))
    child.on("error", error => settle(() => reject(error)))
    child.on("close", code =>
      settle(() => (timedOut !== undefined ? reject(timedOut) : resolve({code, stdout, stderr})))
    )
  })
}

/**
 * Stop a command and everything it started. Through cmd.exe, the child is
 * cmd.exe itself: killing it alone would leave the package manager it started
 * running in the background, so taskkill stops the whole tree.
 */
function killTree(child: ChildProcess, viaShell: boolean): void {
  if (viaShell && process.platform === "win32" && child.pid !== undefined) {
    const taskkill = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {stdio: "ignore", windowsHide: true})
    taskkill.on("error", () => child.kill())
    return
  }
  child.kill()
}
