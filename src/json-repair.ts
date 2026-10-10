/**
 * Lenient JSON parsing for documents reconstructed from a textual Git merge.
 *
 * Git merges lines, not JSON. A side that was perfectly valid on its own
 * branch can lose or gain a comma at the boundary of a conflict region once it
 * is stitched back together with the shared context:
 *
 *   "integrity": "sha512-..."        <- last entry on our branch: no comma
 *   "node_modules/other": { ... }    <- but after the merge more entries follow
 *
 * Only two repairs are ever performed: inserting a missing comma between two
 * values, and removing a comma that directly precedes a closing bracket.
 * Neither can change the meaning of an existing token, string contents are
 * never touched, and the result is only accepted when it parses. Anything else
 * still throws the original SyntaxError.
 *
 * Both repairs are made in a single pass over the text, so the work grows
 * linearly with the size of the document however many commas need fixing
 * (lockfiles run to several megabytes). The pass reads the text itself, not
 * the parser's error messages, which every JavaScript engine words its own way.
 */

/** JavaScript's whitespace: JSON's own, and anything else a merge could leave around it */
const WHITESPACE = /\s/

/** JSON's punctuation, which ends a bare token (a number, true, false or null) */
const DELIMITERS = new Set(['"', "{", "}", "[", "]", ",", ":"])

/** A complete JSON number */
const NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/

/**
 * Parse JSON, repairing comma artifacts left behind by a line-based merge.
 * Throws the original SyntaxError when the text cannot be repaired.
 */
export function parseJsonLenient(text: string): any {
  try {
    return JSON.parse(text)
  } catch (originalError) {
    const repaired = repairCommas(text)
    if (repaired !== text) {
      try {
        return JSON.parse(repaired)
      } catch {
        // More than commas is wrong: report the error of the text as it was given
      }
    }
    throw originalError
  }
}

/**
 * Insert the commas missing between two values and remove trailing ones (see
 * stripTrailingCommas), in one pass.
 *
 * A comma is inserted where one value ends and the next one starts with
 * nothing but whitespace between them. A value ends with a string, a closing
 * bracket, a number or true/false/null; one starts with a string, an opening
 * bracket, a number or true/false/null. Valid JSON never has two values side
 * by side, so no well-formed part of a document changes. The comma goes right
 * after the first value, and the whitespace stays as it was.
 *
 * Tokens are never split: "01" or "truefalse" stay as they are, and still fail
 * to parse, rather than becoming two values.
 */
export function repairCommas(text: string): string {
  return repair(text, true)
}

/**
 * Remove commas that directly precede a closing `}` or `]` (ignoring
 * whitespace) *and* that follow a value. Such a comma is never valid JSON, so
 * dropping it cannot change what the document means.
 *
 * A comma that follows an opening bracket or another comma is left alone: in
 * `[,]` or `{"a": 1,,}` an element is genuinely missing, and guessing which
 * one would invent data rather than repair a merge artifact.
 *
 * String contents are skipped, so a script like `x({a:1,})` is untouched.
 */
export function stripTrailingCommas(text: string): string {
  return repair(text, false)
}

function repair(text: string, insertMissing: boolean): string {
  // Unchanged stretches are copied in slices: the text before `copied` is already in `result`
  let result = ""
  let copied = 0
  // The last character kept outside whitespace ("" before the first one): what a comma follows
  let lastSignificant = ""
  // Where the last value read ends, or -1 when the last token did not end a value
  let valueEnd = -1

  // A value starts here: when another one ended just before it, the comma between them is missing
  const startValue = () => {
    if (insertMissing && valueEnd !== -1) {
      result += `${text.slice(copied, valueEnd)},`
      copied = valueEnd
    }
  }

  let i = 0
  while (i < text.length) {
    const char = text[i] as string

    if (WHITESPACE.test(char)) {
      i++
      continue
    }

    if (char === '"') {
      startValue()
      i = endOfString(text, i)
      valueEnd = i
    } else if (char === "{" || char === "[") {
      startValue()
      i++
      valueEnd = -1
    } else if (char === "}" || char === "]") {
      i++
      valueEnd = i
    } else if (char === "," || char === ":") {
      i++
      valueEnd = -1
      if (char === "," && isTrailingComma(text, i, lastSignificant)) {
        result += text.slice(copied, i - 1)
        copied = i
        continue // the comma is gone, so it is not what the next one follows
      }
    } else {
      // A bare token: a number, true, false, null, or something that is not JSON at all
      const end = endOfBareToken(text, i)
      if (isValue(text.slice(i, end))) {
        startValue()
        valueEnd = end
      } else {
        valueEnd = -1
      }
      i = end
    }

    lastSignificant = text[i - 1] as string
  }

  return result + text.slice(copied)
}

/**
 * Whether the comma just before `next` directly precedes a closing bracket
 * and follows a value: after "[", "{", "," or at the start, an element is
 * genuinely missing instead.
 */
function isTrailingComma(text: string, next: number, lastSignificant: string): boolean {
  if (lastSignificant === "" || lastSignificant === "[" || lastSignificant === "{" || lastSignificant === ",") {
    return false
  }
  while (next < text.length && WHITESPACE.test(text[next] as string)) {
    next++
  }
  return text[next] === "}" || text[next] === "]"
}

/** The index just past the string that opens at `start` (the end of the text when it is never closed) */
function endOfString(text: string, start: number): number {
  for (let i = start + 1; i < text.length; i++) {
    const char = text[i]
    if (char === "\\") {
      i++ // the escaped character, which may be a quote
    } else if (char === '"') {
      return i + 1
    }
  }
  return text.length
}

/** The index just past the bare token that starts at `start`: it runs to whitespace or punctuation */
function endOfBareToken(text: string, start: number): number {
  let end = start + 1
  while (end < text.length && !DELIMITERS.has(text[end] as string) && !WHITESPACE.test(text[end] as string)) {
    end++
  }
  return end
}

/** Whether a bare token is a whole JSON value: a number, true, false or null */
function isValue(token: string): boolean {
  return token === "true" || token === "false" || token === "null" || NUMBER.test(token)
}
