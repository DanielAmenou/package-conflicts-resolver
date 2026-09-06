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
 */

/**
 * Upper bound on inserted commas. Each repair re-parses the document, so this
 * caps the work for a pathological file; a real merge needs at most one comma
 * per conflict region.
 */
const MAX_REPAIRS = 1000

/**
 * Parse JSON, repairing comma artifacts left behind by a line-based merge.
 * Throws the original SyntaxError when the text cannot be repaired.
 */
export function parseJsonLenient(text: string): any {
  try {
    return JSON.parse(text)
  } catch (originalError) {
    let current = stripTrailingCommas(text)

    for (let attempt = 0; attempt < MAX_REPAIRS; attempt++) {
      try {
        return JSON.parse(current)
      } catch (error) {
        const repaired = insertMissingComma(current, error)
        if (repaired === null) {
          throw originalError
        }
        current = repaired
      }
    }

    throw originalError
  }
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
  let result = ""
  let inString = false

  for (let i = 0; i < text.length; i++) {
    const char = text[i] as string

    if (inString) {
      result += char
      if (char === "\\" && i + 1 < text.length) {
        result += text[i + 1]
        i++
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
      result += char
      continue
    }

    if (char === ",") {
      let next = i + 1
      while (next < text.length && /\s/.test(text[next] as string)) {
        next++
      }
      const following = text[next]
      // Only drop it when a value actually precedes the comma
      const preceding = result.replace(/\s+$/, "").slice(-1)
      const followsValue = preceding !== "" && preceding !== "[" && preceding !== "{" && preceding !== ","

      if ((following === "}" || following === "]") && followsValue) {
        continue // drop the trailing comma
      }
    }

    result += char
  }

  return result
}

/**
 * Insert the comma the parser expected at the reported error position, but
 * only when the position sits between the end of one value and the start of
 * the next. Returns null when the error is anything else.
 */
function insertMissingComma(text: string, error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error)

  // V8 (Node 20+): "Expected ',' or '}' after property value in JSON at position N"
  // Older engines: "Unexpected string in JSON at position N"
  if (!/Expected ',' or ['}\]]/.test(message) && !/^Unexpected (?:string|number)/.test(message)) {
    return null
  }

  const positionMatch = message.match(/position (\d+)/)
  if (!positionMatch || !positionMatch[1]) {
    return null
  }

  const position = parseInt(positionMatch[1], 10)
  if (!(position > 0 && position < text.length)) {
    return null
  }

  const beforeWithWhitespace = text.slice(0, position)
  const before = beforeWithWhitespace.replace(/\s+$/, "")
  const whitespace = beforeWithWhitespace.slice(before.length)
  const previous = before[before.length - 1]
  const next = text[position]

  // The previous character must end a value (string, object, array, number,
  // true/false or null) and the next one must start a value or a key.
  if (!previous || !/["}\]0-9el]/.test(previous)) {
    return null
  }
  if (!next || !/["{[0-9tfn-]/.test(next)) {
    return null
  }

  return `${before},${whitespace}${text.slice(position)}`
}
