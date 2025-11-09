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
