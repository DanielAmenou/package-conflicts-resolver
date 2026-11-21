/**
 * Where the lockfiles of a package.json are: next to it, or at the root of
 * the workspace it is a member of. In a monorepo the packages have no
 * lockfile of their own: one lockfile at the root locks them all.
 */

import {readFile} from "fs/promises"
import {dirname, join, relative, sep} from "node:path"
import {ConflictParser} from "./conflict-parser.js"
import {findRepoRoot} from "./git.js"
import {parseJsonLenient} from "./json-repair.js"
import {findLockfiles} from "./package-manager.js"

/**
 * The folder whose lockfiles lock the dependencies of the package.json in
 * `dir`: `dir` itself when it has a lockfile, otherwise the nearest folder
 * above it that has one and lists `dir` among its workspaces.
 *
 * The search stays inside the Git repository, and stops at the first folder
 * with a lockfile: when that one is not the workspace root of `dir`, it is
 * another project's, and `dir` is on its own.
 */
export async function findLockfileDir(dir: string): Promise<string> {
  if ((await findLockfiles(dir)).length > 0) {
    return dir
  }
  const repoRoot = await findRepoRoot(dir)
  if (repoRoot === undefined) {
    return dir
  }

  // The repository root is a path `dir` starts with: the folders in between are its parents
  for (let current = dir; current !== repoRoot && dirname(current) !== current; ) {
    current = dirname(current)
    if ((await findLockfiles(current)).length > 0) {
      return (await isWorkspaceMember(current, dir)) ? current : dir
    }
  }
  return dir
}

/** Whether the workspaces `root` declares include the folder `dir` below it */
async function isWorkspaceMember(root: string, dir: string): Promise<boolean> {
  const member = relative(root, dir).split(sep).join("/")
  return matchesWorkspace(await workspacePatterns(root), member)
}

/**
 * The workspace patterns a folder declares: the "workspaces" of its
 * package.json (npm, yarn and bun; a list, or an object with "packages") and
 * the "packages" of its pnpm-workspace.yaml. While either file is conflicted,
 * the patterns of both branches count.
 */
export async function workspacePatterns(root: string): Promise<string[]> {
  const patterns: string[] = []

  const manifest = await readText(join(root, "package.json"))
  if (manifest !== undefined) {
    const sides = ConflictParser.hasConflicts(manifest)
      ? (["ours", "theirs"] as const).map(side => ConflictParser.extractConflictSide(manifest, side))
      : [manifest]
    for (const side of sides) {
      patterns.push(...manifestWorkspaces(side))
    }
  }

  const pnpmWorkspace = await readText(join(root, "pnpm-workspace.yaml"))
  if (pnpmWorkspace !== undefined) {
    patterns.push(...pnpmWorkspacePackages(pnpmWorkspace))
  }

  return patterns
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8")
  } catch {
    return undefined
  }
}

/** The "workspaces" patterns of a package.json: none when it cannot be read as JSON */
function manifestWorkspaces(text: string): string[] {
  let workspaces: unknown
  try {
    workspaces = parseJsonLenient(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)?.workspaces
  } catch {
    return []
  }
  const list = Array.isArray(workspaces)
    ? workspaces
    : (workspaces as {packages?: unknown} | null | undefined)?.packages
  return Array.isArray(list) ? list.filter((pattern): pattern is string => typeof pattern === "string") : []
}

/**
 * The items of the "packages" list of a pnpm-workspace.yaml, written as a
 * block (one "- pattern" per line) or inline ("[a, b]"). Lines of conflict
 * markers are no items, so a conflicted file gives the patterns of both
 * branches.
 */
export function pnpmWorkspacePackages(text: string): string[] {
  const patterns: string[] = []
  let inPackages = false

  for (const line of text.split(/\r?\n/)) {
    const key = /^packages\s*:(.*)$/.exec(line)
    if (key !== null) {
      inPackages = true
      const inline = /^\s*\[(.*)\]/.exec(key[1] as string)
      if (inline !== null) {
        patterns.push(...(inline[1] as string).split(",").map(yamlText))
      }
      continue
    }
    const item = /^\s*-\s+(.*)$/.exec(line)
    if (inPackages && item !== null) {
      patterns.push(yamlText(item[1] as string))
    } else if (/^[^\s#<=>|]/.test(line)) {
      inPackages = false // another top-level key
    }
  }

  return patterns.filter(pattern => pattern !== "")
}

/** A YAML string as its text: what is between its quotes, or a plain one without the comment after it */
function yamlText(scalar: string): string {
  const quoted = /^\s*(["'])(.*?)\1/.exec(scalar)
  return quoted !== null ? (quoted[2] as string) : scalar.replace(/\s+#.*$/, "").trim()
}

/**
 * Whether a folder (its path from the workspace root, with forward slashes)
 * is among the workspaces a list of patterns describes: some pattern includes
 * it, and no "!pattern" excludes it. Nothing inside node_modules is a
 * workspace.
 */
export function matchesWorkspace(patterns: string[], member: string): boolean {
  if (member === "" || member.split("/").includes("node_modules")) {
    return false
  }
  const matches = (pattern: string) => globToRegExp(normalizePattern(pattern))?.test(member) ?? false
  const excluded = patterns.filter(pattern => pattern.startsWith("!")).map(pattern => pattern.slice(1))
  const included = patterns.filter(pattern => !pattern.startsWith("!"))
  return included.some(matches) && !excluded.some(matches)
}

// A leading "./", a trailing slash and Windows separators do not change which folders a pattern names
function normalizePattern(pattern: string): string {
  return pattern
    .trim()
    .replace(/\\/g, "/")
    .replace(/^(?:\.\/)+/, "")
    .replace(/\/+$/, "")
}

/**
 * A workspace pattern as a regular expression over a whole path: `*` and `?`
 * stay within a folder name, `**` spans any number of folders, and `{a,b}`
 * is either of its parts. Any other character stands for itself, so that a
 * pattern using syntax beyond this matches nothing rather than too much.
 * Undefined for a pattern with unbalanced braces.
 */
function globToRegExp(pattern: string): RegExp | undefined {
  let source = ""
  let depth = 0

  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i] as string
    if (char === "*" && pattern[i + 1] === "*") {
      // "**/" also stands for no folder at all: "packages/**/x" includes "packages/x"
      const wholeSegment = (i === 0 || pattern[i - 1] === "/") && (i + 2 === pattern.length || pattern[i + 2] === "/")
      if (wholeSegment && pattern[i + 2] === "/") {
        source += "(?:[^/]+/)*"
        i += 2
      } else {
        source += wholeSegment ? ".*" : "[^/]*"
        i += 1
      }
    } else if (char === "*") {
      source += "[^/]*"
    } else if (char === "?") {
      source += "[^/]"
    } else if (char === "{") {
      source += "(?:"
      depth++
    } else if (char === "}" && depth > 0) {
      source += ")"
      depth--
    } else if (char === "," && depth > 0) {
      source += "|"
    } else {
      source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    }
  }

  return depth === 0 ? new RegExp(`^${source}$`) : undefined
}
