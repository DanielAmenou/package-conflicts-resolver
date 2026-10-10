/**
 * ConflictParser.enclosingPath: locating a conflict inside the JSON document
 * from the text above it, which is how the block-based fallback tells a
 * dependency spec or a lockfile entry from any other object.
 */

import {strict as assert} from "assert"
import {test, describe} from "node:test"
import {ConflictParser} from "../conflict-parser.js"

/** The path of the object holding the line that contains "HERE" */
function pathAt(lines: string[]): string[] | undefined {
  const index = lines.findIndex(line => line.includes("HERE"))
  assert(index >= 0, "the fixture marks a line with HERE")
  return ConflictParser.enclosingPath(lines.join("\n"), index)
}

describe("ConflictParser.enclosingPath", () => {
  test("the top level of the document is the empty path", () => {
    assert.deepEqual(pathAt(["{", '  "name": "app",', '  "HERE": 1', "}"]), [])
  })

  test("follows nested objects, including the lockfile root entry's empty key", () => {
    const lines = [
      "{",
      '  "name": "app",',
      '  "packages": {',
      '    "": {',
      '      "name": "app",',
      '      "dependencies": {',
      '        "HERE": "^1.0.0"',
      "      }",
      "    }",
      "  }",
      "}",
    ]
    assert.deepEqual(pathAt(lines), ["packages", "", "dependencies"])
  })

  test("skips objects that are already closed above the line", () => {
    const lines = [
      "{",
      '  "packages": {',
      '    "node_modules/a": {',
      '      "version": "1.0.0",',
      '      "dependencies": {"x": "1"}',
      "    },",
      '    "node_modules/b": {"version": "2.0.0"},',
      '    "HERE": {}',
      "  }",
      "}",
    ]
    assert.deepEqual(pathAt(lines), ["packages"])
  })

  test("brackets inside strings, and escaped quotes, do not count", () => {
    const lines = ["{", '  "scripts": {', '    "weird": "echo \\"}\\" { [ ]",', '    "HERE": "x"', "  },", "}"]
    assert.deepEqual(pathAt(lines), ["scripts"])
  })

  test("keys with escapes are decoded, and a key that is not valid JSON is kept as written", () => {
    assert.deepEqual(pathAt(["{", '  "a\\u0062": {', '    "HERE": 1', "  }", "}"]), ["ab"])
    assert.deepEqual(pathAt(["{", '  "bad\\x": {', '    "HERE": 1', "  }", "}"]), ["bad\\x"])
  })

  test("an object on the same line as its key's value, or several per line", () => {
    assert.deepEqual(pathAt(["{", '  "a": {"b": {', '    "HERE": 1', "  }}", "}"]), ["a", "b"])
    assert.deepEqual(pathAt(['{"a": {', '    "HERE": 1', "}}"]), ["a"])
  })

  test("conflicts above count with their ours side only", () => {
    const lines = [
      "{",
      "<<<<<<< HEAD",
      '  "dependencies": {',
      "||||||| base",
      '  "devDependencies": { "x": "1" } } } }',
      "=======",
      '  "peerDependencies": {',
      "  } } }",
      ">>>>>>> feature",
      '    "HERE": "^1.0.0"',
      "  }",
      "}",
    ]
    assert.deepEqual(pathAt(lines), ["dependencies"])
  })

  test("an unterminated conflict above is plain text", () => {
    const lines = ["{", "<<<<<<< HEAD", '  "a": {', "=======", '    "HERE": 1', "  }", "}"]
    // No end marker: every line counts, so "a" encloses the line
    assert.deepEqual(pathAt(lines), ["a"])
  })

  test("marker-like lines follow the same rules as parseConflicts", () => {
    const lines = [
      "{",
      "<<<<<<< HEAD",
      '  "a": {',
      ">>>>>>> not an end yet, no middle marker seen",
      "|||||||",
      "|||||||",
      "  } }",
      "=======",
      "|||||||",
      '  "b": {',
      "=======",
      '  "c": {',
      ">>>>>>> feature",
      '    "HERE": 1',
      "  }",
      "}",
    ]
    // ours: '"a": {' and the end-marker-like line before the middle; the second middle marker restarts theirs
    assert.deepEqual(pathAt(lines), ["a"])
  })

  test("undefined inside an array, or when the text above is not the start of an object", () => {
    assert.equal(pathAt(["{", '  "list": [', "    {", '      "HERE": 1', "    }", "  ]", "}"]), undefined)
    assert.equal(pathAt(["[", "  {", '    "HERE": 1', "  }", "]"]), undefined)
    assert.equal(pathAt(['  "dependencies": {', '    "HERE": 1', "  }"]), undefined, "no root object")
    assert.equal(pathAt(["{", "  }", "  }", '  "HERE": 1']), undefined, "more closers than openers")
    assert.equal(pathAt(["{", '  "a": 1, {', '    "HERE": 1']), undefined, "an object without a key")
    assert.equal(ConflictParser.enclosingPath("", 0), undefined)
  })

  test("a line index past the end looks at the whole document", () => {
    assert.deepEqual(ConflictParser.enclosingPath('{\n  "a": {\n', 99), ["a"])
  })

  test("CRLF line endings", () => {
    const content = ["{", '  "dependencies": {', '    "x": "1"', "  }", "}"].join("\r\n")
    assert.deepEqual(ConflictParser.enclosingPath(content, 2), ["dependencies"])
  })
})
