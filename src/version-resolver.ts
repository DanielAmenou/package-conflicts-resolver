/**
 * Version resolution strategies using semver
 */

import * as semver from "semver"
import {ResolutionStrategy} from "./types.js"

export class VersionResolver {
  /**
   * Resolve version conflict using the specified strategy.
   * Never throws: falls back to keeping our version for non-comparable specs
   * (git URLs, file:, link:, workspace:, npm: aliases, dist-tags, etc.).
   */
  static resolveVersion(
    ourVersion: string,
    theirVersion: string,
    strategy: ResolutionStrategy["name"]
  ): {resolved: string; reason: string} {
    try {
      switch (strategy) {
        case "ours":
          return {resolved: ourVersion, reason: "using our version (ours strategy)"}
        case "theirs":
          return {resolved: theirVersion, reason: "using their version (theirs strategy)"}
        case "lowest":
          return this.resolveLowest(ourVersion, theirVersion)
        case "highest":
        default:
          return this.resolveHighest(ourVersion, theirVersion)
      }
    } catch {
      return {resolved: ourVersion, reason: "version comparison failed, keeping our version"}
    }
  }

  /**
   * Resolve to highest version
   */
  private static resolveHighest(ourVersion: string, theirVersion: string): {resolved: string; reason: string} {
    const ourClean = this.cleanVersion(ourVersion)
    const theirClean = this.cleanVersion(theirVersion)

    // If versions are identical, return either one
    if (ourClean === theirClean) {
      return {resolved: ourVersion, reason: "versions are identical"}
    }

    // 1. Direct semver comparison (preserves pre-release)
    if (semver.valid(ourClean) && semver.valid(theirClean)) {
      // Check if one is a pre-release and the other is stable
      const ourIsPrerelease = semver.prerelease(ourClean) !== null
      const theirIsPrerelease = semver.prerelease(theirClean) !== null

      // Prefer stable versions over pre-release versions when using "highest" strategy
      if (ourIsPrerelease && !theirIsPrerelease) {
        return {
          resolved: theirVersion,
          reason: `their version ${theirClean} is stable, preferring over pre-release ${ourClean}`,
        }
      }
      if (!ourIsPrerelease && theirIsPrerelease) {
        return {
          resolved: ourVersion,
          reason: `our version ${ourClean} is stable, preferring over pre-release ${theirClean}`,
        }
      }

      // Both are either stable or pre-release, use normal semver comparison
      const comparison = semver.compare(ourClean, theirClean)
      if (comparison > 0) {
        return {resolved: ourVersion, reason: `our version ${ourClean} is higher than ${theirClean}`}
      } else if (comparison < 0) {
        return {resolved: theirVersion, reason: `their version ${theirClean} is higher than ${ourClean}`}
      } else {
        return {resolved: ourVersion, reason: "versions are identical"}
      }
    }

    // 2. Compare as semver ranges (handles "*", "1.x", ">=1.0.0 <2.0.0", "1.2.3 - 2.0.0", ...)
    const rangeComparison = this.compareAsRanges(ourVersion, theirVersion)
    if (rangeComparison !== null) {
      if (rangeComparison > 0) {
        return {resolved: ourVersion, reason: `our range ${ourVersion} allows a higher minimum than ${theirVersion}`}
      } else if (rangeComparison < 0) {
        return {
          resolved: theirVersion,
          reason: `their range ${theirVersion} allows a higher minimum than ${ourVersion}`,
        }
      }
      // Ranges have equal minimums, prefer the one with more specific range
      return this.preferMoreSpecific(ourVersion, theirVersion)
    }

    // 3. Coerced comparison for near-semver strings ("v1.2", "1.2.3.4", ...)
    const ourSemver = semver.coerce(ourClean)
    const theirSemver = semver.coerce(theirClean)

    if (ourSemver && theirSemver) {
      const comparison = semver.compare(ourSemver, theirSemver)
      if (comparison > 0) {
        return {resolved: ourVersion, reason: `our version ${ourClean} is higher than ${theirClean}`}
      } else if (comparison < 0) {
        return {resolved: theirVersion, reason: `their version ${theirClean} is higher than ${ourClean}`}
      } else {
        // Semver versions are equal, prefer the one with more specific range
        return this.preferMoreSpecific(ourVersion, theirVersion)
      }
    }

    // 4. Non-comparable specs (git URLs, file:, workspace:, dist-tags, ...):
    // keep our version deterministically instead of guessing.
    return {
      resolved: ourVersion,
      reason: `versions are not comparable ("${ourVersion}" vs "${theirVersion}"), keeping our version`,
    }
  }

  /**
   * Resolve to lowest version
   */
  private static resolveLowest(ourVersion: string, theirVersion: string): {resolved: string; reason: string} {
    const ourClean = this.cleanVersion(ourVersion)
    const theirClean = this.cleanVersion(theirVersion)

    // If versions are identical, return either one
    if (ourClean === theirClean) {
      return {resolved: ourVersion, reason: "versions are identical"}
    }

    // 1. Direct semver comparison (preserves pre-release)
    if (semver.valid(ourClean) && semver.valid(theirClean)) {
      const comparison = semver.compare(ourClean, theirClean)
      if (comparison < 0) {
        return {resolved: ourVersion, reason: `our version ${ourClean} is lower than ${theirClean}`}
      } else if (comparison > 0) {
        return {resolved: theirVersion, reason: `their version ${theirClean} is lower than ${ourClean}`}
      } else {
        return {resolved: ourVersion, reason: "versions are identical"}
      }
    }

    // 2. Compare as semver ranges
    const rangeComparison = this.compareAsRanges(ourVersion, theirVersion)
    if (rangeComparison !== null) {
      if (rangeComparison < 0) {
        return {resolved: ourVersion, reason: `our range ${ourVersion} allows a lower minimum than ${theirVersion}`}
      } else if (rangeComparison > 0) {
        return {resolved: theirVersion, reason: `their range ${theirVersion} allows a lower minimum than ${ourVersion}`}
      }
      // Ranges have equal minimums, prefer the one with more restrictive range
      return this.preferMoreRestrictive(ourVersion, theirVersion)
    }

    // 3. Coerced comparison for near-semver strings
    const ourSemver = semver.coerce(ourClean)
    const theirSemver = semver.coerce(theirClean)

    if (ourSemver && theirSemver) {
      const comparison = semver.compare(ourSemver, theirSemver)
      if (comparison < 0) {
        return {resolved: ourVersion, reason: `our version ${ourClean} is lower than ${theirClean}`}
      } else if (comparison > 0) {
        return {resolved: theirVersion, reason: `their version ${theirClean} is lower than ${ourClean}`}
      } else {
        // Semver versions are equal, prefer the one with more restrictive range
        return this.preferMoreRestrictive(ourVersion, theirVersion)
      }
    }

    // 4. Non-comparable specs: keep our version deterministically.
    return {
      resolved: ourVersion,
      reason: `versions are not comparable ("${ourVersion}" vs "${theirVersion}"), keeping our version`,
    }
  }

  /**
   * Compare two specs as semver ranges using their minimum satisfying versions.
   * Returns null when either side is not a valid range.
   */
  private static compareAsRanges(ourVersion: string, theirVersion: string): number | null {
    try {
      const ourRange = semver.validRange(ourVersion.trim(), {loose: true})
      const theirRange = semver.validRange(theirVersion.trim(), {loose: true})
      if (ourRange === null || theirRange === null) {
        return null
      }

      const ourMin = semver.minVersion(ourRange)
      const theirMin = semver.minVersion(theirRange)
      if (!ourMin || !theirMin) {
        return null
      }

      return semver.compare(ourMin, theirMin)
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
  private static preferMoreSpecific(ourVersion: string, theirVersion: string): {resolved: string; reason: string} {
    const ourSpecificity = this.getVersionSpecificity(ourVersion)
    const theirSpecificity = this.getVersionSpecificity(theirVersion)

    if (ourSpecificity > theirSpecificity) {
      return {resolved: ourVersion, reason: "our version is more specific"}
    } else if (theirSpecificity > ourSpecificity) {
      return {resolved: theirVersion, reason: "their version is more specific"}
    } else {
      return {resolved: ourVersion, reason: "versions have equal specificity, keeping ours"}
    }
  }

  /**
   * Prefer more restrictive version range
   */
  private static preferMoreRestrictive(ourVersion: string, theirVersion: string): {resolved: string; reason: string} {
    const ourRestrictiveness = this.getVersionRestrictiveness(ourVersion)
    const theirRestrictiveness = this.getVersionRestrictiveness(theirVersion)

    if (ourRestrictiveness > theirRestrictiveness) {
      return {resolved: ourVersion, reason: "our version is more restrictive"}
    } else if (theirRestrictiveness > ourRestrictiveness) {
      return {resolved: theirVersion, reason: "their version is more restrictive"}
    } else {
      return {resolved: ourVersion, reason: "versions have equal restrictiveness, keeping ours"}
    }
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

        // For strings, fall back to lexicographic comparison
        if (typeof ourValue === "string" && typeof theirValue === "string") {
          const comparison = ourValue.localeCompare(theirValue)
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
