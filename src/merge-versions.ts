/**
 * Whether a conflicted file can be resolved from the versions in Git's index
 * instead of from its conflict markers.
 *
 * The index versions make a better merge: with them the common ancestor is
 * known for every value, while default conflict markers do not carry it at
 * all. But they are the file as each branch committed it, and the working
 * file may have moved on since Git wrote it: a conflict resolved by hand, a
 * value edited, or an earlier run of this tool that decided some values and
 * left the rest between markers. Merging the index versions again would
 * silently undo all of that.
 *
 * So the working file is checked first. Git writes every value of a
 * conflicted file in one of two ways: inside a conflict, where each side shows
 * its own branch's value, or outside of one, where the value is the only
 * branch's that changed it. A file that still reads that way holds no
 * decision the index versions do not lead to as well. Any other value was put
 * there by someone, and only the markers tell what is left to resolve.
 */

import {isDeepStrictEqual} from "node:util"
import {ConflictParser} from "./conflict-parser.js"
import {parseJsonLenient} from "./json-repair.js"
import {MergeVersions} from "./types.js"

/**
 * How a conflicted file compares with the versions in Git's index:
 * - "follows": every value of the file is one Git's merge of the versions
 *   leaves there, on both sides of its conflicts;
 * - "changed": the file has a value that Git's merge does not leave there;
 * - "unreadable": the sides of the file, or a version, cannot be read as JSON
 *   objects, so there is nothing to compare.
 */
export type VersionsCheck = "follows" | "changed" | "unreadable"

export function compareWithVersions(content: string, versions: MergeVersions): VersionsCheck {
  const documents = readDocuments(content, versions)
  if (documents === undefined) {
    return "unreadable"
  }

  const {shownOurs, shownTheirs, shownBase, ours, theirs, base} = documents
  const follows =
    explains(shownOurs, ours, theirs, base) &&
    explains(shownTheirs, theirs, ours, base) &&
    // diff3 and zdiff3 conflicts also show the common ancestor, which a later merge from the markers would go by
    (shownBase === undefined || showsAncestor(shownBase, base, shownOurs, shownTheirs))
  return follows ? "follows" : "changed"
}

/** Whether a conflicted file can be resolved from the versions in Git's index: it follows them (see VersionsCheck) */
export function followsVersions(content: string, versions: MergeVersions): boolean {
  return compareWithVersions(content, versions) === "follows"
}

/**
 * The documents to compare: what each side of the file shows (and its
 * ancestor sections, when it has some), and the versions. Undefined when one
 * of them cannot be read as a JSON object.
 */
function readDocuments(content: string, versions: MergeVersions) {
  try {
    const shownOurs = parseJsonLenient(ConflictParser.extractConflictSide(content, "ours"))
    const shownTheirs = parseJsonLenient(ConflictParser.extractConflictSide(content, "theirs"))
    const shownBase = ConflictParser.hasBaseSections(content)
      ? parseJsonLenient(ConflictParser.extractConflictSide(content, "base"))
      : undefined
    const ours = JSON.parse(stripBom(versions.ours))
    const theirs = JSON.parse(stripBom(versions.theirs))
    const base =
      versions.base !== undefined && versions.base.trim() !== "" ? JSON.parse(stripBom(versions.base)) : undefined

    const objects =
      [shownOurs, shownTheirs, ours, theirs].every(isPlainObject) && (base === undefined || isPlainObject(base))
    return objects ? {shownOurs, shownTheirs, shownBase, ours, theirs, base} : undefined
  } catch {
    return undefined
  }
}

/**
 * Whether the value a side of the file shows is one Git's merge leaves on
 * that side: the side's own (`own`), or the other branch's when the side's
 * own branch did not change it. Where both branches have an object, Git may
 * have merged their lines into it: it is checked value by value. So is a list
 * of plain values, item by item.
 */
function explains(shown: unknown, own: unknown, other: unknown, base: unknown): boolean {
  if (isDeepStrictEqual(shown, own)) {
    return true
  }
  if (isDeepStrictEqual(own, base) && isDeepStrictEqual(shown, other)) {
    return true
  }

  if (isPlainObject(shown) && isPlainObject(own) && isPlainObject(other)) {
    const keys = new Set([shown, own, other, base].flatMap(value => (isPlainObject(value) ? Object.keys(value) : [])))
    return [...keys].every(key =>
      explains(valueAt(shown, key), valueAt(own, key), valueAt(other, key), valueAt(base, key))
    )
  }

  if (isPlainList(shown) && isPlainList(own) && isPlainList(other)) {
    const inShown = new Set(shown)
    const inOwn = new Set(own)
    const inOther = new Set(other)
    const inBase = new Set(isPlainList(base) ? base : [])
    // An item is in the list or not, like a value: as on the side's own branch, or as on the other one
    return [...inShown, ...inOwn, ...inOther, ...inBase].every(
      item =>
        inShown.has(item) === inOwn.has(item) ||
        (inOwn.has(item) === inBase.has(item) && inShown.has(item) === inOther.has(item))
    )
  }

  return false
}

/**
 * Whether the value the ancestor sections of the file show is one Git leaves
 * there: the common ancestor's inside a conflict, and outside of one the
 * merged value, which both sides show as well.
 */
function showsAncestor(shown: unknown, base: unknown, shownOurs: unknown, shownTheirs: unknown): boolean {
  if (isDeepStrictEqual(shown, base)) {
    return true
  }
  if (isDeepStrictEqual(shown, shownOurs) && isDeepStrictEqual(shown, shownTheirs)) {
    return true
  }

  if (isPlainObject(shown)) {
    const keys = new Set(
      [shown, base, shownOurs, shownTheirs].flatMap(value => (isPlainObject(value) ? Object.keys(value) : []))
    )
    return [...keys].every(key =>
      showsAncestor(valueAt(shown, key), valueAt(base, key), valueAt(shownOurs, key), valueAt(shownTheirs, key))
    )
  }

  if (isPlainList(shown)) {
    const [inShown, inBase, inOurs, inTheirs] = [shown, base, shownOurs, shownTheirs].map(
      value => new Set(isPlainList(value) ? value : [])
    ) as [Set<unknown>, Set<unknown>, Set<unknown>, Set<unknown>]
    return [...inShown, ...inBase, ...inOurs, ...inTheirs].every(
      item =>
        inShown.has(item) === inBase.has(item) ||
        (inShown.has(item) === inOurs.has(item) && inShown.has(item) === inTheirs.has(item))
    )
  }

  return false
}

/** The value of an object's own key: undefined for anything but an object, and for inherited names such as "constructor" */
function valueAt(value: unknown, key: string): unknown {
  return isPlainObject(value) && Object.hasOwn(value, key) ? value[key] : undefined
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** A list of strings, numbers, booleans and nulls */
function isPlainList(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.every(item => item === null || typeof item !== "object")
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}
