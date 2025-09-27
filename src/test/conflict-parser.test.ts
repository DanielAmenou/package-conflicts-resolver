/**
 * Tests for ConflictParser
 */

import {strict as assert} from "assert"
import {test, describe} from "node:test"
import {ConflictParser} from "../conflict-parser.js"

describe("ConflictParser", () => {
  test("should detect conflicts in content", () => {
    const content = `{
  "name": "test",
<<<<<<< HEAD
  "version": "1.0.0"
=======
  "version": "2.0.0"
>>>>>>> feature
}`

    const hasConflicts = ConflictParser.hasConflicts(content)
    assert.equal(hasConflicts, true)
  })

  test("should parse conflict markers correctly", () => {
    const content = `{
  "name": "test",
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

    const conflicts = ConflictParser.parseConflicts(content)
    assert.equal(conflicts.length, 1)

    const conflict = conflicts[0]
    assert(conflict)
    assert.equal(conflict.start, 2)
    assert.equal(conflict.middle, 7)
    assert.equal(conflict.end, 12)
    assert(conflict.ours.includes('"version": "1.0.0"'))
    assert(conflict.theirs.includes('"version": "2.0.0"'))
  })

  test("should extract field name from conflict", () => {
    const conflictContent = '  "version": "1.0.0"'
    const fullContent = `{
  "name": "test",
  "version": "1.0.0"
}`
    const fieldName = ConflictParser.extractFieldName(conflictContent, fullContent, 2)
    assert.equal(fieldName, "version")
  })

  test("should parse partial JSON", () => {
    const content = `  "dependencies": {
    "lodash": "^4.17.21"
  }`

    const parsed = ConflictParser.parsePartialJson(content)
    assert.deepEqual(parsed, {
      dependencies: {
        lodash: "^4.17.21",
      },
    })
  })

  test("should handle invalid JSON gracefully", () => {
    const content = `  "version": "1.0.0"` // Missing quote
    const parsed = ConflictParser.parsePartialJson(content)
    assert.equal(typeof parsed, "object")
  })

  test("should remove conflict markers", () => {
    const content = `{
  "name": "test",
<<<<<<< HEAD
  "version": "1.0.0"
=======
  "version": "2.0.0"
>>>>>>> feature
}`

    const resolvedSections = new Map([[2, '  "version": "1.5.0"']])
    const result = ConflictParser.removeConflictMarkers(content, resolvedSections)

    assert(result.includes('"version": "1.5.0"'))
    assert(!result.includes("<<<<<<<"))
    assert(!result.includes("======="))
    assert(!result.includes(">>>>>>>"))
  })

  test("should handle multiple conflicts", () => {
    const content = `{
  "name": "test",
<<<<<<< HEAD
  "version": "1.0.0"
=======
  "version": "2.0.0"
>>>>>>> feature,
  "dependencies": {
<<<<<<< HEAD
    "lodash": "^4.17.21"
=======
    "lodash": "^4.17.20"
>>>>>>> feature
  }
}`

    const conflicts = ConflictParser.parseConflicts(content)
    assert.equal(conflicts.length, 2)

    assert(conflicts[0] && conflicts[0].ours.includes('"version": "1.0.0"'))
    assert(conflicts[1] && conflicts[1].ours.includes('"lodash": "^4.17.21"'))
  })

  test("should validate JSON", () => {
    assert.equal(ConflictParser.isValidJson('{"valid": "json"}'), true)
    assert.equal(ConflictParser.isValidJson("{invalid json}"), false)
    assert.equal(ConflictParser.isValidJson(""), false)
  })
})
