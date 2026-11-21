/**
 * What the CLI asks Git about the repository a file is in.
 *
 * Every question has "nothing" for an answer when Git is not installed, the
 * folder is not in a work tree, or Git fails: the CLI then works from the
 * files alone, as it does outside a repository.
 */

import {spawn} from "node:child_process"
import {basename, dirname, resolve} from "node:path"
import {MergeVersions} from "./types.js"

/** Index stages of a conflicted file: the common ancestor's version, ours and theirs */
const STAGE_BASE = 1
const STAGE_OURS = 2
const STAGE_THEIRS = 3

/** File modes of a regular file: a symlink or a submodule has no content to merge */
const REGULAR_FILE_MODES = new Set(["100644", "100755"])

/** An entry of a file that is unmerged in the index */
interface UnmergedEntry {
  mode: string
  object: string
  stage: number
  /** Path from the folder Git was asked in, with forward slashes */
  path: string
}

/**
 * Run Git and collect its output, undefined when Git cannot be started or
 * fails: exits with a code `succeeded` does not accept. The output is kept as
 * bytes until it is complete: decoding it chunk by chunk would break a
 * character that falls on the boundary of two chunks.
 */
function git(
  args: string[],
  cwd: string,
  succeeded: (code: number | null) => boolean = code => code === 0
): Promise<Buffer | undefined> {
  return new Promise(resolvePromise => {
    const child = spawn("git", args, {cwd, stdio: ["ignore", "pipe", "ignore"], windowsHide: true})
    const chunks: Buffer[] = []
    child.stdout.on("data", chunk => chunks.push(chunk))
    child.on("error", () => resolvePromise(undefined))
    child.on("close", code => resolvePromise(succeeded(code) ? Buffer.concat(chunks) : undefined))
  })
}

/**
 * The top folder of the work tree `dir` is in, as a path that `dir` starts
 * with. Undefined outside a work tree, and when `dir` is reached through a
 * symbolic link into the work tree: its parents are then not the folders Git
 * goes up through.
 */
export async function findRepoRoot(dir: string): Promise<string | undefined> {
  const up = await wayUp(dir)
  if (up === undefined) {
    return undefined
  }
  const top = resolve(dir, up)
  return up === "" || (await wayUp(top)) === "" ? top : undefined
}

/** The relative way from a folder to the top of its work tree: "../../", or "" at the top itself */
async function wayUp(dir: string): Promise<string | undefined> {
  const output = await git(["rev-parse", "--is-inside-work-tree", "--show-cdup"], dir)
  if (output === undefined) {
    return undefined
  }
  const [inside, up = ""] = output.toString("utf8").split(/\r?\n/)
  return inside === "true" ? up : undefined
}

/** The unmerged entries of the index under `pathspec`, taken literally, as seen from `cwd` */
async function unmergedEntries(cwd: string, pathspec: string): Promise<UnmergedEntry[]> {
  const output = await git(["--literal-pathspecs", "ls-files", "--unmerged", "-z", "--", pathspec], cwd)
  if (output === undefined) {
    return []
  }

  const entries: UnmergedEntry[] = []
  for (const record of output.toString("utf8").split("\0")) {
    // <mode> <object> <stage>\t<path>
    const match = /^(\d+) ([0-9a-f]+) (\d)\t(.+)$/s.exec(record)
    if (match !== null) {
      entries.push({
        mode: match[1] as string,
        object: match[2] as string,
        stage: Number(match[3]),
        path: match[4] as string,
      })
    }
  }
  return entries
}

/**
 * The files Git lists as unmerged in `dir` and below: their paths from `dir`,
 * with forward slashes, each with the stages the index has for it. A file
 * both branches have has stages 2 (ours) and 3 (theirs); one that a branch
 * deleted lacks that branch's stage.
 */
export async function listUnmerged(dir: string): Promise<Map<string, Set<number>>> {
  const unmerged = new Map<string, Set<number>>()
  for (const entry of await unmergedEntries(dir, ".")) {
    unmerged.set(entry.path, (unmerged.get(entry.path) ?? new Set()).add(entry.stage))
  }
  return unmerged
}

/** Whether the stages of an unmerged file say both branches have it (see listUnmerged) */
export function onBothBranches(stages: Set<number> | undefined): boolean {
  return stages !== undefined && stages.has(STAGE_OURS) && stages.has(STAGE_THEIRS)
}

/** The index entries of a conflicted file, by stage, and the folder to ask Git about them in */
interface MergeEntries {
  dir: string
  ours: UnmergedEntry
  theirs: UnmergedEntry
  /** None when both branches added the file */
  base?: UnmergedEntry
}

/**
 * The index entries of a conflicted file. Undefined when the file is not
 * unmerged there, when a branch has no version of it (it deleted the file,
 * which leaves nothing to merge value by value), or when a version is not a
 * regular file.
 */
async function mergeEntries(filePath: string): Promise<MergeEntries | undefined> {
  const path = resolve(filePath)
  const dir = dirname(path)
  const name = basename(path)

  const entries = (await unmergedEntries(dir, name)).filter(entry => entry.path === name)
  const ours = entries.find(entry => entry.stage === STAGE_OURS)
  const theirs = entries.find(entry => entry.stage === STAGE_THEIRS)
  const base = entries.find(entry => entry.stage === STAGE_BASE)
  if (ours === undefined || theirs === undefined || !entries.every(entry => REGULAR_FILE_MODES.has(entry.mode))) {
    return undefined
  }
  return {dir, ours, theirs, ...(base !== undefined ? {base} : {})}
}

/** The versions of a conflicted file in Git's index: undefined when there are none to merge (see mergeEntries) */
export async function readMergeVersions(filePath: string): Promise<MergeVersions | undefined> {
  const entries = await mergeEntries(filePath)
  if (entries === undefined) {
    return undefined
  }

  const {dir, ours, theirs, base} = entries
  const read = async (entry: UnmergedEntry) => (await git(["cat-file", "blob", entry.object], dir))?.toString("utf8")
  const [ourText, theirText, baseText] = await Promise.all([
    read(ours),
    read(theirs),
    base !== undefined ? read(base) : undefined,
  ])
  if (ourText === undefined || theirText === undefined || (base !== undefined && baseText === undefined)) {
    return undefined
  }
  return {ours: ourText, theirs: theirText, ...(baseText !== undefined ? {base: baseText} : {})}
}

/**
 * Whether the content of a conflicted file is exactly what Git's merge of
 * its versions in the index writes, apart from line endings: `git merge-file`
 * merges them again, with the labels and the conflict style the file shows,
 * and the histogram diff Git's merges use.
 *
 * That recognizes the file even where Git's merge, which works line by line,
 * stitched together lines of different values, as it does in lockfiles, whose
 * entries look alike: reading the values, such a file cannot be told from one
 * edited by hand.
 *
 * False whenever it cannot be checked: without a common ancestor (both
 * branches added the file), or with a Git whose `merge-file` lacks the
 * options this needs.
 */
export async function isGitMergeOutput(filePath: string, content: string): Promise<boolean> {
  const text = content.replace(/\r\n/g, "\n")
  const ourLabel = /^<{7} (.*)$/m.exec(text)?.[1]
  const theirLabel = /^>{7} (.*)$/m.exec(text)?.[1]
  const baseLabel = /^\|{7} (.*)$/m.exec(text)?.[1]
  if (ourLabel === undefined || theirLabel === undefined) {
    return false
  }

  const entries = await mergeEntries(filePath)
  if (entries?.base === undefined) {
    return false
  }
  const {dir, ours, theirs, base} = entries

  // The style the file shows: conflicts with the common ancestor's lines are diff3 or zdiff3
  const styles =
    baseLabel === undefined
      ? [{config: ["-c", "merge.conflictStyle=merge"], flags: []}]
      : [
          {config: [], flags: ["--diff3"]},
          {config: [], flags: ["--zdiff3"]},
        ]
  for (const {config, flags} of styles) {
    const args = [
      ...config,
      "merge-file",
      "--stdout",
      "--object-id",
      "--diff-algorithm=histogram",
      ...flags,
      ...["-L", ourLabel, "-L", baseLabel ?? "base", "-L", theirLabel],
      ...[ours.object, base.object, theirs.object],
    ]
    // It exits with the number of conflicts, up to 127, and with more on an error
    const merged = await git(args, dir, code => code !== null && code >= 0 && code <= 127)
    if (merged !== undefined && merged.toString("utf8").replace(/\r\n/g, "\n") === text) {
      return true
    }
  }
  return false
}
