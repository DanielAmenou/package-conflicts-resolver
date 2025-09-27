/**
 * Tests for PackageResolver
 */

import {strict as assert} from "assert"
import {test, describe} from "node:test"
import {PackageResolver} from "../package-resolver.js"
import {CliOptions} from "../types.js"

describe("PackageResolver", () => {
  const createTestOptions = (overrides: Partial<CliOptions> = {}): CliOptions => ({
    strategy: "highest",
    dryRun: false,
    quiet: true,
    json: false,
    verbose: false,
    regenerateLock: false,
    ...overrides,
  })

  test("should resolve no conflicts when none exist", async () => {
    const content = `{
  "name": "test-package",
  "version": "1.0.0",
  "dependencies": {
    "lodash": "^4.17.21"
  }
}`

    const resolver = new PackageResolver(createTestOptions())
    const result = await resolver.resolveConflicts(content)

    assert.equal(result.resolved, true)
    assert.equal(result.conflicts.length, 0)
    assert.equal(result.errors.length, 0)
  })

  test("should resolve version conflicts", async () => {
    const content = `{
  "name": "test-package",
<<<<<<< HEAD
  "version": "1.0.0"
=======
  "version": "2.0.0"
>>>>>>> feature
}`

    const resolver = new PackageResolver(createTestOptions())
    const result = await resolver.resolveConflicts(content)

    assert.equal(result.resolved, true)
    assert.equal(result.conflicts.length, 1)
    assert.equal(result.conflicts[0]!.field, "version")
    assert.equal(result.conflicts[0]!.resolvedValue, "2.0.0") // highest strategy
    assert.equal(result.packageJson?.version, "2.0.0")
  })

  test("should resolve dependency conflicts", async () => {
    const content = `{
  "name": "test-package",
  "version": "1.0.0",
<<<<<<< HEAD
  "dependencies": {
    "lodash": "^4.17.21",
    "express": "^4.18.0"
  }
=======
  "dependencies": {
    "lodash": "^4.17.20",
    "react": "^18.0.0"
  }
>>>>>>> feature
}`

    const resolver = new PackageResolver(createTestOptions())
    const result = await resolver.resolveConflicts(content)

    assert.equal(result.resolved, true)
    assert.equal(result.conflicts.length, 1)
    assert.equal(result.conflicts[0]!.field, "dependencies")

    // Should merge all dependencies and resolve version conflict
    const deps = result.packageJson?.dependencies
    assert(deps)
    assert.equal(deps.lodash, "^4.17.21") // highest version
    assert.equal(deps.express, "^4.18.0") // from ours
    assert.equal(deps.react, "^18.0.0") // from theirs
  })

  test("should use lowest strategy when specified", async () => {
    const content = `{
  "name": "test-package",
<<<<<<< HEAD
  "version": "2.0.0"
=======
  "version": "1.0.0"
>>>>>>> feature
}`

    const resolver = new PackageResolver(createTestOptions({strategy: "lowest"}))
    const result = await resolver.resolveConflicts(content)

    assert.equal(result.resolved, true)
    assert.equal(result.conflicts[0]!.resolvedValue, "1.0.0") // lowest strategy
  })

  test("should use ours strategy when specified", async () => {
    const content = `{
  "name": "test-package",
<<<<<<< HEAD
  "version": "1.5.0"
=======
  "version": "2.0.0"
>>>>>>> feature
}`

    const resolver = new PackageResolver(createTestOptions({strategy: "ours"}))
    const result = await resolver.resolveConflicts(content)

    assert.equal(result.resolved, true)
    assert.equal(result.conflicts[0]!.resolvedValue, "1.5.0") // ours strategy
  })

  test("should resolve script conflicts", async () => {
    const content = `{
  "name": "test-package",
  "version": "1.0.0",
<<<<<<< HEAD
  "scripts": {
    "test": "jest",
    "build": "webpack"
  }
=======
  "scripts": {
    "test": "mocha",
    "start": "node server.js"
  }
>>>>>>> feature
}`

    const resolver = new PackageResolver(createTestOptions())
    const result = await resolver.resolveConflicts(content)

    assert.equal(result.resolved, true)
    assert.equal(result.conflicts.length, 1)

    const scripts = result.packageJson?.scripts
    assert(scripts)
    assert(scripts.test) // Should be resolved based on strategy
    assert.equal(scripts.build, "webpack") // from ours
    assert.equal(scripts.start, "node server.js") // from theirs
  })

  test("should maintain stable field order", async () => {
    const content = `{
<<<<<<< HEAD
  "version": "1.0.0",
  "name": "test-package",
  "scripts": {
    "test": "jest"
  },
  "dependencies": {
    "lodash": "^4.17.21"
  }
=======
  "name": "test-package",
  "version": "2.0.0",
  "dependencies": {
    "lodash": "^4.17.20"
  },
  "devDependencies": {
    "typescript": "^4.0.0"
  }
>>>>>>> feature
}`

    const resolver = new PackageResolver(createTestOptions())
    const result = await resolver.resolveConflicts(content)

    assert.equal(result.resolved, true)

    const keys = Object.keys(result.packageJson!)
    const expectedOrder = ["name", "version", "scripts", "dependencies", "devDependencies"]

    // Check that stable fields appear in the correct order
    let lastIndex = -1
    for (const field of expectedOrder) {
      const index = keys.indexOf(field)
      if (index !== -1) {
        assert(index > lastIndex, `Field ${field} should come after previous stable fields`)
        lastIndex = index
      }
    }
  })

  test("should handle multiple conflicts", async () => {
    const content = `{
  "name": "test-package",
<<<<<<< HEAD
  "version": "1.0.0",
  "dependencies": {
    "lodash": "^4.17.21"
  }
=======
  "version": "2.0.0",
  "dependencies": {
    "lodash": "^4.17.20"
  }
>>>>>>> feature
}`

    const resolver = new PackageResolver(createTestOptions())
    const result = await resolver.resolveConflicts(content)

    assert.equal(result.resolved, true)
    assert.equal(result.conflicts.length, 1) // Single conflict with multiple fields
  })

  test("should handle invalid JSON gracefully", async () => {
    const content = `{
  "name": "test-package",
<<<<<<< HEAD
  "version": "1.0.0"
  // invalid JSON
=======
  "version": "2.0.0"
>>>>>>> feature
}`

    const resolver = new PackageResolver(createTestOptions())
    const result = await resolver.resolveConflicts(content)

    // Should still attempt to resolve what it can
    assert(result.errors.length > 0 || result.resolved)
  })

  test("should preserve property order in dependencies", async () => {
    const content = `{
  "name": "test-package",
  "version": "1.0.0",
<<<<<<< HEAD
  "dependencies": {
    "express": "^4.18.0",
    "lodash": "^4.17.21",
    "react": "^17.0.0"
  }
=======
  "dependencies": {
    "lodash": "^4.17.20",
    "react": "^18.0.0",
    "typescript": "^4.0.0"
  }
>>>>>>> feature
}`

    const resolver = new PackageResolver(createTestOptions())
    const result = await resolver.resolveConflicts(content)

    assert.equal(result.resolved, true)
    assert.equal(result.conflicts.length, 1)
    assert.equal(result.conflicts[0]!.field, "dependencies")

    // Get the dependencies in order
    const deps = result.packageJson?.dependencies
    assert(deps)
    const depsOrder = Object.keys(deps)

    // Should preserve order from HEAD (our) branch for existing deps
    // and append new deps from their branch at the end
    assert.equal(depsOrder[0], "express", "express should be first")
    assert.equal(depsOrder[1], "lodash", "lodash should be second")
    assert.equal(depsOrder[2], "react", "react should be third")
    assert.equal(depsOrder[3], "typescript", "typescript should be fourth")

    // Verify the values are correct too
    assert.equal(deps.express, "^4.18.0", "express version should be from ours")
    assert.equal(deps.lodash, "^4.17.21", "lodash version should be highest")
    assert.equal(deps.react, "^18.0.0", "react version should be highest")
    assert.equal(deps.typescript, "^4.0.0", "typescript version should be from theirs")
  })

  test("should preserve property order in scripts", async () => {
    const content = `{
  "name": "test-package",
  "version": "1.0.0",
<<<<<<< HEAD
  "scripts": {
    "build": "tsc",
    "test": "jest",
    "lint": "eslint"
  }
=======
  "scripts": {
    "test": "mocha",
    "start": "node server.js",
    "lint": "prettier"
  }
>>>>>>> feature
}`

    const resolver = new PackageResolver(createTestOptions())
    const result = await resolver.resolveConflicts(content)

    assert.equal(result.resolved, true)
    assert.equal(result.conflicts.length, 1)
    assert.equal(result.conflicts[0]!.field, "scripts")

    // Get the scripts in order
    const scripts = result.packageJson?.scripts
    assert(scripts)
    const scriptsOrder = Object.keys(scripts)

    // Should preserve order from HEAD (our) branch for existing scripts
    // and append new scripts from their branch at the end
    assert.equal(scriptsOrder[0], "build", "build should be first")
    assert.equal(scriptsOrder[1], "test", "test should be second")
    assert.equal(scriptsOrder[2], "lint", "lint should be third")
    assert.equal(scriptsOrder[3], "start", "start should be fourth")

    // Verify the values are correct too
    assert.equal(scripts.build, "tsc", "build should be from ours")
    assert.equal(
      scripts.test,
      "mocha",
      "test should be from theirs (using highest strategy - mocha > jest lexicographically)"
    )
    assert.equal(
      scripts.lint,
      "prettier",
      "lint should be from theirs (using highest strategy - prettier > eslint lexicographically)"
    )
    assert.equal(scripts.start, "node server.js", "start should be from theirs")
  })

  test("should handle empty conflicts", async () => {
    const content = `{
  "name": "test-package",
<<<<<<< HEAD
=======
  "version": "2.0.0"
>>>>>>> feature
}`

    const resolver = new PackageResolver(createTestOptions())
    const result = await resolver.resolveConflicts(content)

    // Should handle gracefully
    assert(result.resolved || result.errors.length > 0)
  })
})
