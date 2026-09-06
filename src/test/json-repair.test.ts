/**
 * Tests for lenient JSON parsing of documents stitched together from a
 * line-based Git merge, where a comma can go missing or be left over at the
 * boundary of a conflict region.
 */

import {strict as assert} from "assert"
import {test, describe} from "node:test"
import {parseJsonLenient, stripTrailingCommas} from "../json-repair.js"

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

  test("a stray comma before any closing bracket is repaired back to the original", () => {
    let checked = 0

    for (let seed = 1; seed <= 200; seed++) {
      const random = makeRandom(seed)
      const document = randomDocument(random)
      const text = JSON.stringify(document, null, 2)

      for (const i of structuralPositions(text, char => char === "}" || char === "]")) {
        // Only meaningful after a value, i.e. when the container is not empty
        const previous = text.slice(0, i).trimEnd().slice(-1)
        if (previous === "{" || previous === "[" || previous === "") continue

        const damaged = `${text.slice(0, i)},${text.slice(i)}`
        assert.deepEqual(parseJsonLenient(damaged), document, `seed ${seed}: stray comma before index ${i}\n${damaged}`)
        checked++
      }
    }

    assert(checked > 200, `expected a meaningful number of cases, got ${checked}`)
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

  test("repairs many missing commas at once, and gives up beyond the budget", () => {
    // A large merge can leave a comma missing at every conflict boundary
    const entries = Array.from({length: 900}, (_, i) => `  "key${i}": ${i}`).join("\n")
    const missingEveryComma = `{\n${entries}\n}`

    const started = Date.now()
    assert.equal(Object.keys(parseJsonLenient(missingEveryComma)).length, 900)
    assert(Date.now() - started < 10_000, "repairing a heavily damaged document must not take forever")

    // Beyond the repair budget it gives up rather than looping
    const tooMany = `{\n${Array.from({length: 5000}, (_, i) => `  "key${i}": ${i}`).join("\n")}\n}`
    assert.throws(() => parseJsonLenient(tooMany), SyntaxError)
  })

  test("a comma with no value before it is not repaired away", () => {
    // An element is genuinely missing here; guessing would invent data
    for (const text of ["[,]", "{,}", '{"x": 1,,}', "[1,,2]", "[,1]"]) {
      assert.throws(() => parseJsonLenient(text), SyntaxError, `should not have parsed: ${text}`)
    }
  })
})
