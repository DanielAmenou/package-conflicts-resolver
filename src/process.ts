/**
 * Child process helpers shared by the CLI and the registry lookup.
 */

import {spawn, SpawnOptions} from "node:child_process"

/** Package manager CLIs that are installed as .cmd shims on Windows */
const WINDOWS_SHIMS = ["npm", "npx", "yarn", "pnpm", "bun"]

/**
 * Whether a command must run through a shell. On Windows, package manager
 * CLIs are .cmd shims that cannot be spawned directly (plain spawn fails with
 * EINVAL on Node 20+). Arguments are not quoted for the shell, so callers
 * only pass arguments without shell metacharacters.
 */
export function needsShell(command: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32" && WINDOWS_SHIMS.includes(command)
}

/**
 * Spawn a command cross-platform (see needsShell).
 */
export function spawnCommand(command: string, args: string[], options: SpawnOptions = {}) {
  return spawn(command, args, {...options, shell: needsShell(command)})
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
 * command cannot be started or does not finish within `timeoutMs`; a non-zero
 * exit code is not an error here, callers inspect `code`.
 */
export function runCommand(command: string, args: string[], options: RunCommandOptions = {}): Promise<CommandOutput> {
  return new Promise((resolve, reject) => {
    const child = spawnCommand(command, args, {cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"]})
    let stdout = ""
    let stderr = ""
    let settled = false
    let timer: NodeJS.Timeout | undefined

    const settle = (finish: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      finish()
    }

    if (options.timeoutMs !== undefined) {
      const timeoutMs = options.timeoutMs
      timer = setTimeout(() => {
        settle(() => reject(new Error(`timed out after ${timeoutMs / 1000}s`)))
        child.kill()
      }, timeoutMs)
    }

    child.stdout!.on("data", chunk => (stdout += chunk))
    child.stderr!.on("data", chunk => (stderr += chunk))
    child.on("error", error => settle(() => reject(error)))
    child.on("close", code => settle(() => resolve({code, stdout, stderr})))
  })
}
