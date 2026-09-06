/**
 * Property-based tests for the merge itself.
 *
 * Instead of checking one hand-written scenario, these generate many random
 * base/ours/theirs lockfiles and assert the properties that must hold for
 * every merge — above all that a package entry's identity (version, resolved,
 * integrity) never comes from two different branches, which is what causes
 * EINTEGRITY failures on `npm ci`.
 */

import {strict as assert} from "assert"
import {test, describe} from "node:test"
import {PackageResolver} from "../package-resolver.js"
import {validateLockfile} from "../lockfile-validator.js"
import {CliOptions} from "../types.js"

const STRATEGIES: CliOptions["strategy"][] = ["highest", "lowest", "ours", "theirs"]

function makeResolver(strategy: CliOptions["strategy"]): PackageResolver {
  return new PackageResolver({strategy, dryRun: true, quiet: true, json: false, verbose: false, regenerateLock: false})
}

/** Deterministic PRNG so any failure is reproducible from its seed */
function makeRandom(seed: number): () => number {
  let state = (seed * 2654435761) >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x100000000
  }
}

const IDENTITY_FIELDS = ["version", "resolved", "integrity"] as const

const PACKAGES = ["alpha", "beta", "gamma", "@scope/delta", "epsilon"]
const VERSIONS = ["1.0.0", "1.2.0", "1.5.0", "2.0.0", "2.0.0-beta.1", "10.0.0"]

interface GeneratedLockfile {
  document: Record<string, any>
  text: string
}

function randomEntry(random: () => number, name: string): Record<string, any> {
  const version = VERSIONS[Math.floor(random() * VERSIONS.length)] as string
  const entry: Record<string, any> = {version}

  // Some entries omit resolved or integrity, as real lockfiles do for links
  if (random() < 0.85) entry.resolved = `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`
  if (random() < 0.85) entry.integrity = `sha512-${name}-${version}-${Math.floor(random() * 3)}`
  if (random() < 0.3) entry.dev = random() < 0.5
  if (random() < 0.2) entry.license = random() < 0.5 ? "MIT" : "Apache-2.0"
  if (random() < 0.25) {
    const dependency = PACKAGES[Math.floor(random() * PACKAGES.length)] as string
    entry.dependencies = {[dependency]: random() < 0.5 ? "^1.0.0" : "^2.0.0"}
  }

  return entry
}

function randomLockfile(random: () => number): GeneratedLockfile {
  const rootDependencies: Record<string, string> = {}
  const packages: Record<string, any> = {}

  for (const name of PACKAGES) {
    if (random() < 0.2) continue // package absent on this branch
    packages[`node_modules/${name}`] = randomEntry(random, name)
    if (random() < 0.6) rootDependencies[name] = random() < 0.5 ? "^1.0.0" : "*"
    if (random() < 0.15) {
      packages[`node_modules/${name}/node_modules/nested`] = randomEntry(random, "nested")
    }
  }

  const document = {
    name: "app",
    version: "1.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: {"": {name: "app", version: "1.0.0", dependencies: rootDependencies}, ...packages},
  }

  return {document, text: JSON.stringify(document, null, 2)}
}

/** Identity triple of an entry, with absent fields marked distinctly */
function identityOf(entry: Record<string, any> | undefined): string {
  if (entry === undefined) return "<absent>"
  return IDENTITY_FIELDS.map(field => (field in entry ? JSON.stringify(entry[field]) : "<none>")).join("|")
}

/**
 * The core anti-EINTEGRITY property: when two branches disagree about any
 * identity field of an entry, the merged entry must take its whole identity
 * from a single branch — never a field from one and a field from the other.
 */
function assertIdentityNotMixed(
  path: string,
  merged: Record<string, any>,
  ours: Record<string, any> | undefined,
  theirs: Record<string, any> | undefined,
  context: string
): void {
  const conflicting = IDENTITY_FIELDS.some(
    field => ours?.[field] !== undefined && theirs?.[field] !== undefined && !Object.is(ours[field], theirs[field])
  )

  if (!conflicting) {
    // No disagreement: every identity field must still come from a branch
    for (const field of IDENTITY_FIELDS) {
      if (merged[field] === undefined) continue
      const fromOurs = ours?.[field] !== undefined && Object.is(merged[field], ours[field])
      const fromTheirs = theirs?.[field] !== undefined && Object.is(merged[field], theirs[field])
      assert(fromOurs || fromTheirs, `${context}: ${path}.${field} was invented (${merged[field]})`)
    }
    return
  }

  const mergedIdentity = identityOf(merged)
  assert(
    mergedIdentity === identityOf(ours) || mergedIdentity === identityOf(theirs),
    `${context}: ${path} mixes identity fields across branches\n` +
      `  ours:   ${identityOf(ours)}\n  theirs: ${identityOf(theirs)}\n  merged: ${mergedIdentity}`
  )
}

describe("merge invariants (property-based)", () => {
  test("a package entry never mixes version, resolved and integrity across branches", async () => {
    let checkedEntries = 0

    for (let seed = 1; seed <= 60; seed++) {
      const random = makeRandom(seed)
      const base = randomLockfile(random)
      const ours = randomLockfile(random)
      const theirs = randomLockfile(random)

      for (const strategy of STRATEGIES) {
        for (const baseText of [base.text, ""]) {
          const result = await makeResolver(strategy).mergeJsonContents(baseText, ours.text, theirs.text)
          assert.equal(result.resolved, true, `seed ${seed}/${strategy}: ${result.errors.join(", ")}`)

          const context = `seed ${seed}, strategy ${strategy}, ${baseText === "" ? "no base" : "with base"}`
          for (const [path, entry] of Object.entries<any>(result.packageJson!.packages)) {
            if (path === "") continue
            assertIdentityNotMixed(path, entry, ours.document.packages[path], theirs.document.packages[path], context)
            checkedEntries++
          }
        }
      }
    }

    assert(checkedEntries > 1000, `expected broad coverage, only checked ${checkedEntries} entries`)
  })

  test("every merged entry is present on at least one branch", async () => {
    for (let seed = 1; seed <= 40; seed++) {
      const random = makeRandom(seed + 500)
      const ours = randomLockfile(random)
      const theirs = randomLockfile(random)

      for (const strategy of STRATEGIES) {
        const result = await makeResolver(strategy).mergeJsonContents("", ours.text, theirs.text)
        const mergedPaths = Object.keys(result.packageJson!.packages)
        const union = new Set([...Object.keys(ours.document.packages), ...Object.keys(theirs.document.packages)])

        assert.deepEqual(
          new Set(mergedPaths),
          union,
          `seed ${seed}/${strategy}: merged entries must be exactly the union when there is no base`
        )
      }
    }
  })

  test("merging a branch with itself returns it unchanged", async () => {
    for (let seed = 1; seed <= 40; seed++) {
      const random = makeRandom(seed + 900)
      const base = randomLockfile(random)
      const side = randomLockfile(random)

      for (const strategy of STRATEGIES) {
        const result = await makeResolver(strategy).mergeJsonContents(base.text, side.text, side.text)
        assert.deepEqual(result.packageJson, side.document, `seed ${seed}/${strategy}`)
        assert.equal(result.conflicts.length, 0, `seed ${seed}/${strategy}: identical sides are not conflicts`)
      }
    }
  })

  test("a merge is deterministic and re-merging its own result is a no-op", async () => {
    for (let seed = 1; seed <= 30; seed++) {
      const random = makeRandom(seed + 1300)
      const base = randomLockfile(random)
      const ours = randomLockfile(random)
      const theirs = randomLockfile(random)

      for (const strategy of STRATEGIES) {
        const first = await makeResolver(strategy).mergeJsonContents(base.text, ours.text, theirs.text)
        const second = await makeResolver(strategy).mergeJsonContents(base.text, ours.text, theirs.text)
        assert.deepEqual(second.packageJson, first.packageJson, `seed ${seed}/${strategy}: not deterministic`)

        // Feeding the merged result back in must be stable
        const mergedText = JSON.stringify(first.packageJson, null, 2)
        const again = await makeResolver(strategy).mergeJsonContents(mergedText, mergedText, mergedText)
        assert.deepEqual(again.packageJson, first.packageJson, `seed ${seed}/${strategy}: not idempotent`)
      }
    }
  })

  test("one-sided changes are always kept, whatever the strategy", async () => {
    for (let seed = 1; seed <= 40; seed++) {
      const random = makeRandom(seed + 1700)
      const base = randomLockfile(random)
      const theirs = randomLockfile(random)

      for (const strategy of STRATEGIES) {
        // Ours is byte-identical to base: their side must win entirely
        const result = await makeResolver(strategy).mergeJsonContents(base.text, base.text, theirs.text)
        assert.deepEqual(result.packageJson, theirs.document, `seed ${seed}/${strategy}: theirs must win outright`)
        assert.equal(result.conflicts.length, 0, `seed ${seed}/${strategy}`)

        // ...and symmetrically
        const mirrored = await makeResolver(strategy).mergeJsonContents(base.text, theirs.text, base.text)
        assert.deepEqual(mirrored.packageJson, theirs.document, `seed ${seed}/${strategy}: ours must win outright`)
      }
    }
  })

  test("the consistency report matches reality when both branches were consistent", async () => {
    let reportedClean = 0
    let reportedBroken = 0

    for (let seed = 1; seed <= 80; seed++) {
      const random = makeRandom(seed + 2100)
      const ours = randomLockfile(random)
      const theirs = randomLockfile(random)

      // Only compare when neither input was already broken, since pre-existing
      // problems are deliberately excluded from the report
      if (validateLockfile(ours.document).length > 0 || validateLockfile(theirs.document).length > 0) continue

      for (const strategy of STRATEGIES) {
        const result = await makeResolver(strategy).mergeJsonContents("", ours.text, theirs.text)
        const actual = validateLockfile(result.packageJson as Record<string, any>)

        assert.deepEqual(
          result.lockfileIssues!.map(issue => issue.message).sort(),
          actual.map(issue => issue.message).sort(),
          `seed ${seed}/${strategy}: the report must match a fresh validation`
        )

        if (actual.length === 0) reportedClean++
        else reportedBroken++
      }
    }

    assert(reportedClean > 0, "expected some consistent merges")
    assert(reportedBroken > 0, "expected some merges that break the graph, or the generator is too tame")
  })

  test("never throws, whatever it is handed", async () => {
    const nasty = [
      "",
      "   ",
      "null",
      "[]",
      '"a string"',
      "42",
      "true",
      "{",
      "not json",
      '{"packages": null}',
      '{"packages": []}',
      '{"packages": {"": null}}',
      '{"lockfileVersion": "three", "packages": {}}',
      '{"packages": {"node_modules/a": "not an object"}}',
      '{"packages": {"node_modules/a": {"version": null}}}',
      JSON.stringify({packages: {"node_modules/a": {version: "1.0.0", dependencies: {b: 42}}}, lockfileVersion: 3}),
    ]

    for (const ourText of nasty) {
      for (const theirText of nasty) {
        for (const strategy of STRATEGIES) {
          const resolver = makeResolver(strategy)
          let result
          try {
            result = await resolver.mergeJsonContents("", ourText, theirText)
          } catch (error) {
            assert.fail(`threw for (${JSON.stringify(ourText)}, ${JSON.stringify(theirText)}): ${error}`)
          }
          // Failure must be reported, never thrown
          assert.equal(typeof result.resolved, "boolean", `unexpected shape for (${ourText}, ${theirText})`)
          if (!result.resolved) {
            assert(result.errors.length > 0, `unresolved merges must explain why (${ourText}, ${theirText})`)
          }
        }
      }
    }
  })

  test("conflict-marker resolution never invents a document it cannot re-parse", async () => {
    for (let seed = 1; seed <= 40; seed++) {
      const random = makeRandom(seed + 2600)
      const ours = randomLockfile(random)
      const theirs = randomLockfile(random)

      // Splice the two documents into a single conflicted file
      const conflicted = ["<<<<<<< HEAD", ours.text, "=======", theirs.text, ">>>>>>> feature"].join("\n")

      for (const strategy of STRATEGIES) {
        const result = await makeResolver(strategy).resolveConflicts(conflicted)
        assert.equal(result.resolved, true, `seed ${seed}/${strategy}: ${result.errors.join(", ")}`)

        // Whatever comes out must survive a serialize/parse round trip
        const serialized = JSON.stringify(result.packageJson)
        assert.doesNotThrow(() => JSON.parse(serialized), `seed ${seed}/${strategy}`)

        for (const [path, entry] of Object.entries<any>(result.packageJson!.packages)) {
          if (path === "") continue
          assertIdentityNotMixed(
            path,
            entry,
            ours.document.packages[path],
            theirs.document.packages[path],
            `seed ${seed}, strategy ${strategy}, marker path`
          )
        }
      }
    }
  })
})
