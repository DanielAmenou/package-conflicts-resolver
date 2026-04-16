/**
 * Integration tests for the CLI
 */

import {strict as assert} from "assert"
import {test, describe} from "node:test"
import {spawn} from "child_process"
import {writeFile, unlink, readFile, mkdtemp, rm} from "fs/promises"
import {tmpdir} from "os"
import {join} from "path"

describe("CLI Integration Tests", () => {
  const testFile = join(process.cwd(), "test-package.json")
  const cliPath = join(process.cwd(), "dist", "cli.js")

  async function runCli(
    args: string[],
    cwd: string = process.cwd()
  ): Promise<{stdout: string; stderr: string; exitCode: number}> {
    return new Promise(resolve => {
      const child = spawn("node", [cliPath, ...args], {
        stdio: "pipe",
        cwd,
      })

      let stdout = ""
      let stderr = ""

      child.stdout?.on("data", data => {
        stdout += data.toString()
      })

      child.stderr?.on("data", data => {
        stderr += data.toString()
      })

      child.on("close", code => {
        resolve({stdout, stderr, exitCode: code || 0})
      })
    })
  }

  async function runCommand(
    command: string,
    args: string[],
    cwd: string
  ): Promise<{stdout: string; stderr: string; exitCode: number}> {
    return new Promise(resolve => {
      const child = spawn(command, args, {
        stdio: "pipe",
        cwd,
      })

      let stdout = ""
      let stderr = ""

      child.stdout?.on("data", data => {
        stdout += data.toString()
      })

      child.stderr?.on("data", data => {
        stderr += data.toString()
      })

      child.on("close", code => {
        resolve({stdout, stderr, exitCode: code || 0})
      })
    })
  }

  async function createGitConflictRepo(useMergeDriver: boolean = false): Promise<{repoDir: string; defaultBranch: string}> {
    const repoDir = await mkdtemp(join(tmpdir(), "package-conflicts-resolver-"))

    await runCommand("git", ["init"], repoDir)
    await runCommand("git", ["config", "user.name", "Test User"], repoDir)
    await runCommand("git", ["config", "user.email", "test@example.com"], repoDir)

    if (useMergeDriver) {
      await writeFile(join(repoDir, ".gitattributes"), "package.json merge=package-conflicts-resolver\n")
      await runCommand(
        "git",
        ["config", "merge.package-conflicts-resolver.driver", `node ${cliPath} merge-driver %A %O %B`],
        repoDir
      )
    }

    await writeFile(
      join(repoDir, "package.json"),
      `{
  "name": "demo",
  "version": "1.0.0",
  "dependencies": {
    "lodash": "^4.17.21"
  }
}
`
    )

    await runCommand("git", ["add", "."], repoDir)
    await runCommand("git", ["commit", "-m", "base"], repoDir)

    const currentBranch = await runCommand("git", ["rev-parse", "--abbrev-ref", "HEAD"], repoDir)
    const defaultBranch = currentBranch.stdout.trim()

    await runCommand("git", ["checkout", "-b", "feature"], repoDir)
    await writeFile(
      join(repoDir, "package.json"),
      `{
  "name": "demo",
  "version": "1.5.0",
  "dependencies": {
    "lodash": "^4.17.20",
    "react": "^18.0.0"
  }
}
`
    )
    await runCommand("git", ["add", "package.json"], repoDir)
    await runCommand("git", ["commit", "-m", "feature change"], repoDir)

    await runCommand("git", ["checkout", defaultBranch], repoDir)
    await writeFile(
      join(repoDir, "package.json"),
      `{
  "name": "demo",
  "version": "2.0.0",
  "dependencies": {
    "lodash": "^4.17.21",
    "express": "^4.18.0"
  }
}
`
    )
    await runCommand("git", ["add", "package.json"], repoDir)
    await runCommand("git", ["commit", "-m", "default branch change"], repoDir)

    return {repoDir, defaultBranch}
  }

  async function cleanup() {
    try {
      await unlink(testFile)
    } catch {
      // Ignore if file doesn't exist
    }
  }

  test("should show help when no arguments provided", async () => {
    const result = await runCli(["--help"])
    assert.equal(result.exitCode, 0)
    assert(result.stdout.includes("package-conflicts-resolver"))
    assert(result.stdout.includes("Usage:"))
  })

  test("should resolve conflicts in package.json", async () => {
    const conflictedContent = `{
  "name": "test-package",
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

    await writeFile(testFile, conflictedContent)

    const result = await runCli(["--dry-run", testFile])

    assert.equal(result.exitCode, 0)
    assert(result.stdout.includes("Resolved") || result.stdout.includes("conflicts"))

    await cleanup()
  })

  test("should use different strategies", async () => {
    const conflictedContent = `{
  "name": "test-package",
<<<<<<< HEAD
  "version": "1.0.0"
=======
  "version": "2.0.0"
>>>>>>> feature
}`

    await writeFile(testFile, conflictedContent)

    // Test highest strategy (default)
    const highestResult = await runCli(["--dry-run", "--strategy", "highest", testFile])
    assert.equal(highestResult.exitCode, 0)

    // Test lowest strategy
    const lowestResult = await runCli(["--dry-run", "--strategy", "lowest", testFile])
    assert.equal(lowestResult.exitCode, 0)

    // Test ours strategy
    const oursResult = await runCli(["--dry-run", "--strategy", "ours", testFile])
    assert.equal(oursResult.exitCode, 0)

    await cleanup()
  })

  test("should output JSON when requested", async () => {
    const conflictedContent = `{
  "name": "test-package",
<<<<<<< HEAD
  "version": "1.0.0"
=======
  "version": "2.0.0"
>>>>>>> feature
}`

    await writeFile(testFile, conflictedContent)

    const result = await runCli(["--dry-run", "--json", testFile])

    assert.equal(result.exitCode, 0)

    // Should contain JSON output
    const lines = result.stdout.trim().split("\n")
    for (const line of lines) {
      if (line.trim()) {
        assert.doesNotThrow(() => JSON.parse(line), "Output should be valid JSON")
      }
    }

    await cleanup()
  })

  test("should be quiet when requested", async () => {
    const conflictedContent = `{
  "name": "test-package",
<<<<<<< HEAD
  "version": "1.0.0"
=======
  "version": "2.0.0"
>>>>>>> feature
}`

    await writeFile(testFile, conflictedContent)

    const result = await runCli(["--dry-run", "--quiet", testFile])

    assert.equal(result.exitCode, 0)
    assert.equal(result.stdout.trim(), "") // Should be quiet

    await cleanup()
  })

  test("should handle non-existent file", async () => {
    const result = await runCli(["non-existent-file.json"])

    assert.notEqual(result.exitCode, 0)
    assert(result.stderr.includes("not found") || result.stderr.includes("ENOENT"))
  })

  test("should handle invalid strategy", async () => {
    const result = await runCli(["--strategy", "invalid", testFile])

    assert.notEqual(result.exitCode, 0)
    assert(result.stderr.includes("Invalid strategy"))
  })

  test("should actually resolve conflicts when not dry-run", async () => {
    const conflictedContent = `{
  "name": "test-package",
<<<<<<< HEAD
  "version": "1.0.0"
=======
  "version": "2.0.0"
>>>>>>> feature
}`

    await writeFile(testFile, conflictedContent)

    const result = await runCli([testFile])

    assert.equal(result.exitCode, 0)

    // Check that file was actually modified
    const resolvedContent = await readFile(testFile, "utf8")
    assert(!resolvedContent.includes("<<<<<<<"))
    assert(!resolvedContent.includes("======="))
    assert(!resolvedContent.includes(">>>>>>>"))

    // Should be valid JSON
    assert.doesNotThrow(() => JSON.parse(resolvedContent))

    await cleanup()
  })

  test("should handle file without conflicts", async () => {
    const cleanContent = `{
  "name": "test-package",
  "version": "1.0.0",
  "dependencies": {
    "lodash": "^4.17.21"
  }
}`

    await writeFile(testFile, cleanContent)

    const result = await runCli([testFile])

    assert.equal(result.exitCode, 0)
    assert(
      result.stdout.includes("No conflicts found") ||
        result.stdout.includes("No Git conflict markers found") ||
        result.stdout.includes("0") ||
        result.stdout.length === 0
    )

    await cleanup()
  })

  test("should work with default package.json", async () => {
    // Create a test package.json in a temp directory or use a different approach
    // For now, just test that the CLI accepts default package.json argument
    const tempPackageJson = join(process.cwd(), "temp-package.json")

    const conflictedContent = `{
  "name": "test-package",
<<<<<<< HEAD
  "version": "1.0.0"
=======
  "version": "2.0.0"
>>>>>>> feature
}`

    await writeFile(tempPackageJson, conflictedContent)

    const result = await runCli(["--dry-run", tempPackageJson])

    assert.equal(result.exitCode, 0)

    // Cleanup
    try {
      await unlink(tempPackageJson)
    } catch {
      // Ignore cleanup errors
    }
  })

  test("should resolve a real git-generated package.json conflict", async () => {
    const {repoDir} = await createGitConflictRepo()

    try {
      const mergeResult = await runCommand("git", ["merge", "--no-edit", "feature"], repoDir)
      assert.notEqual(mergeResult.exitCode, 0)

      const conflictedContent = await readFile(join(repoDir, "package.json"), "utf8")
      assert(conflictedContent.includes("<<<<<<<"))

      const cliResult = await runCli(["--no-regenerate-lock", "package.json"], repoDir)
      assert.equal(cliResult.exitCode, 0)

      const resolvedPackage = JSON.parse(await readFile(join(repoDir, "package.json"), "utf8"))
      assert.deepEqual(resolvedPackage, {
        name: "demo",
        version: "2.0.0",
        dependencies: {
          lodash: "^4.17.21",
          express: "^4.18.0",
          react: "^18.0.0",
        },
      })
    } finally {
      await rm(repoDir, {recursive: true, force: true})
    }
  })

  test("should resolve a real git merge through the merge driver", async () => {
    const {repoDir} = await createGitConflictRepo(true)

    try {
      const mergeResult = await runCommand("git", ["merge", "--no-edit", "feature"], repoDir)
      assert.equal(mergeResult.exitCode, 0, mergeResult.stderr || mergeResult.stdout)

      const resolvedContent = await readFile(join(repoDir, "package.json"), "utf8")
      assert(!resolvedContent.includes("<<<<<<<"))

      const resolvedPackage = JSON.parse(resolvedContent)
      assert.deepEqual(resolvedPackage, {
        name: "demo",
        version: "2.0.0",
        dependencies: {
          lodash: "^4.17.21",
          express: "^4.18.0",
          react: "^18.0.0",
        },
      })
    } finally {
      await rm(repoDir, {recursive: true, force: true})
    }
  })
})
