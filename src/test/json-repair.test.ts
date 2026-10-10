/**
 * Tests for lenient JSON parsing of documents stitched together from a
 * line-based Git merge, where a comma can go missing or be left over at the
 * boundary of a conflict region.
 */

import {strict as assert} from "assert"
import {test, describe} from "node:test"
import {parseJsonLenient, repairCommas, stripTrailingCommas} from "../json-repair.js"
import {PackageResolver} from "../package-resolver.js"

/** The error `fn` throws */
function errorOf(fn: () => unknown): Error {
  try {
    fn()
  } catch (error) {
    return error as Error
  }
  return assert.fail("expected an error")
}

describe("parseJsonLenient", () => {
  test("parses valid JSON unchanged", () => {
    assert.deepEqual(parseJsonLenient('{"a": [1, 2], "b": {"c": null}}'), {a: [1, 2], b: {c: null}})
  })

  test("inserts a missing comma between two properties", () => {
    const text = [
      "{",
      '  "version": "4.17.21"',
      '  "resolved": "https://r/lodash-4.17.21.tgz",',
      '  "integrity": "sha512-x"',
      "}",
    ].join("\n")
    assert.deepEqual(parseJsonLenient(text), {
      version: "4.17.21",
      resolved: "https://r/lodash-4.17.21.tgz",
      integrity: "sha512-x",
    })
  })

  test("inserts a missing comma after every kind of value", () => {
    const text = [
      "{",
      '"s": "x"',
      '"n": 1',
      '"t": true',
      '"f": false',
      '"z": null',
      '"o": {"k": 1}',
      '"a": [1]',
      '"last": 2',
      "}",
    ].join("\n")
    assert.deepEqual(parseJsonLenient(text), {s: "x", n: 1, t: true, f: false, z: null, o: {k: 1}, a: [1], last: 2})
  })

  test("inserts a missing comma between two lockfile entries", () => {
    // The typical artifact: our side ended the "packages" object, theirs added entries after it
    const text = [
      "{",
      '  "packages": {',
      '    "node_modules/a": {',
      '      "version": "1.0.0"',
      "    }",
      '    "node_modules/b": {',
      '      "version": "2.0.0"',
      "    }",
      "  }",
      "}",
    ].join("\n")
    assert.deepEqual(parseJsonLenient(text), {
      packages: {"node_modules/a": {version: "1.0.0"}, "node_modules/b": {version: "2.0.0"}},
    })
  })

  test("removes trailing commas before closing braces and brackets", () => {
    assert.deepEqual(parseJsonLenient('{"a": 1,\n}'), {a: 1})
    assert.deepEqual(parseJsonLenient('{"a": [1, 2,]}'), {a: [1, 2]})
    assert.deepEqual(parseJsonLenient('{"a": {"b": 1,},}'), {a: {b: 1}})
  })

  test("repairs a missing and a trailing comma in the same document", () => {
    const text = ["{", '  "a": 1', '  "b": 2,', "}"].join("\n")
    assert.deepEqual(parseJsonLenient(text), {a: 1, b: 2})
  })

  test("never touches string contents", () => {
    const text = ["{", '  "build": "node -e \\"x({a:1,})\\""', '  "odd": "a,}",', '  "arr": "[1,]"', "}"].join("\n")
    assert.deepEqual(parseJsonLenient(text), {build: 'node -e "x({a:1,})"', odd: "a,}", arr: "[1,]"})
  })

  test("throws the original error for anything it cannot repair", () => {
    for (const bad of ['{"a" 1}', "not json", '{"a": 1 "b"', "", '{"a": 1 // comment\n}']) {
      assert.throws(() => parseJsonLenient(bad), SyntaxError)
    }
  })

  test("does not turn two adjacent values into valid JSON when a colon is missing", () => {
    assert.throws(() => parseJsonLenient('{"a" "b"}'), SyntaxError)
  })

  test("throws the error of the text as given, not of the repaired text", () => {
    // A comma cannot stand in for the missing colon, and the repaired text fails elsewhere
    const text = '{"a" 1}'
    const original = errorOf(() => JSON.parse(text))
    assert.notEqual(errorOf(() => JSON.parse(repairCommas(text))).message, original.message)
    assert.throws(() => parseJsonLenient(text), {name: "SyntaxError", message: original.message})
  })
})

describe("repairCommas", () => {
  test("puts a missing comma right after the value and leaves the whitespace as it was", () => {
    assert.equal(repairCommas('{\r\n  "a": 1\r\n  "b": 2\r\n}'), '{\r\n  "a": 1,\r\n  "b": 2\r\n}')
    assert.equal(repairCommas('["x"   \n\t "y"]'), '["x",   \n\t "y"]')
    assert.equal(repairCommas("[{}\n[]\ntrue\n-1\nnull]"), "[{},\n[],\ntrue,\n-1,\nnull]")
  })

  test("repairs values that touch when the boundary between them is plain", () => {
    const cases: Array<[string, unknown]> = [
      ['["a""b"]', ["a", "b"]],
      ["[{}{}]", [{}, {}]],
      ["[[][]]", [[], []]],
      ['[1"a"]', [1, "a"]],
      ['["a"1]', ["a", 1]],
      ["[true{}]", [true, {}]],
      ["[null[]]", [null, []]],
      ['{"a":1"b":2}', {a: 1, b: 2}],
      ['{"a":{}"b":[]}', {a: {}, b: []}],
    ]
    for (const [text, expected] of cases) {
      assert.deepEqual(parseJsonLenient(text), expected, text)
    }
  })

  test("takes every form of JSON number and true/false/null as a value", () => {
    const expected = [-1, 0, 0.5, 10, 1e5, -2.5e-3, 700, true, false, null]
    assert.deepEqual(parseJsonLenient("[-1 0 0.5 10 1e5 -2.5E-3 7E+2 true false null]"), expected)
  })

  test("never splits a token to make a document parse", () => {
    // "01" is one malformed number, not 0 and 1, and "truefalse" is not two literals
    for (const text of ["[01]", "[truefalse]", "[1true]", "[nulltrue]", "[-1-2]", "[1.5.5]", "[0x1F]", "[NaN 1]"]) {
      assert.equal(repairCommas(text), text)
      assert.throws(() => parseJsonLenient(text), SyntaxError, text)
    }
  })

  test("never makes two top-level values parse", () => {
    for (const text of ["{} {}", "1 2", '"a" "b"', "[]\n{}"]) {
      assert.throws(() => parseJsonLenient(text), SyntaxError, text)
    }
  })

  test("reads strings to their real end, whatever they contain", () => {
    // An escaped backslash ends the first string here; escaped quotes do not
    assert.deepEqual(parseJsonLenient('["a\\\\" "b"]'), ["a\\", "b"])
    assert.deepEqual(parseJsonLenient('["say \\"hi\\"" "b"]'), ['say "hi"', "b"])
    assert.deepEqual(parseJsonLenient('{"a": "1 2, [3 4] {}" "b": "x"}'), {a: "1 2, [3 4] {}", b: "x"})
  })

  test("repairs nothing after a string that is never closed", () => {
    const text = '["open, 1 2,]'
    assert.equal(repairCommas(text), text)
    assert.throws(() => parseJsonLenient(text), SyntaxError)
  })

  test("never accepts what JSON does not allow", () => {
    // Whitespace JSON does not know, comments, single quotes and trailing text still fail
    for (const text of ["[1\u00a02]", '{"a": 1 // note\n"b": 2}', "{'a': 1 'b': 2}", "[1 2] more"]) {
      assert.throws(() => parseJsonLenient(text), SyntaxError, JSON.stringify(text))
    }
  })
})

describe("stripTrailingCommas", () => {
  test("drops commas that precede a closing bracket, outside strings only", () => {
    assert.equal(stripTrailingCommas('{"a": 1, }'), '{"a": 1 }')
    assert.equal(stripTrailingCommas("[1,\n]"), "[1\n]")
    assert.equal(stripTrailingCommas('{"s": ",}", "t": "\\",}"}'), '{"s": ",}", "t": "\\",}"}')
  })

  test("keeps commas that separate values", () => {
    assert.equal(stripTrailingCommas('{"a": 1, "b": 2}'), '{"a": 1, "b": 2}')
  })

  test("never inserts a comma", () => {
    assert.equal(stripTrailingCommas('{"a": 1\n"b": 2,\n}'), '{"a": 1\n"b": 2\n}')
  })
})

/**
 * Deterministic PRNG so a failure is always reproducible from its seed.
 */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x100000000
  }
}

/** Build a random JSON document shaped like the files this tool handles */
function randomDocument(random: () => number, depth = 0): unknown {
  const roll = random()

  if (depth >= 3 || roll < 0.25) {
    const leaf = random()
    if (leaf < 0.35) {
      // Strings deliberately contain characters that must never be touched
      const nasty = ["a,b", "}", '{"x": 1,}', "back\\slash", 'quote"inside', "line\nbreak", "", "1.2.3", "^4.17.21"]
      return nasty[Math.floor(random() * nasty.length)]
    }
    if (leaf < 0.55) return Math.floor(random() * 2000) - 1000
    if (leaf < 0.65) return random() * 10
    if (leaf < 0.8) return random() < 0.5
    if (leaf < 0.9) return null
    return `sha512-${Math.floor(random() * 1e6)}`
  }

  if (roll < 0.45) {
    const length = Math.floor(random() * 4)
    return Array.from({length}, () => randomDocument(random, depth + 1))
  }

  const keys = ["version", "resolved", "integrity", "dependencies", "node_modules/pkg", "a,b", "dev", ""]
  const size = Math.floor(random() * 5)
  const object: Record<string, unknown> = {}
  for (let i = 0; i < size; i++) {
    const key = `${keys[Math.floor(random() * keys.length)]}${i}`
    object[key] = randomDocument(random, depth + 1)
  }
  return object
}

/**
 * Positions of characters that sit outside string literals. Commas and
 * brackets inside a string are data, and damaging one of those would change
 * the document rather than simulate a merge artifact.
 */
function structuralPositions(text: string, predicate: (char: string) => boolean): number[] {
  const positions: number[] = []
  let inString = false

  for (let i = 0; i < text.length; i++) {
    const char = text[i] as string
    if (inString) {
      if (char === "\\") i++
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (predicate(char)) positions.push(i)
  }

  return positions
}

const structuralCommaPositions = (text: string) => structuralPositions(text, char => char === ",")

/** Closing brackets that follow a value: a stray comma before one of them is a trailing comma */
const closersAfterValues = (text: string) =>
  structuralPositions(text, char => char === "}" || char === "]").filter(i => {
    const previous = text.slice(0, i).trimEnd().slice(-1)
    return previous !== "{" && previous !== "[" && previous !== ""
  })

/** `text` without the characters at `removed`, and with a comma put before each index in `strayBefore` */
function damage(text: string, removed: ReadonlySet<number>, strayBefore: ReadonlySet<number> = new Set()): string {
  let result = ""
  for (let i = 0; i < text.length; i++) {
    if (strayBefore.has(i)) result += ","
    if (!removed.has(i)) result += text[i]
  }
  return result
}

describe("parseJsonLenient property tests", () => {
  test("valid JSON always round-trips unchanged", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const random = makeRandom(seed)
      const document = randomDocument(random)
      for (const indent of [0, 2, 4, "\t"]) {
        const text = JSON.stringify(document, null, indent as any)
        assert.deepEqual(parseJsonLenient(text), JSON.parse(text), `seed ${seed}, indent ${indent}`)
      }
    }
  })

  test("valid JSON is left byte for byte unchanged by the repair", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const document = randomDocument(makeRandom(seed))
      for (const indent of [0, 2, 4, "\t"]) {
        const text = JSON.stringify(document, null, indent as any)
        assert.equal(repairCommas(text), text, `seed ${seed}, indent ${indent}`)
      }
    }
  })

  test("removing any single structural comma is repaired back to the original", () => {
    let checked = 0

    for (let seed = 1; seed <= 200; seed++) {
      const random = makeRandom(seed)
      const document = randomDocument(random)
      const text = JSON.stringify(document, null, 2)
      const commas = structuralCommaPositions(text)

      for (const position of commas) {
        const damaged = text.slice(0, position) + text.slice(position + 1)
        assert.deepEqual(
          parseJsonLenient(damaged),
          document,
          `seed ${seed}: removing the comma at ${position} was not repaired\n${damaged}`
        )
        checked++
      }
    }

    assert(checked > 200, `expected a meaningful number of cases, got ${checked}`)
  })

  test("removing many structural commas at once is repaired back to the original", () => {
    let checked = 0

    for (let seed = 1; seed <= 300; seed++) {
      const random = makeRandom(seed)
      const document = randomDocument(random)
      const text = JSON.stringify(document, null, 2)
      const removed = new Set(structuralCommaPositions(text).filter(() => random() < 0.5))
      if (removed.size < 2) continue

      const damaged = damage(text, removed)
      assert.deepEqual(parseJsonLenient(damaged), document, `seed ${seed}\n${damaged}`)
      checked++
    }

    assert(checked > 50, `expected a meaningful number of cases, got ${checked}`)
  })

  test("commas removed between values that touch are repaired back to the original", () => {
    // Compact JSON, where only a plain boundary such as "a""b", 1"a" or }{ is meaningful:
    // without its comma, [1,2] becomes [12], which is valid and means something else
    let checked = 0

    for (let seed = 1; seed <= 300; seed++) {
      const random = makeRandom(seed)
      const document = randomDocument(random)
      const text = JSON.stringify(document)
      const plain = structuralCommaPositions(text).filter(
        i => '"}]'.includes(text[i - 1] as string) || '"{['.includes(text[i + 1] as string)
      )
      if (plain.length === 0) continue

      const damaged = damage(text, new Set(plain))
      assert.deepEqual(parseJsonLenient(damaged), document, `seed ${seed}\n${damaged}`)
      checked++
    }

    assert(checked > 50, `expected a meaningful number of cases, got ${checked}`)
  })

  test("a stray comma before any closing bracket is repaired back to the original", () => {
    let checked = 0

    for (let seed = 1; seed <= 200; seed++) {
      const random = makeRandom(seed)
      const document = randomDocument(random)
      const text = JSON.stringify(document, null, 2)

      for (const i of closersAfterValues(text)) {
        const damaged = `${text.slice(0, i)},${text.slice(i)}`
        assert.deepEqual(parseJsonLenient(damaged), document, `seed ${seed}: stray comma before index ${i}\n${damaged}`)
        checked++
      }
    }

    assert(checked > 200, `expected a meaningful number of cases, got ${checked}`)
  })

  test("missing and stray commas in the same document are all repaired in one pass", () => {
    let checked = 0

    for (let seed = 1; seed <= 300; seed++) {
      const random = makeRandom(seed)
      const document = randomDocument(random)
      const text = JSON.stringify(document, null, 2)
      const removed = new Set(structuralCommaPositions(text).filter(() => random() < 0.4))
      const strayBefore = new Set(closersAfterValues(text).filter(() => random() < 0.4))
      if (removed.size === 0 || strayBefore.size === 0) continue

      const damaged = damage(text, removed, strayBefore)
      assert.deepEqual(parseJsonLenient(damaged), document, `seed ${seed}\n${damaged}`)
      checked++
    }

    assert(checked > 50, `expected a meaningful number of cases, got ${checked}`)
  })

  test("never invents a parse for structurally broken input", () => {
    const broken = [
      '{"a": 1',
      '{"a"}',
      '{"a": }',
      "[1, 2",
      '{"a": 1} extra',
      '{"a": "unterminated}',
      "{'a': 1}",
      "undefined",
      "{a: 1}",
      '{"a": 01}',
      '{"a": +1}',
      '{"a": .5}',
      "[,]",
      "{,}",
    ]

    for (const text of broken) {
      assert.throws(() => parseJsonLenient(text), SyntaxError, `should not have parsed: ${text}`)
    }
  })

  test("repairs any number of missing commas at once", () => {
    // A large merge can leave a comma missing at every conflict boundary
    for (const count of [900, 5000]) {
      const entries = Array.from({length: count}, (_, i) => `  "key${i}": ${i}`).join("\n")
      const parsed = parseJsonLenient(`{\n${entries}\n}`)
      assert.equal(Object.keys(parsed).length, count)
      assert.equal(parsed[`key${count - 1}`], count - 1)
    }
  })

  test("a comma with no value before it is not repaired away", () => {
    // An element is genuinely missing here; guessing would invent data
    for (const text of ["[,]", "{,}", '{"x": 1,,}', "[1,,2]", "[,1]"]) {
      assert.throws(() => parseJsonLenient(text), SyntaxError, `should not have parsed: ${text}`)
    }
  })
})

/**
 * Engines word JSON syntax errors differently: V8 reports "Expected ',' or '}'
 * after property value in JSON at position 9", older engines "Unexpected
 * string in JSON at position 9", and some name no position at all. The repair
 * reads the text, not the message, so these tests replay V8's errors in other
 * wordings to check that the message makes no difference.
 */
describe("parseJsonLenient whatever the engine's error messages say", () => {
  const parse = JSON.parse

  /** Run `fn` while every error JSON.parse throws carries a rewritten message */
  function withMessages(rewrite: (message: string) => string, fn: () => void): void {
    JSON.parse = ((text: string, reviver?: (this: any, key: string, value: any) => any) => {
      try {
        return parse(text, reviver)
      } catch (error) {
        throw new SyntaxError(rewrite((error as Error).message))
      }
    }) as typeof JSON.parse
    try {
      fn()
    } finally {
      JSON.parse = parse
    }
  }

  const wordings: Array<[string, (message: string) => string]> = [
    [
      "an older engine's wording",
      message =>
        message.replace(
          /^Expected ',' or '[}\]]' after \w+ \w+ in JSON at (position \d+).*$/s,
          "Unexpected string in JSON at $1"
        ),
    ],
    ["no position", message => message.replace(/ in JSON at position \d+.*$/s, "")],
    ["a wrong position", message => message.replace(/position \d+.*$/s, "position 5")],
    ["an unrelated message", () => "JSON Parse error: Unexpected identifier"],
  ]

  test("repairs comma artifacts whatever the message says", () => {
    for (const [wording, rewrite] of wordings) {
      withMessages(rewrite, () => {
        assert.deepEqual(parseJsonLenient('{"a": "x"\n"b": "y",\n}'), {a: "x", b: "y"}, wording)
      })
    }
  })

  test("rethrows the engine's own error when the text cannot be repaired", () => {
    withMessages(
      message => `engine says: ${message}`,
      () => {
        const text = '{"a" 1}'
        const expected = errorOf(() => JSON.parse(text)).message
        assert.throws(() => parseJsonLenient(text), {name: "SyntaxError", message: expected})
      }
    )
  })
})

/** A lockfile shaped like the ones npm writes, with `count` installed packages */
function lockfileText(count: number): string {
  const packages: Record<string, unknown> = {"": {name: "app", version: "1.0.0"}}
  for (let i = 0; i < count; i++) {
    packages[`node_modules/pkg-${i}`] = {
      version: `1.0.${i}`,
      resolved: `https://registry.npmjs.org/pkg-${i}/-/pkg-${i}-1.0.${i}.tgz`,
      integrity: `sha512-${"a".repeat(86)}==`,
      dependencies: {a: "^1.0.0", b: "^2.0.0"},
    }
  }
  return JSON.stringify({name: "app", version: "1.0.0", lockfileVersion: 3, requires: true, packages}, null, 2)
}

/**
 * Real lockfiles run to several megabytes. The repair takes tens of
 * milliseconds on these documents; work that grew with size times the number
 * of commas took minutes, so the generous time limits only catch that.
 */
describe("parseJsonLenient on large documents", () => {
  test("repairs a multi-megabyte lockfile in time linear in its size", () => {
    const text = lockfileText(10_000)
    // A comma missing between two entries halfway through, and a stray one after the last entry
    const middle = text.indexOf('},\n    "node_modules/pkg-5000"')
    const end = text.lastIndexOf("\n  }")
    assert(middle !== -1 && end !== -1)
    const damaged = `${text.slice(0, middle + 1)}${text.slice(middle + 2, end)},${text.slice(end)}`

    const started = performance.now()
    const parsed = parseJsonLenient(damaged)
    const elapsed = performance.now() - started

    assert.deepEqual(parsed, JSON.parse(text))
    assert(elapsed < 1000, `${(damaged.length / 1e6).toFixed(1)} MB took ${Math.round(elapsed)} ms`)
  })

  test("repairs a missing comma after each of 100,000 entries in time linear in their number", () => {
    const entries = Array.from({length: 100_000}, (_, i) => `  "key${i}": ${i}`).join("\n")

    const started = performance.now()
    const parsed = parseJsonLenient(`{\n${entries}\n}`)
    const elapsed = performance.now() - started

    assert.equal(Object.keys(parsed).length, 100_000)
    assert(elapsed < 1000, `took ${Math.round(elapsed)} ms`)
  })

  test("resolves a multi-megabyte conflicted lockfile whose sides need repair", async () => {
    const entry = (name: string, version: string) =>
      [
        `    "node_modules/${name}": {`,
        `      "version": "${version}",`,
        `      "resolved": "https://registry.npmjs.org/${name}/-/${name}-${version}.tgz",`,
        `      "integrity": "sha512-${"a".repeat(86)}=="`,
        "    }",
      ].join("\n")
    const shared = Array.from({length: 8000}, (_, i) => entry(`pkg-${i}`, "1.0.0")).join(",\n")
    // Each side ends its part of "packages" without a comma, yet another entry follows the conflict
    const text = [
      "{",
      '  "name": "app",',
      '  "lockfileVersion": 3,',
      '  "requires": true,',
      '  "packages": {',
      `${shared},`,
      "<<<<<<< HEAD",
      entry("zz-ours", "1.0.0"),
      "=======",
      entry("zz-theirs", "2.0.0"),
      ">>>>>>> feature",
      entry("zzz-after", "3.0.0"),
      "  }",
      "}",
      "",
    ].join("\n")
    const resolver = new PackageResolver({
      strategy: "highest",
      dryRun: true,
      quiet: true,
      json: false,
      verbose: false,
      regenerateLock: false,
    })

    const started = performance.now()
    const result = await resolver.resolveConflicts(text)
    const elapsed = performance.now() - started

    assert.equal(result.resolved, true, result.errors.join(", "))
    const names = Object.keys(result.packageJson!.packages)
    assert.equal(names.length, 8003)
    assert.deepEqual(names.slice(-3), ["node_modules/zz-ours", "node_modules/zzz-after", "node_modules/zz-theirs"])
    assert(elapsed < 5000, `${(text.length / 1e6).toFixed(1)} MB took ${Math.round(elapsed)} ms`)
  })
})
