/**
 * The --list report: building it from resolution results and rendering it.
 */

import {strict as assert} from "assert"
import {test, describe} from "node:test"
import {formatConflictReport, reportFile, unanalyzedFile, ConflictReport} from "../conflict-report.js"
import {PackageConflict, ResolutionResult, ResolvedConflict, UnresolvedConflict} from "../types.js"

const pkg = (overrides: Partial<PackageConflict>): PackageConflict => ({
  name: "lodash",
  kind: "spec",
  location: "dependencies",
  path: ["dependencies", "lodash"],
  ours: "^4.17.19",
  theirs: "^4.17.21",
  resolved: "^4.17.21",
  resolvedBy: "highest",
  ...overrides,
})

const field = (overrides: Partial<ResolvedConflict>): ResolvedConflict => ({
  field: "version",
  ourValue: "1.1.0",
  theirValue: "1.2.0",
  resolvedValue: "1.2.0",
  strategy: "highest",
  ...overrides,
})

const resolvedResult = (conflicts: ResolvedConflict[], packageConflicts?: PackageConflict[]): ResolutionResult => {
  const result: ResolutionResult = {resolved: true, conflicts, errors: []}
  if (packageConflicts !== undefined) {
    result.packageConflicts = packageConflicts
  }
  return result
}

describe("reportFile", () => {
  test("lists package conflicts by name, specs before locked installs, then by location", () => {
    const report = reportFile(
      "package-lock.json",
      resolvedResult(
        [],
        [
          pkg({name: "react", kind: "lock", location: "node_modules/react"}),
          pkg({name: "lodash", kind: "lock", location: "node_modules/lodash"}),
          pkg({name: "lodash", kind: "lock", location: "node_modules/a/node_modules/lodash"}),
          pkg({name: "lodash", kind: "spec", location: "root › dependencies"}),
          pkg({name: "Zed", kind: "spec"}),
          pkg({name: "lodash", kind: "lock", location: "node_modules/lodash"}),
        ]
      )
    )
    assert.equal(report.analyzed, true)
    assert.deepEqual(
      report.packages.map(conflict => `${conflict.name} ${conflict.location}`),
      [
        "Zed dependencies", // code-unit order: uppercase first, whatever the locale
        "lodash root › dependencies",
        "lodash node_modules/a/node_modules/lodash",
        "lodash node_modules/lodash",
        "lodash node_modules/lodash",
        "react node_modules/react",
      ]
    )
  })

  test("other conflicts are the ones that are not about package versions", () => {
    const report = reportFile(
      "package.json",
      resolvedResult([
        field({}),
        field({field: "dependencies.lodash", package: "lodash"}),
        field({field: "devDependencies"}), // a fallback block of entries
        field({field: "node_modules/lodash"}), // a fallback lockfile entry
        field({field: "packages.node_modules/x.dev", ourValue: "true", theirValue: "false", resolvedValue: "true"}),
        field({field: "scripts.test", ourValue: "jest", theirValue: "vitest", resolvedValue: "vitest"}),
      ])
    )
    assert.deepEqual(report.packages, [], "no packageConflicts on the result")
    assert.deepEqual(report.otherConflicts, [
      {field: "version", ours: "1.1.0", theirs: "1.2.0", resolved: "1.2.0"},
      {field: "scripts.test", ours: "jest", theirs: "vitest", resolved: "vitest"},
    ])
  })

  test("values left for the user are listed with both sides, as text", () => {
    const unresolved: UnresolvedConflict[] = [
      {
        field: "scripts.build",
        path: ["scripts", "build"],
        reason: "not-a-version",
        ours: "tsc -b",
        theirs: "tsc && vite build",
        base: "tsc",
      },
      {field: "private", path: ["private"], reason: "not-a-version", ours: true, theirs: false},
      {
        field: "exports",
        path: ["exports"],
        reason: "not-a-version",
        ours: "./index.js",
        theirs: {".": "./dist/index.js"},
      },
    ]
    const report = reportFile("package.json", {...resolvedResult([field({})]), unresolved})
    assert.deepEqual(report.unresolved, [
      {
        field: "scripts.build",
        path: ["scripts", "build"],
        reason: "not-a-version",
        ours: "tsc -b",
        theirs: "tsc && vite build",
        base: "tsc",
      },
      {field: "private", path: ["private"], reason: "not-a-version", ours: "true", theirs: "false"},
      {
        field: "exports",
        path: ["exports"],
        reason: "not-a-version",
        ours: "./index.js",
        theirs: '{".":"./dist/index.js"}',
      },
    ])
    assert.deepEqual(report.otherConflicts, [{field: "version", ours: "1.1.0", theirs: "1.2.0", resolved: "1.2.0"}])
  })

  test("a side that removed a value is reported as null, a value that is null as text", () => {
    const unresolved: UnresolvedConflict[] = [
      {
        field: "scripts.lint",
        path: ["scripts", "lint"],
        reason: "removed",
        ours: undefined,
        theirs: "eslint .",
        base: "x",
      },
      {field: "funding", path: ["funding"], reason: "removed", ours: null, theirs: undefined, base: "x"},
      {
        field: "dependencies.foo",
        path: ["dependencies", "foo"],
        reason: "not-comparable",
        ours: "file:../a",
        theirs: "^1.0.0",
      },
    ]
    const report = reportFile("package.json", {...resolvedResult([]), unresolved})
    assert.deepEqual(report.unresolved, [
      {field: "scripts.lint", path: ["scripts", "lint"], reason: "removed", ours: null, theirs: "eslint .", base: "x"},
      {field: "funding", path: ["funding"], reason: "removed", ours: "null", theirs: null, base: "x"},
      {
        field: "dependencies.foo",
        path: ["dependencies", "foo"],
        reason: "not-comparable",
        ours: "file:../a",
        theirs: "^1.0.0",
      },
    ])
  })

  test("a result without unresolved values reports none", () => {
    assert.deepEqual(reportFile("package.json", resolvedResult([])).unresolved, [])
  })

  test("a file that could not be resolved is reported as not analyzed, with the reason", () => {
    const report = reportFile("package.json", {resolved: false, conflicts: [], errors: ["Unexpected token", "oops"]})
    assert.deepEqual(report, {
      file: "package.json",
      analyzed: false,
      packages: [],
      otherConflicts: [],
      unresolved: [],
      reason: "Unexpected token, oops",
    })
  })

  test("unanalyzedFile", () => {
    assert.deepEqual(unanalyzedFile("yarn.lock", "yarn resolves it"), {
      file: "yarn.lock",
      analyzed: false,
      packages: [],
      otherConflicts: [],
      unresolved: [],
      reason: "yarn resolves it",
    })
  })
})

describe("formatConflictReport", () => {
  test("a table per file, with a hint on how to pick", () => {
    const report: ConflictReport = {
      strategy: "highest",
      files: [
        {
          file: "package.json",
          analyzed: true,
          packages: [
            pkg({}),
            pkg({
              name: "typescript",
              location: "devDependencies",
              ours: "~5.4.0",
              theirs: "~5.6.2",
              resolved: "~5.6.2",
            }),
          ],
          otherConflicts: [{field: "version", ours: "1.1.0", theirs: "1.2.0", resolved: "1.2.0"}],
          unresolved: [],
        },
      ],
    }
    assert.deepEqual(formatConflictReport(report), [
      "📋 package.json: 2 conflicted packages (strategy: highest)",
      "",
      "   Package     Where            Ours      Theirs    Resolved",
      "   lodash      dependencies     ^4.17.19  ^4.17.21  ^4.17.21",
      "   typescript  devDependencies  ~5.4.0    ~5.6.2    ~5.6.2",
      "",
      "   Also conflicted: version (ours 1.1.0, theirs 1.2.0 → 1.2.0)",
      "",
      "Choose the version of a package with --pick <name>@<version>, for example --pick lodash@^4.17.21",
    ])
  })

  test("a base column when the common ancestor is known", () => {
    const report: ConflictReport = {
      strategy: "lowest",
      files: [
        {
          file: "package.json",
          analyzed: true,
          packages: [pkg({name: "a", base: "^4.17.15"}), pkg({name: "b"})],
          otherConflicts: [],
          unresolved: [],
        },
      ],
    }
    assert.deepEqual(formatConflictReport(report).slice(0, 5), [
      "📋 package.json: 2 conflicted packages (strategy: lowest)",
      "",
      "   Package  Where         Ours      Theirs    Base      Resolved",
      "   a        dependencies  ^4.17.19  ^4.17.21  ^4.17.15  ^4.17.21",
      "   b        dependencies  ^4.17.19  ^4.17.21  -         ^4.17.21",
    ])
  })

  test("picked versions are marked, and picks that matched neither side say so", () => {
    const report: ConflictReport = {
      strategy: "highest",
      files: [
        {
          file: "package-lock.json",
          analyzed: true,
          packages: [
            pkg({
              kind: "spec",
              location: "root › dependencies",
              resolved: "4.17.22",
              resolvedBy: "pick",
              pick: "4.17.22",
            }),
            pkg({
              kind: "lock",
              location: "node_modules/lodash",
              ours: "4.17.19",
              theirs: "4.17.21",
              resolved: "4.17.21",
              pick: "4.17.22",
            }),
          ],
          otherConflicts: [],
          unresolved: [],
        },
      ],
    }
    const lines = formatConflictReport(report)
    assert.equal(lines[0], "📋 package-lock.json: 1 conflicted package (strategy: highest)", "one package, two places")
    assert.deepEqual(lines.slice(3, 5), [
      "   lodash   root › dependencies  ^4.17.19  ^4.17.21  4.17.22 (picked)",
      "   lodash   node_modules/lodash  4.17.19   4.17.21   4.17.21 (4.17.22 is on neither side)",
    ])
    assert(!lines.some(line => line.includes("--pick")), "no hint once versions are picked")
  })

  test("one package, no packages, long values and files that could not be analyzed", () => {
    const longScript = `node ${"x".repeat(60)}`
    const report: ConflictReport = {
      strategy: "theirs",
      files: [
        {file: "package.json", analyzed: true, packages: [pkg({kind: "lock"})], otherConflicts: [], unresolved: []},
        {
          file: "npm-shrinkwrap.json",
          analyzed: true,
          packages: [],
          otherConflicts: [
            {field: "scripts.build", ours: longScript, theirs: "tsc", resolved: "tsc"},
            {field: "packages..version", ours: "1.1.0", theirs: "1.2.0", resolved: "1.2.0"},
          ],
          unresolved: [],
        },
        {
          file: "pnpm-lock.yaml",
          analyzed: false,
          packages: [],
          otherConflicts: [],
          unresolved: [],
          reason: "pnpm resolves it",
        },
      ],
    }
    const lines = formatConflictReport(report)
    assert.equal(lines[0], "📋 package.json: 1 conflicted package (strategy: theirs)")
    assert(lines.includes("📋 npm-shrinkwrap.json: no conflicted packages"))
    assert(
      lines.includes(
        `   Also conflicted: scripts.build (ours ${longScript.slice(0, 39)}…, theirs tsc → tsc), root › version (ours 1.1.0, theirs 1.2.0 → 1.2.0)`
      ),
      "the lockfile's root entry reads as root, like in the Where column"
    )
    assert(lines.includes("⚠️  pnpm-lock.yaml has conflicts that could not be analyzed: pnpm resolves it"))
    // Only locked installs: the example uses one of them
    assert.equal(
      lines[lines.length - 1],
      "Choose the version of a package with --pick <name>@<version>, for example --pick lodash@^4.17.21"
    )
  })

  test("values left for the user get their own line, and a hint on how to finish", () => {
    const lines = formatConflictReport({
      strategy: "highest",
      files: [
        {
          file: "package.json",
          analyzed: true,
          packages: [],
          otherConflicts: [{field: "version", ours: "1.1.0", theirs: "1.2.0", resolved: "1.2.0"}],
          unresolved: [
            {
              field: "scripts.build",
              path: ["scripts", "build"],
              reason: "not-a-version",
              ours: "tsc -b",
              theirs: `vite build ${"x".repeat(40)}`,
            },
            {field: "private", path: ["private"], reason: "not-a-version", ours: "true", theirs: "false"},
          ],
        },
      ],
    })
    assert.deepEqual(lines, [
      "📋 package.json: no conflicted packages",
      "",
      "   Also conflicted: version (ours 1.1.0, theirs 1.2.0 → 1.2.0)",
      "",
      `   Left for you to decide: scripts.build (ours tsc -b, theirs vite build ${"x".repeat(28)}…), private (ours true, theirs false)`,
      "",
      "Values left for you to decide stay between conflict markers when resolving, unless you use --strategy ours or --strategy theirs (or --pick, for a package)",
    ])
  })

  test("a removed side reads as removed, and packages left for the user are only in the table", () => {
    const lines = formatConflictReport({
      strategy: "highest",
      files: [
        {
          file: "package.json",
          analyzed: true,
          packages: [
            pkg({ours: null, base: "^4.17.20", resolved: null, resolvedBy: "user"}),
            pkg({
              name: "react",
              path: ["dependencies", "react"],
              ours: "^18.3.0",
              theirs: null,
              base: "^18.2.0",
              resolved: null,
              resolvedBy: "ours",
            }),
            pkg({
              name: "zod",
              path: ["dependencies", "zod"],
              ours: "github:u/zod#v3",
              theirs: "^3.23.0",
              base: "^3.22.0",
              resolved: null,
              resolvedBy: "user",
            }),
          ],
          otherConflicts: [],
          unresolved: [
            {
              field: "dependencies.lodash",
              path: ["dependencies", "lodash"],
              reason: "removed",
              ours: null,
              theirs: "^4.17.21",
            },
            {field: "scripts.lint", path: ["scripts", "lint"], reason: "removed", ours: "eslint .", theirs: null},
            {
              field: "dependencies.zod",
              path: ["dependencies", "zod"],
              reason: "not-comparable",
              ours: "x",
              theirs: "y",
            },
          ],
        },
      ],
    })
    assert.deepEqual(lines, [
      "📋 package.json: 3 conflicted packages (strategy: highest)",
      "",
      "   Package  Where         Ours             Theirs     Base      Resolved",
      "   lodash   dependencies  (removed)        ^4.17.21   ^4.17.20  (left for you)",
      "   react    dependencies  ^18.3.0          (removed)  ^18.2.0   (removed)",
      "   zod      dependencies  github:u/zod#v3  ^3.23.0    ^3.22.0   (left for you)",
      "",
      "   Left for you to decide: scripts.lint (ours eslint ., theirs removed)",
      "",
      // The example is a package left for the user, with the version that is there
      "Choose the version of a package with --pick <name>@<version>, for example --pick lodash@^4.17.21",
      "Values left for you to decide stay between conflict markers when resolving, unless you use --strategy ours or --strategy theirs (or --pick, for a package)",
    ])
  })

  test("a dependency kept removed reads as removed, with a hint on how to keep it", () => {
    const lines = formatConflictReport({
      strategy: "highest",
      files: [
        {
          file: "package.json",
          analyzed: true,
          packages: [
            pkg({name: "a", path: ["dependencies", "a"], ours: "^1.0.0", theirs: "^1.1.0", resolved: "^1.1.0"}),
            pkg({ours: null, base: "^4.17.20", resolved: null, resolvedBy: "removal"}),
          ],
          otherConflicts: [],
          unresolved: [],
        },
      ],
    })
    assert.deepEqual(lines, [
      "📋 package.json: 2 conflicted packages (strategy: highest)",
      "",
      "   Package  Where         Ours       Theirs    Base      Resolved",
      "   a        dependencies  ^1.0.0     ^1.1.0    -         ^1.1.0",
      "   lodash   dependencies  (removed)  ^4.17.21  ^4.17.20  (removed)",
      "",
      // The example keeps the removed dependency
      "Choose the version of a package with --pick <name>@<version>, for example --pick lodash@^4.17.21",
      "A dependency one branch removed stays removed, without the other branch's change: pick a version to keep it",
    ])
  })

  test("the pick example falls back to our version when theirs was removed", () => {
    const lines = formatConflictReport({
      strategy: "highest",
      files: [
        {
          file: "package.json",
          analyzed: true,
          packages: [pkg({theirs: null, resolved: null, resolvedBy: "user"})],
          otherConflicts: [],
          unresolved: [],
        },
      ],
    })
    assert.equal(
      lines[lines.length - 1],
      "Choose the version of a package with --pick <name>@<version>, for example --pick lodash@^4.17.19"
    )
  })

  test("no hint without packages, and a message when nothing is conflicted", () => {
    const onlyFields = formatConflictReport({
      strategy: "highest",
      files: [{file: "package.json", analyzed: true, packages: [], otherConflicts: [], unresolved: []}],
    })
    assert.deepEqual(onlyFields, ["📋 package.json: no conflicted packages", ""])

    assert.deepEqual(formatConflictReport({strategy: "highest", files: []}), [
      "✅ No conflicted packages: no file has Git conflict markers",
    ])
  })
})
