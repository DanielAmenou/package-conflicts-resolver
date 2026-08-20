/**
 * Tests for the block-based fallback resolution path: it runs when a conflict
 * side is not valid JSON (e.g. a missing comma), where the semantic document
 * merge cannot help. Includes regression tests for the field-nesting bug where
 * entries-only conflicts inside "dependencies" got wrapped in a second
 * "dependencies" key.
 */

import {strict as assert} from "assert"
import {test, describe} from "node:test"
import {PackageResolver} from "../package-resolver.js"
import {CliOptions} from "../types.js"

const OPTIONS: CliOptions = {
  strategy: "highest",
  dryRun: true,
  quiet: true,
  json: false,
  verbose: false,
  regenerateLock: false,
}

function makeResolver(overrides: Partial<CliOptions> = {}): PackageResolver {
  return new PackageResolver({...OPTIONS, ...overrides})
}

describe("Fallback resolution (invalid JSON inside a conflict side)", () => {
  test("entries-only dependency conflict is not nested inside a duplicate field", async () => {
    // "ours" is missing a comma, so both extracted documents are invalid JSON
    // and the semantic merge cannot run
    const content = [
      "{",
      '  "dependencies": {',
      "<<<<<<< HEAD",
      '    "lodash": "^4.17.21"',
      '    "express": "^4.18.0"',
      "=======",
      '    "lodash": "^4.17.20"',
      ">>>>>>> feature",
      "  }",
      "}",
    ].join("\n")

    const result = await makeResolver().resolveConflicts(content)
    assert.equal(result.resolved, true, result.errors.join(", "))
    assert(result.packageJson)

    assert.deepEqual(result.packageJson.dependencies, {
      lodash: "^4.17.21",
      express: "^4.18.0",
    })
    assert.equal("dependencies" in (result.packageJson.dependencies as any), false, "must not nest the field")
  })

  test("entries-only conflict preserves the trailing comma when entries follow", async () => {
    const content = [
      "{",
      '  "dependencies": {',
      "<<<<<<< HEAD",
      '    "lodash": "^4.17.21"',
      '    "express": "^4.18.0",',
      "=======",
      '    "lodash": "^4.17.20",',
      ">>>>>>> feature",
      '    "react": "^18.0.0"',
      "  }",
      "}",
    ].join("\n")

    const result = await makeResolver().resolveConflicts(content)
    assert.equal(result.resolved, true, result.errors.join(", "))
    assert.deepEqual(result.packageJson?.dependencies, {
      lodash: "^4.17.21",
      express: "^4.18.0",
      react: "^18.0.0",
    })
  })

  test("whole-field dependency conflict still emits the field declaration", async () => {
    // Conflict covers the complete "dependencies" field, ours side invalid
    const content = [
      "{",
      '  "name": "app",',
      "<<<<<<< HEAD",
      '  "dependencies": {',
      '    "lodash": "^4.17.21"',
      '    "express": "^4.18.0"',
      "  }",
      "=======",
      '  "dependencies": {',
      '    "lodash": "^4.17.20"',
      "  }",
      ">>>>>>> feature",
      "}",
    ].join("\n")

    const result = await makeResolver().resolveConflicts(content)
    assert.equal(result.resolved, true, result.errors.join(", "))
    assert.equal(result.packageJson?.name, "app")
    assert.deepEqual(result.packageJson?.dependencies, {
      lodash: "^4.17.21",
      express: "^4.18.0",
    })
  })

  test("scripts conflicts merge through the fallback path", async () => {
    const content = [
      "{",
      '  "scripts": {',
      "<<<<<<< HEAD",
      '    "build": "tsc"',
      '    "test": "node --test"',
      "=======",
      '    "build": "tsc"',
      ">>>>>>> feature",
      "  }",
      "}",
    ].join("\n")

    const result = await makeResolver().resolveConflicts(content)
    assert.equal(result.resolved, true, result.errors.join(", "))
    assert.deepEqual(result.packageJson?.scripts, {
      build: "tsc",
      test: "node --test",
    })
  })

  test("simple field conflict with an invalid side resolves via the fallback", async () => {
    const content = [
      "{",
      "<<<<<<< HEAD",
      '  "version": "1.1.0",,',
      "=======",
      '  "version": "1.2.0"',
      ">>>>>>> feature",
      "}",
    ].join("\n")

    const result = await makeResolver().resolveConflicts(content)
    assert.equal(result.resolved, true, result.errors.join(", "))
    assert.equal(result.packageJson?.version, "1.2.0")
  })

  test("fallback respects the lowest strategy", async () => {
    const content = [
      "{",
      '  "dependencies": {',
      "<<<<<<< HEAD",
      '    "lodash": "^4.17.21"',
      '    "express": "^4.18.0"',
      "=======",
      '    "lodash": "^4.17.20"',
      ">>>>>>> feature",
      "  }",
      "}",
    ].join("\n")

    const result = await makeResolver({strategy: "lowest"}).resolveConflicts(content)
    assert.equal(result.resolved, true, result.errors.join(", "))
    assert.equal(result.packageJson?.dependencies?.lodash, "^4.17.20")
  })

  test("node_modules lock entry conflicts resolve atomically via the fallback", async () => {
    const content = [
      "{",
      '  "packages": {',
      "<<<<<<< HEAD",
      '    "node_modules/lodash": {',
      '      "version": "4.17.21"',
      '      "resolved": "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz",',
      '      "integrity": "sha512-ours"',
      "    }",
      "=======",
      '    "node_modules/lodash": {',
      '      "version": "4.17.20",',
      '      "resolved": "https://registry.npmjs.org/lodash/-/lodash-4.17.20.tgz",',
      '      "integrity": "sha512-theirs"',
      "    }",
      ">>>>>>> feature",
      "  }",
      "}",
    ].join("\n")

    const result = await makeResolver().resolveConflicts(content)
    assert.equal(result.resolved, true, result.errors.join(", "))
  })

  test("node_modules entry field merge (same version, different metadata) via the fallback", async () => {
    // Same version on both sides but a field differs; ours side is invalid
    // JSON so this exercises the field-by-field node_modules merge
    const content = [
      "{",
      '  "packages": {',
      "<<<<<<< HEAD",
      '    "node_modules/lodash": {',
      '      "version": "4.17.21"',
      '      "dev": true',
      "    }",
      "=======",
      '    "node_modules/lodash": {',
      '      "version": "4.17.21",',
      '      "license": "MIT"',
      "    }",
      ">>>>>>> feature",
      "  }",
      "}",
    ].join("\n")

    const result = await makeResolver().resolveConflicts(content)
    assert.equal(result.resolved, true, result.errors.join(", "))
  })

  test("unresolvable garbage reports errors instead of writing corrupt output", async () => {
    const content = [
      "not json at all",
      "<<<<<<< HEAD",
      "our garbage {{{",
      "=======",
      "their garbage",
      ">>>>>>> feature",
    ].join("\n")

    const result = await makeResolver().resolveConflicts(content)
    assert.equal(result.resolved, false)
    assert(result.errors.length > 0, "must surface an error")
  })
})
