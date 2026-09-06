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
