/**
 * Logger unit tests: human-readable, JSON, quiet, and verbose modes for
 * every log level, capturing console output.
 */

import {strict as assert} from "assert"
import {test, describe} from "node:test"
import {Logger} from "../logger.js"
import {LoggerOptions, ResolvedConflict} from "../types.js"

interface Captured {
  logs: string[]
  warns: string[]
  errors: string[]
}

function capture(fn: () => void): Captured {
  const captured: Captured = {logs: [], warns: [], errors: []}
  const original = {log: console.log, warn: console.warn, error: console.error}

  console.log = (...args: any[]) => captured.logs.push(args.join(" "))
  console.warn = (...args: any[]) => captured.warns.push(args.join(" "))
  console.error = (...args: any[]) => captured.errors.push(args.join(" "))

  try {
    fn()
  } finally {
    console.log = original.log
    console.warn = original.warn
    console.error = original.error
  }

  return captured
}

const HUMAN: LoggerOptions = {quiet: false, json: false, verbose: false}
const JSON_MODE: LoggerOptions = {quiet: false, json: true, verbose: false}
const QUIET: LoggerOptions = {quiet: true, json: false, verbose: false}
const VERBOSE: LoggerOptions = {quiet: false, json: false, verbose: true}

const CONFLICT: ResolvedConflict = {
  field: "version",
  ourValue: "1.1.0",
  theirValue: "1.2.0",
  resolvedValue: "1.2.0",
  strategy: "highest",
}

describe("Logger", () => {
  test("info logs a human-readable line", () => {
    const out = capture(() => new Logger(HUMAN).info("hello"))
    assert.deepEqual(out.logs, ["ℹ hello"])
  })

  test("info is suppressed in quiet mode", () => {
    const out = capture(() => new Logger(QUIET).info("hello"))
    assert.deepEqual(out.logs, [])
  })

  test("info emits parseable JSON in json mode", () => {
    const out = capture(() => new Logger(JSON_MODE).info("hello", {a: 1}))
    assert.equal(out.logs.length, 1)
    const parsed = JSON.parse(out.logs[0] as string)
    assert.equal(parsed.level, "info")
    assert.equal(parsed.message, "hello")
    assert.deepEqual(parsed.data, {a: 1})
    assert(typeof parsed.timestamp === "string")
  })

  test("info prints attached data only in verbose mode", () => {
    const nonVerbose = capture(() => new Logger(HUMAN).info("hello", {a: 1}))
    assert.equal(nonVerbose.logs.length, 1)

    const verbose = capture(() => new Logger(VERBOSE).info("hello", {a: 1}))
    assert.equal(verbose.logs.length, 2)
    assert.deepEqual(JSON.parse(verbose.logs[1] as string), {a: 1})
  })

  test("success logs with a checkmark and honors quiet", () => {
    assert.deepEqual(capture(() => new Logger(HUMAN).success("done")).logs, ["✅ done"])
    assert.deepEqual(capture(() => new Logger(QUIET).success("done")).logs, [])
  })

  test("success emits JSON in json mode", () => {
    const out = capture(() => new Logger(JSON_MODE).success("done"))
    assert.equal(JSON.parse(out.logs[0] as string).level, "success")
  })

  test("warn goes to stderr channel and is not silenced by quiet", () => {
    const out = capture(() => new Logger(QUIET).warn("careful"))
    assert.deepEqual(out.warns, ["⚠️  careful"])
  })

  test("warn emits JSON in json mode", () => {
    const out = capture(() => new Logger(JSON_MODE).warn("careful", {b: 2}))
    const parsed = JSON.parse(out.logs[0] as string)
    assert.equal(parsed.level, "warn")
    assert.deepEqual(parsed.data, {b: 2})
  })

  test("error always logs, even in quiet mode, with data", () => {
    const out = capture(() => new Logger(QUIET).error("boom", {code: 1}))
    assert.equal(out.errors.length, 2)
    assert.equal(out.errors[0], "❌ boom")
    assert.deepEqual(JSON.parse(out.errors[1] as string), {code: 1})
  })

  test("error emits JSON on stderr in json mode", () => {
    const out = capture(() => new Logger(JSON_MODE).error("boom"))
    assert.equal(JSON.parse(out.errors[0] as string).level, "error")
  })

  test("debug logs only in verbose mode", () => {
    assert.deepEqual(capture(() => new Logger(HUMAN).debug("details")).logs, [])
    assert.deepEqual(capture(() => new Logger(VERBOSE).debug("details")).logs, ["🔍 details"])
  })

  test("debug is suppressed when quiet even if verbose", () => {
    const out = capture(() => new Logger({quiet: true, json: false, verbose: true}).debug("details"))
    assert.deepEqual(out.logs, [])
  })

  test("debug prints data in verbose json mode", () => {
    const out = capture(() => new Logger({quiet: false, json: true, verbose: true}).debug("details", {x: 1}))
    const parsed = JSON.parse(out.logs[0] as string)
    assert.equal(parsed.level, "debug")
    assert.deepEqual(parsed.data, {x: 1})
  })

  test("logConflicts renders a human-readable table", () => {
    const out = capture(() => new Logger(HUMAN).logConflicts([CONFLICT]))
    const text = out.logs.join("\n")
    assert(text.includes("Field: version"))
    assert(text.includes("1.1.0"))
    assert(text.includes("1.2.0"))
    assert(text.includes("(highest)"))
  })

  test("logConflicts emits one JSON line in json mode", () => {
    const out = capture(() => new Logger(JSON_MODE).logConflicts([CONFLICT]))
    assert.equal(out.logs.length, 1)
    const parsed = JSON.parse(out.logs[0] as string)
    assert.equal(parsed.data.conflicts.length, 1)
    assert.equal(parsed.data.conflicts[0].field, "version")
  })

  test("logConflicts is silent in quiet mode", () => {
    assert.deepEqual(capture(() => new Logger(QUIET).logConflicts([CONFLICT])).logs, [])
  })

  test("summary reports dry-run wording", () => {
    const dry = capture(() => new Logger(HUMAN).summary(2, 3, true))
    assert(dry.logs.join("\n").includes("Would resolve 2/3 conflicts"))

    const wet = capture(() => new Logger(HUMAN).summary(3, 3, false))
    assert(wet.logs.join("\n").includes("Resolved 3/3 conflicts"))
  })

  test("summary emits JSON in json mode and is silent when quiet", () => {
    const json = capture(() => new Logger(JSON_MODE).summary(1, 1, false))
    assert.deepEqual(JSON.parse(json.logs[0] as string).data, {resolved: 1, total: 1, dryRun: false})

    assert.deepEqual(capture(() => new Logger(QUIET).summary(1, 1, false)).logs, [])
  })
})
