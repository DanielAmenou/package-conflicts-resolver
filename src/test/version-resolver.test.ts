/**
 * Tests for VersionResolver
 */

import {strict as assert} from "assert"
import {test, describe} from "node:test"
import {VersionResolver} from "../version-resolver.js"

describe("VersionResolver", () => {
  describe("resolveVersion", () => {
    test("should resolve to highest version by default", () => {
      const result = VersionResolver.resolveVersion("1.0.0", "2.0.0", "highest")
      assert.equal(result.resolved, "2.0.0")
      assert(result.reason.includes("higher"))
    })

    test("should resolve to lowest version when strategy is lowest", () => {
      const result = VersionResolver.resolveVersion("1.0.0", "2.0.0", "lowest")
      assert.equal(result.resolved, "1.0.0")
      assert(result.reason.includes("lower"))
    })

    test("should use our version when strategy is ours", () => {
      const result = VersionResolver.resolveVersion("1.0.0", "2.0.0", "ours")
      assert.equal(result.resolved, "1.0.0")
      assert(result.reason.includes("ours strategy"))
    })

    test("should use their version when strategy is theirs", () => {
      const result = VersionResolver.resolveVersion("1.0.0", "2.0.0", "theirs")
      assert.equal(result.resolved, "2.0.0")
      assert(result.reason.includes("theirs strategy"))
    })

    test("should handle semver ranges", () => {
      const result = VersionResolver.resolveVersion("^1.0.0", "^2.0.0", "highest")
      assert.equal(result.resolved, "^2.0.0")
    })

    test("should handle tilde ranges", () => {
      const result = VersionResolver.resolveVersion("~1.0.0", "~1.1.0", "highest")
      assert.equal(result.resolved, "~1.1.0")
    })

    test("should handle mixed range types", () => {
      const result = VersionResolver.resolveVersion("^1.0.0", "~1.0.0", "highest")
      // Both resolve to same base version, should prefer more specific
      assert(result.resolved === "^1.0.0" || result.resolved === "~1.0.0")
    })

    test("should handle identical versions", () => {
      const result = VersionResolver.resolveVersion("1.0.0", "1.0.0", "highest")
      assert.equal(result.resolved, "1.0.0")
      assert(result.reason.includes("identical"))
    })

    test("should handle pre-release versions", () => {
      const result = VersionResolver.resolveVersion("1.0.0-alpha.1", "1.0.0-alpha.2", "highest")
      assert.equal(result.resolved, "1.0.0-alpha.2")
    })

    test("should handle beta vs stable versions", () => {
      const result = VersionResolver.resolveVersion("1.0.0-beta.1", "1.0.0", "highest")
      assert.equal(result.resolved, "1.0.0")
    })

    test("should prefer stable version over pre-release even when pre-release has higher base version", () => {
      const result = VersionResolver.resolveVersion("2.68.4-beta-new-cli.3", "2.68.6", "highest")
      assert.equal(result.resolved, "2.68.6", "Should prefer stable 2.68.6 over pre-release 2.68.4-beta-new-cli.3")
      assert(result.reason.includes("stable"))
    })

    test("should handle non-semver versions gracefully", () => {
      const result = VersionResolver.resolveVersion("latest", "next", "highest")
      assert(result.resolved === "latest" || result.resolved === "next")
    })

    test("should handle git URLs", () => {
      const gitUrl1 = "git+https://github.com/user/repo.git"
      const gitUrl2 = "git+https://github.com/user/repo.git#v2.0.0"
      const result = VersionResolver.resolveVersion(gitUrl1, gitUrl2, "highest")
      assert(result.resolved === gitUrl1 || result.resolved === gitUrl2)
    })
  })

  describe("resolveNonVersion", () => {
    test("should resolve string conflicts", () => {
      const result = VersionResolver.resolveNonVersion("test-app", "my-app", "ours")
      assert.equal(result.resolved, "test-app")
      assert(result.reason.includes("ours strategy"))
    })

    test("should resolve object conflicts", () => {
      const our = {test: "jest", build: "webpack"}
      const their = {test: "mocha", lint: "eslint"}
      const result = VersionResolver.resolveNonVersion(our, their, "ours")
      assert.equal(result.resolved, our)
    })

    test("should handle highest strategy for strings", () => {
      const result = VersionResolver.resolveNonVersion("apple", "banana", "highest")
      assert.equal(result.resolved, "banana") // lexicographically higher
    })

    test("should handle lowest strategy for strings", () => {
      const result = VersionResolver.resolveNonVersion("apple", "banana", "lowest")
      assert.equal(result.resolved, "apple") // lexicographically lower
    })
  })

  describe("lowest strategy branches", () => {
    test("prefers the lower pre-release over stable", () => {
      const result = VersionResolver.resolveVersion("1.0.0-alpha.1", "1.0.0", "lowest")
      assert.equal(result.resolved, "1.0.0-alpha.1")
    })

    test("identical specs short-circuit", () => {
      const result = VersionResolver.resolveVersion("^1.2.3", "^1.2.3", "lowest")
      assert.equal(result.resolved, "^1.2.3")
      assert(result.reason.includes("identical"))
    })

    test("compares ranges by minimum version", () => {
      assert.equal(VersionResolver.resolveVersion("^1.5.0", "^1.2.0", "lowest").resolved, "^1.2.0")
      assert.equal(VersionResolver.resolveVersion("^1.2.0", "^1.5.0", "lowest").resolved, "^1.2.0")
    })

    test("equal minimums prefer the more restrictive range", () => {
      assert.equal(VersionResolver.resolveVersion("^1.2.3", "~1.2.3", "lowest").resolved, "~1.2.3")
      assert.equal(VersionResolver.resolveVersion("~1.2.3", "^1.2.3", "lowest").resolved, "~1.2.3")
      assert.equal(VersionResolver.resolveVersion("^1.2.3", "1.2.3", "lowest").resolved, "1.2.3", "exact wins")
    })

    test("falls back to coerced comparison for near-semver strings", () => {
      assert.equal(VersionResolver.resolveVersion("v1.2", "1.3.0.0", "lowest").resolved, "v1.2")
      assert.equal(VersionResolver.resolveVersion("1.3.0.0", "v1.2", "lowest").resolved, "v1.2")
    })

    test("keeps ours for non-comparable specs", () => {
      const result = VersionResolver.resolveVersion("workspace:*", "file:../lib", "lowest")
      assert.equal(result.resolved, "workspace:*")
      assert(result.reason.includes("not comparable"))
    })
  })

  describe("highest strategy branches", () => {
    test("equal range minimums prefer the more specific spec", () => {
      assert.equal(VersionResolver.resolveVersion("1.2.3", "^1.2.3", "highest").resolved, "1.2.3")
      assert.equal(VersionResolver.resolveVersion("^1.2.3", "1.2.3", "highest").resolved, "1.2.3")
      assert.equal(VersionResolver.resolveVersion("~1.2.3", "^1.2.3", "highest").resolved, "~1.2.3")
    })

    test("falls back to coerced comparison for near-semver strings", () => {
      assert.equal(VersionResolver.resolveVersion("v1.2", "1.3.0.0", "highest").resolved, "1.3.0.0")
      assert.equal(VersionResolver.resolveVersion("1.3.0.0", "v1.2", "highest").resolved, "1.3.0.0")
    })

    test("wildcard and x-ranges compare by minimum", () => {
      const result = VersionResolver.resolveVersion("1.x", "2.x", "highest")
      assert.equal(result.resolved, "2.x")
    })

    test("keeps ours for non-comparable specs", () => {
      const result = VersionResolver.resolveVersion("workspace:*", "npm:lodash@4", "highest")
      assert.equal(result.resolved, "workspace:*")
      assert(result.reason.includes("not comparable"))
    })

    test("prerelease-only comparison keeps semver ordering", () => {
      assert.equal(VersionResolver.resolveVersion("2.0.0-rc.2", "2.0.0-rc.1", "highest").resolved, "2.0.0-rc.2")
    })

    test("our stable version beats their pre-release", () => {
      const result = VersionResolver.resolveVersion("1.0.0", "1.0.1-beta.1", "highest")
      assert.equal(result.resolved, "1.0.0")
      assert(result.reason.includes("stable"))
    })

    test("identical raw specs short-circuit", () => {
      const result = VersionResolver.resolveVersion("^1.2.3", "^1.2.3", "highest")
      assert.equal(result.resolved, "^1.2.3")
      assert(result.reason.includes("identical"))
    })

    test("range vs non-comparable spec keeps ours", () => {
      const result = VersionResolver.resolveVersion("^1.0.0", "workspace:*", "highest")
      assert.equal(result.resolved, "^1.0.0")
    })
  })

  describe("resolveNonVersion branches", () => {
    test("numbers compare numerically", () => {
      assert.equal(VersionResolver.resolveNonVersion(2, 3, "highest").resolved, 3)
      assert.equal(VersionResolver.resolveNonVersion(2, 3, "lowest").resolved, 2)
      assert.equal(VersionResolver.resolveNonVersion(3, 2, "highest").resolved, 3)
    })

    test("theirs strategy returns their value", () => {
      assert.equal(VersionResolver.resolveNonVersion("a", "b", "theirs").resolved, "b")
    })

    test("mixed types keep our value", () => {
      const result = VersionResolver.resolveNonVersion("text", 42, "highest")
      assert.equal(result.resolved, "text")
      assert(result.reason.includes("keeping our value"))
    })

    test("objects keep our value under highest/lowest", () => {
      const ours = {a: 1}
      assert.equal(VersionResolver.resolveNonVersion(ours, {b: 2}, "highest").resolved, ours)
      assert.equal(VersionResolver.resolveNonVersion(ours, {b: 2}, "lowest").resolved, ours)
    })

    test("unknown strategy keeps our value", () => {
      const result = VersionResolver.resolveNonVersion("a", "b", "bogus" as any)
      assert.equal(result.resolved, "a")
    })
  })

  describe("edge cases", () => {
    test("should handle empty strings", () => {
      const result = VersionResolver.resolveVersion("", "1.0.0", "highest")
      assert.equal(result.resolved, "1.0.0")
    })

    test("should handle null/undefined gracefully", () => {
      const result = VersionResolver.resolveNonVersion(null, "value", "ours")
      assert.equal(result.resolved, null)
    })

    test("should handle complex version ranges", () => {
      const result = VersionResolver.resolveVersion(">=1.0.0 <2.0.0", "^1.5.0", "highest")
      // Should pick the one that allows higher versions
      assert(result.resolved === ">=1.0.0 <2.0.0" || result.resolved === "^1.5.0")
    })
  })
})

describe("stable-over-pre-release applies to ranges too", () => {
  test("a stable range beats a pre-release range with a higher base version", () => {
    assert.equal(VersionResolver.resolveVersion("^2.0.0-beta.1", "^1.9.0", "highest").resolved, "^1.9.0")
    assert.equal(VersionResolver.resolveVersion("^1.9.0", "^2.0.0-beta.1", "highest").resolved, "^1.9.0")
  })

  test("an exact pre-release spec loses to a stable range", () => {
    // Mirrors what happens in package.json ("2.0.0-beta.1" vs "^1.9.0") and in
    // the lockfile ("2.0.0-beta.1" vs "1.9.0"): both must pick the stable side
    assert.equal(VersionResolver.resolveVersion("2.0.0-beta.1", "^1.9.0", "highest").resolved, "^1.9.0")
    assert.equal(VersionResolver.resolveVersion("2.0.0-beta.1", "1.9.0", "highest").resolved, "1.9.0")
  })

  test("two pre-release ranges compare by semver precedence", () => {
    assert.equal(VersionResolver.resolveVersion("^2.0.0-beta.1", "^2.0.0-beta.3", "highest").resolved, "^2.0.0-beta.3")
    assert.equal(VersionResolver.resolveVersion("^2.0.0-rc.1", "^2.0.0-beta.9", "highest").resolved, "^2.0.0-rc.1")
  })

  test("the lowest strategy keeps plain semver ordering for pre-release ranges", () => {
    assert.equal(VersionResolver.resolveVersion("^2.0.0-beta.1", "^1.9.0", "lowest").resolved, "^1.9.0")
    assert.equal(VersionResolver.resolveVersion("^1.0.0-alpha.1", "^1.0.0", "lowest").resolved, "^1.0.0-alpha.1")
  })
})
