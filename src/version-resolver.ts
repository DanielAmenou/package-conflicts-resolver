/**
 * Version resolution strategies using semver
 */

import {compare, minVersion, prerelease, valid, validRange, type SemVer} from "semver"
import {ResolutionStrategy} from "./types.js"
import {classifyVersionSpec} from "./version-picks.js"

/** How a conflict between two version specs was resolved */
export interface VersionResolution {
  /** One of the two specs, verbatim */
  resolved: string
  /** Why that one */
  reason: string
  /**
   * Whether the strategy could decide. False when highest or lowest finds no
   * order between the specs, because they point at different things or at
   * something that has no version: a git URL and a range, two dist-tags, two
   * tarballs, a file: path... `resolved` is then just our spec, kept by
   * default. Always true for ours and theirs.
   */
  comparable: boolean
}

/** The side a comparison chose, and why */
interface Order {
  winner: "ours" | "theirs"
  reason: string
}

/** What a spec selects a version of, and the part of it semver can order */
interface VersionTarget {
  /** "" for a registry version of the package itself, "npm:<name>" for an alias, "git:<repository>"... */
  target: string
  /** The version or range: the whole spec, or what follows the target */
  spec: string
}

/** npm:<name>@<version or range> */
const ALIAS = /^npm:((?:@[^@/\s]+\/)?[^@/\s]+)@(\S.*)$/
/** corepack's "packageManager" field: <name>@<version> */
const PACKAGE_MANAGER = /^((?:@[^@/\s]+\/)?[^@/\s]+)@(\S+)$/

export class VersionResolver {
  /**
   * Resolve version conflict using the specified strategy.
   * Never throws: specs that highest and lowest cannot order (git URLs, file:,
   * dist-tags, aliases of different packages...) keep our version, with
   * `comparable` false.
   */
  static resolveVersion(
    ourVersion: string,
    theirVersion: string,
    strategy: ResolutionStrategy["name"]
  ): VersionResolution {
    try {
      switch (strategy) {
        case "ours":
          return {resolved: ourVersion, reason: "using our version (ours strategy)", comparable: true}
        case "theirs":
          return {resolved: theirVersion, reason: "using their version (theirs strategy)", comparable: true}
        case "lowest":
          return this.resolveOrdered(ourVersion, theirVersion, "lowest")
        case "highest":
        default:
          return this.resolveOrdered(ourVersion, theirVersion, "highest")
      }
    } catch {
      return {resolved: ourVersion, reason: "version comparison failed, keeping our version", comparable: false}
    }
  }

  /**
   * Resolve with highest or lowest: order the parts of the two specs that
   * semver understands, and return the winning spec verbatim.
   */
  private static resolveOrdered(
    ourVersion: string,
    theirVersion: string,
    strategy: "highest" | "lowest"
  ): VersionResolution {
    // Only identical raw specs short-circuit: "^1.2.3" and "~1.2.3" share a
    // base version but are different ranges and must go through resolution
    if (ourVersion.trim() === theirVersion.trim()) {
      return {resolved: ourVersion, reason: "versions are identical", comparable: true}
    }

    const specs = this.comparableSpecs(ourVersion, theirVersion)
    const order =
      specs === null ? null : strategy === "highest" ? this.orderHighest(...specs) : this.orderLowest(...specs)
    if (order === null) {
      return {
        resolved: ourVersion,
        reason: `versions are not comparable ("${ourVersion}" vs "${theirVersion}"), keeping our version`,
        comparable: false,
      }
    }
    return {resolved: order.winner === "ours" ? ourVersion : theirVersion, reason: order.reason, comparable: true}
  }

  /**
   * The parts of two specs that semver can order, when both select a version
   * of the same thing: the specs themselves for registry versions and ranges,
   * or what follows what they point at, for npm: aliases of the same package,
   * workspace: specs, git specs of the same repository (a tag that is a
   * version, or a semver: range) and corepack specs of the same package
   * manager. Null when they point at different things, or one of them at
   * something that has no version: a file, a tarball, a dist-tag, a branch.
   * Never are digits picked out of a spec to compare it: a commit hash or a
   * tarball name is no version.
   */
  private static comparableSpecs(ourVersion: string, theirVersion: string): [string, string] | null {
    const ours = this.versionTarget(ourVersion)
    const theirs = this.versionTarget(theirVersion)
    return ours !== null && theirs !== null && ours.target === theirs.target ? [ours.spec, theirs.spec] : null
  }

  private static versionTarget(spec: string): VersionTarget | null {
    const text = spec.trim()

    const alias = ALIAS.exec(text)
    if (alias !== null) {
      return {target: `npm:${alias[1]}`, spec: alias[2] as string}
    }
    if (text.startsWith("workspace:")) {
      const range = text.slice("workspace:".length)
      return range !== "" ? {target: "workspace:", spec: range} : null
    }

    const type = classifyVersionSpec(text)?.type
    if (type === "git") {
      const hash = text.indexOf("#")
      const ref = hash === -1 ? "" : text.slice(hash + 1).replace(/^semver:/, "")
      return ref !== "" ? {target: `git:${text.slice(0, hash)}`, spec: ref} : null
    }
    if (type === "version" || type === "range") {
      return {target: "", spec: text}
    }
    if (type !== undefined) {
      // A file, a tarball URL, a dist-tag, an alias without a version, another protocol
      return null
    }

    const manager = PACKAGE_MANAGER.exec(text)
    if (manager !== null) {
      return {target: `manager:${manager[1]}`, spec: manager[2] as string}
    }
    // Not a spec npm reads: semver may still make sense of it, loosely
    return {target: "", spec: text}
  }

  /**
   * Order two specs for the highest strategy, or null when semver cannot.
   */
  private static orderHighest(ours: string, theirs: string): Order | null {
    const ourClean = this.cleanVersion(ours)
    const theirClean = this.cleanVersion(theirs)

    // 1. Direct semver comparison, only when both specs are exact versions —
    // comparing cleaned ranges here would erase range semantics ("^" vs "~")
    if (valid(ours.trim()) && valid(theirs.trim())) {
      const comparison = this.compareForHighest(ourClean, theirClean)
      if (comparison > 0) {
        return {winner: "ours", reason: this.describeHigher(ourClean, theirClean, "our", "their")}
      } else if (comparison < 0) {
        return {winner: "theirs", reason: this.describeHigher(theirClean, ourClean, "their", "our")}
      }
      return {winner: "ours", reason: "versions are identical"}
    }

    // 2. Compare as semver ranges (handles "*", "1.x", ">=1.0.0 <2.0.0", "1.2.3 - 2.0.0", ...)
    // by their minimum satisfying versions, with the same stable-over-pre-release
    // rule as exact versions so a package.json range and the exact version locked
    // for it in package-lock.json always resolve to the same side.
    const minimums = this.rangeMinimums(ours, theirs)
    if (minimums !== null) {
      const rangeComparison = this.compareForHighest(minimums.ours, minimums.theirs)
      if (rangeComparison > 0) {
        return {winner: "ours", reason: `our range ${ours} allows a higher minimum than ${theirs}`}
      } else if (rangeComparison < 0) {
        return {winner: "theirs", reason: `their range ${theirs} allows a higher minimum than ${ours}`}
      }
      // Ranges have equal minimums, prefer the one with more specific range
      return this.preferMoreSpecific(ours, theirs)
    }

    // 3. No version semver can read (a dist-tag, "1.2.3.4", an unsatisfiable range): no order
    return null
  }

  /**
   * Order two specs for the lowest strategy, or null when semver cannot.
   */
  private static orderLowest(ours: string, theirs: string): Order | null {
    const ourClean = this.cleanVersion(ours)
    const theirClean = this.cleanVersion(theirs)

    // 1. Direct semver comparison, only when both specs are exact versions —
    // comparing cleaned ranges here would erase range semantics ("^" vs "~")
    if (valid(ours.trim()) && valid(theirs.trim())) {
      const comparison = compare(ourClean, theirClean)
      if (comparison < 0) {
        return {winner: "ours", reason: `our version ${ourClean} is lower than ${theirClean}`}
      } else if (comparison > 0) {
        return {winner: "theirs", reason: `their version ${theirClean} is lower than ${ourClean}`}
      }
      return {winner: "ours", reason: "versions are identical"}
    }

    // 2. Compare as semver ranges
    const minimums = this.rangeMinimums(ours, theirs)
    if (minimums !== null) {
      const rangeComparison = compare(minimums.ours, minimums.theirs)
      if (rangeComparison < 0) {
        return {winner: "ours", reason: `our range ${ours} allows a lower minimum than ${theirs}`}
      } else if (rangeComparison > 0) {
        return {winner: "theirs", reason: `their range ${theirs} allows a lower minimum than ${ours}`}
      }
      // Ranges have equal minimums, prefer the one with more restrictive range
      return this.preferMoreRestrictive(ours, theirs)
    }

    // 3. No version semver can read: no order
    return null
  }

  /**
   * Order two exact versions for the "highest" strategy: a stable release beats
   * a pre-release even when the pre-release has a higher base version
   * (2.68.6 beats 2.68.4-beta.3); otherwise semver precedence decides.
   * Returns > 0 when `a` wins, < 0 when `b` wins, 0 when they are equal.
   */
  private static compareForHighest(a: string | SemVer, b: string | SemVer): number {
    const aIsPrerelease = prerelease(a) !== null
    const bIsPrerelease = prerelease(b) !== null
    if (aIsPrerelease !== bIsPrerelease) {
      return aIsPrerelease ? -1 : 1
    }
    return compare(a, b)
  }

  private static describeHigher(winner: string, loser: string, winnerSide: string, loserSide: string): string {
    if (prerelease(loser) !== null && prerelease(winner) === null) {
      return `${winnerSide} version ${winner} is stable, preferring over pre-release ${loser}`
    }
    return `${winnerSide} version ${winner} is higher than ${loser}`
  }

  /**
   * Minimum satisfying versions of two specs interpreted as semver ranges.
   * Returns null when either side is not a valid range, or one no version satisfies.
   */
  private static rangeMinimums(ourVersion: string, theirVersion: string): {ours: SemVer; theirs: SemVer} | null {
    try {
      const ourRange = validRange(ourVersion.trim(), {loose: true})
      const theirRange = validRange(theirVersion.trim(), {loose: true})
      if (ourRange === null || theirRange === null) {
        return null
      }

      const ours = minVersion(ourRange)
      const theirs = minVersion(theirRange)
      if (!ours || !theirs) {
        return null
      }

      return {ours, theirs}
    } catch {
      return null
    }
  }

  /**
   * Clean version string for comparison
   */
  private static cleanVersion(version: string): string {
    if (typeof version !== "string") {
      return String(version ?? "")
    }
    return version.replace(/^[\^~>=<\s]+/, "").trim()
  }

  /**
   * Prefer more specific version range
   */
  private static preferMoreSpecific(ours: string, theirs: string): Order {
    const ourSpecificity = this.getVersionSpecificity(ours)
    const theirSpecificity = this.getVersionSpecificity(theirs)

    if (ourSpecificity > theirSpecificity) {
      return {winner: "ours", reason: "our version is more specific"}
    } else if (theirSpecificity > ourSpecificity) {
      return {winner: "theirs", reason: "their version is more specific"}
    }
    return {winner: "ours", reason: "versions have equal specificity, keeping ours"}
  }

  /**
   * Prefer more restrictive version range
   */
  private static preferMoreRestrictive(ours: string, theirs: string): Order {
    const ourRestrictiveness = this.getVersionRestrictiveness(ours)
    const theirRestrictiveness = this.getVersionRestrictiveness(theirs)

    if (ourRestrictiveness > theirRestrictiveness) {
      return {winner: "ours", reason: "our version is more restrictive"}
    } else if (theirRestrictiveness > ourRestrictiveness) {
      return {winner: "theirs", reason: "their version is more restrictive"}
    }
    return {winner: "ours", reason: "versions have equal restrictiveness, keeping ours"}
  }

  /**
   * Get version specificity score (higher = more specific)
   */
  private static getVersionSpecificity(version: string): number {
    let score = 0

    // Exact version (no prefix) is most specific
    if (!/^[\^~>=<]/.test(version)) score += 3

    // Tilde is more specific than caret
    if (version.startsWith("~")) score += 2
    else if (version.startsWith("^")) score += 1

    // Count version parts (1.2.3 is more specific than 1.2)
    const parts = this.cleanVersion(version).split(".")
    score += parts.length

    return score
  }

  /**
   * Get version restrictiveness score (higher = more restrictive)
   */
  private static getVersionRestrictiveness(version: string): number {
    let score = 0

    // Exact version is most restrictive
    if (!/^[\^~>=<]/.test(version)) score += 5
    // Tilde is more restrictive than caret
    else if (version.startsWith("~")) score += 3
    else if (version.startsWith("^")) score += 2
    // Range operators
    else if (version.includes(">=") || version.includes("<=")) score += 1

    return score
  }

  /**
   * Resolve non-version conflicts (strings, numbers, objects, etc.)
   */
  static resolveNonVersion(
    ourValue: any,
    theirValue: any,
    strategy: ResolutionStrategy["name"]
  ): {resolved: any; reason: string} {
    switch (strategy) {
      case "ours":
        return {resolved: ourValue, reason: "using our value (ours strategy)"}
      case "theirs":
        return {resolved: theirValue, reason: "using their value (theirs strategy)"}
      case "highest":
      case "lowest": {
        // Numeric values (e.g. lockfileVersion) compare numerically
        if (typeof ourValue === "number" && typeof theirValue === "number") {
          const preferOurs = strategy === "highest" ? ourValue >= theirValue : ourValue <= theirValue
          return preferOurs
            ? {resolved: ourValue, reason: `our value is numerically ${strategy}`}
            : {resolved: theirValue, reason: `their value is numerically ${strategy}`}
        }

        // For strings, fall back to lexicographic comparison by code unit,
        // so the outcome does not depend on the machine's locale settings
        if (typeof ourValue === "string" && typeof theirValue === "string") {
          const comparison = ourValue < theirValue ? -1 : ourValue > theirValue ? 1 : 0
          const preferOurs = strategy === "highest" ? comparison > 0 : comparison < 0
          return preferOurs
            ? {resolved: ourValue, reason: `our value is lexicographically ${strategy}`}
            : {resolved: theirValue, reason: `their value is lexicographically ${strategy}`}
        }

        // For objects and mixed types, prefer ours as default
        return {resolved: ourValue, reason: "non-version conflict, keeping our value"}
      }
      default:
        return {resolved: ourValue, reason: "unknown strategy, keeping our value"}
    }
  }
}
