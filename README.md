# Package Conflicts Resolver

A Node.js CLI tool that automatically resolves conflicts in `package.json` and `package-lock.json` files.

## Features

- **Automatic conflict resolution** with configurable strategies
- **True 3-way merges** - a change made on only one branch is always kept; strategies only decide fields both branches changed (the same rule Git uses for `-X ours` / `-X theirs`)
- **Smart version resolution** using semver (ranges, pre-releases, and non-registry specs like `workspace:`, `file:`, and git URLs are handled safely)
- **Git integration** as merge driver or in hooks
- **All conflict styles** - supports `merge`, `diff3`, and `zdiff3` conflict markers (diff3 base sections enable true 3-way merges)
- **Lockfile-safe merging** - a package-lock entry is resolved as a whole: `version`, `resolved`, and `integrity` are never mixed between branches
- **Lockfile consistency check** - every merged `package-lock.json` is verified against its own dependency graph, so a lockfile `npm ci` would reject is never committed silently (see [Lockfile consistency](#lockfile-consistency))
- **npm, yarn, pnpm, and bun aware** - npm lockfiles are merged directly; conflicted `yarn.lock` / `pnpm-lock.yaml` / `bun.lock` files are fixed by their own package manager without installing `node_modules` (see the table below), and the tool never creates a lockfile for a package manager your project doesn't use
- **Stable JSON formatting** - preserves field order, indentation (tabs/spaces), and line endings (LF/CRLF)
- **Cross-platform** - works on Linux, macOS, and Windows

## Installation

```bash
# Global installation
npm install -g package-conflicts-resolver

# Local installation
npm install --save-dev package-conflicts-resolver
```

## Usage

### Quick Setup (Recommended)

Set up automatic conflict resolution during Git merges:

```bash
# Install globally (recommended for setup)
npm install -g package-conflicts-resolver

# Setup for current repository (automatically creates/updates .gitattributes)
npx package-conflicts-resolver setup

# Verify the setup is working
npx package-conflicts-resolver verify
```

That's it! The tool will now automatically resolve conflicts in `package.json` and `package-lock.json` during Git merges.

### Basic Usage

```bash
# Resolve conflicts in package.json AND package-lock.json / npm-shrinkwrap.json
npx package-conflicts-resolver

# Resolve conflicts in specific file
npx package-conflicts-resolver path/to/package.json

# Dry run to see what would be changed
npx package-conflicts-resolver --dry-run

# Use different resolution strategy
npx package-conflicts-resolver --strategy lowest
```

When the target is a `package.json`, conflicted sibling lockfiles are detected and handled in the same run — even if `package.json` itself merged cleanly:

| Package manager | Lockfile                                   | Conflict handling                                                                                    |
| --------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| npm             | `package-lock.json`, `npm-shrinkwrap.json` | Merged semantically by this tool, then regenerated with `npm install --package-lock-only`            |
| pnpm            | `pnpm-lock.yaml`                           | `pnpm install --lockfile-only` (pnpm resolves conflicted lockfiles automatically)                    |
| Yarn Berry (2+) | `yarn.lock`                                | `yarn install --mode update-lockfile` (detected via the `packageManager` field or `.yarnrc.yml`)     |
| Yarn classic    | `yarn.lock`                                | Prints `yarn install` (classic has no lockfile-only mode but auto-resolves conflicts during install) |
| bun             | `bun.lock`                                 | `bun install --lockfile-only`                                                                        |
| bun             | `bun.lockb` (binary)                       | Prints `bun install`                                                                                 |

Regeneration only runs for lockfiles that already exist in your project, never installs `node_modules`, and can be skipped with `--no-regenerate-lock`.

### Resolution Strategies

- `highest` (default) - Use the highest version
- `lowest` - Use the lowest version
- `ours` - Use our version (current branch)
- `theirs` - Use their version (incoming branch)

Strategies only decide **real conflicts**: fields that both branches changed to different values. When the common ancestor is known (merge driver, or `diff3`/`zdiff3` conflict markers), a field changed on one branch only is taken from that branch regardless of the strategy — exactly like Git itself. With default-style conflict markers (no ancestor) every differing field is treated as a conflict.

With `highest`, a stable release beats a pre-release even when the pre-release has a higher base version (`2.68.6` wins over `2.68.4-beta.3`, `^1.9.0` wins over `^2.0.0-beta.1`). Two pre-releases, or two stable versions, compare by semver precedence. The same rule applies to package.json ranges and to the exact versions in package-lock.json, so both files always land on the same side.

### Lockfile consistency

Merging two lockfiles entry by entry can produce a file that is valid JSON but describes a dependency graph npm refuses to install — for example one branch pinned `foo@1.2.0` while the other refreshed the lockfile to `foo@1.5.0`, so the root now requires `1.2.0` but `node_modules/foo` is `1.5.0`. `npm ci` fails on such lockfiles ("package.json and package-lock.json are not in sync").

After every `package-lock.json` / `npm-shrinkwrap.json` merge the tool therefore checks that each declared dependency (including transitive ones, workspace links and `npm:` aliases) is satisfied by the locked version, and reports the edges that are not:

- **CLI**: the lockfile is regenerated with `npm install --package-lock-only` (the default), which fixes the graph. With `--no-regenerate-lock`, or when regeneration fails, the unsatisfied dependencies are printed and the command exits with code 1. `--dry-run` only warns.
- **Merge driver**: the driver cannot regenerate the lockfile (Git merges `package-lock.json` before `package.json`), so it writes the best-effort merge, prints the unsatisfied dependencies, and exits 1. Git then keeps the file marked as conflicted (the worktree copy contains the merged content, without markers) and you finish with:

  ```bash
  npm install --package-lock-only
  git add package-lock.json
  git commit
  ```

  To accept such merges anyway, add `--allow-inconsistent-lockfile` to the merge driver command:

  ```bash
  git config merge.package-conflicts-resolver.driver "npx package-conflicts-resolver merge-driver %A %O %B --allow-inconsistent-lockfile"
  ```

Problems that already existed in one of the branches' lockfiles are not blamed on the merge, and lockfiles without a `packages` section (`lockfileVersion` 1) are not checked.

### Commands

```bash
# Main commands
package-conflicts-resolver [file]           # Resolve conflicts in file (default: package.json)
npx package-conflicts-resolver setup            # Setup Git integration for current repository
npx package-conflicts-resolver setup --global   # Setup Git integration globally
npx package-conflicts-resolver uninstall        # Remove Git integration for current repository
npx package-conflicts-resolver uninstall --global # Remove global Git integration
npx package-conflicts-resolver verify           # Verify Git integration is working
```

### Options

```bash
-s, --strategy <strategy>     Resolution strategy (highest, lowest, ours, theirs)
-d, --dry-run                 Show what would be done without making changes
-q, --quiet                   Suppress output except errors
-j, --json                    Output in JSON format
-v, --verbose                 Enable verbose logging
--no-regenerate-lock          Skip package-lock.json regeneration
--skip-gitattributes          Skip automatic .gitattributes setup (for setup command)
--allow-inconsistent-lockfile Accept an inconsistent merged lockfile (for merge-driver command)
```

### Global Setup

For global setup across all repositories:

```bash
# Setup globally
npm install -g package-conflicts-resolver
package-conflicts-resolver setup --global

# Then run this in each repository to create .gitattributes
package-conflicts-resolver setup
```

### Manual Setup

If you prefer to set up manually, add these lines to your `.gitattributes`:

```
package.json merge=package-conflicts-resolver
package-lock.json merge=package-conflicts-resolver
npm-shrinkwrap.json merge=package-conflicts-resolver
```

And configure the merge driver:

```bash
git config merge.package-conflicts-resolver.driver "npx package-conflicts-resolver merge-driver %A %O %B"
```

This configuration works without any installation since it uses `npx`.

### Removing Git Integration

To remove the Git integration:

```bash
# Remove integration for current repository
package-conflicts-resolver uninstall

# Remove global integration
package-conflicts-resolver uninstall --global

# Force removal without confirmation
package-conflicts-resolver uninstall --force
```

This will:

- Remove the Git merge driver configuration
- Remove package-conflicts-resolver entries from .gitattributes (for local uninstall)

#### Manual Removal

If you prefer to remove manually:

1. **Remove Git configuration:**

   ```bash
   git config --unset merge.package-conflicts-resolver.driver
   git config --unset merge.package-conflicts-resolver.name
   ```

2. **Remove from .gitattributes:**
   Edit `.gitattributes` and remove these lines:
   ```
   package.json merge=package-conflicts-resolver
   package-lock.json merge=package-conflicts-resolver
   npm-shrinkwrap.json merge=package-conflicts-resolver
   ```

### In Git Hooks

Add to your Git hooks (e.g., `post-merge`, `pre-commit`):

```bash
#!/bin/bash
# .git/hooks/post-merge

if [ -f package.json ]; then
    npx package-conflicts-resolver --quiet
fi
```

## Examples

### Resolving Version Conflicts

```bash
# Before
{
  "dependencies": {
<<<<<<< HEAD
    "lodash": "^4.17.21"
=======
    "lodash": "^4.17.20"
>>>>>>> feature
  }
}

# After (using highest strategy)
{
  "dependencies": {
    "lodash": "^4.17.21"
  }
}
```

### Merging Dependencies

```bash
# Before
{
<<<<<<< HEAD
  "dependencies": {
    "express": "^4.18.0",
    "lodash": "^4.17.21"
  }
=======
  "dependencies": {
    "lodash": "^4.17.20",
    "react": "^18.0.0"
  }
>>>>>>> feature
}

# After (merged with version resolution)
{
  "dependencies": {
    "express": "^4.18.0",
    "lodash": "^4.17.21",
    "react": "^18.0.0"
  }
}
```

## API Usage

```typescript
import {PackageResolver} from "package-conflicts-resolver"

const resolver = new PackageResolver({
  strategy: "highest",
  dryRun: false,
  quiet: false,
  json: false,
  verbose: true,
  regenerateLock: true,
})

const result = await resolver.resolveConflicts(conflictedContent)
if (result.resolved && result.packageJson) {
  await resolver.writeResolvedPackage(result.packageJson, "package.json")
}

// For lockfiles, `result.lockfileIssues` lists dependency edges the merged
// lockfile does not satisfy (empty when it is consistent):
const lockResult = await resolver.resolveConflicts(conflictedLockfileContent)
if (lockResult.lockfileIssues?.length) {
  console.warn(
    "Regenerate the lockfile:",
    lockResult.lockfileIssues.map(issue => issue.message)
  )
}

// The check is also available on its own
import {validateLockfile} from "package-conflicts-resolver"
const issues = validateLockfile(JSON.parse(lockfileText), JSON.parse(packageJsonText))
```

## Troubleshooting

### Conflicts are not being resolved automatically

1. **Check if setup is complete**:

   ```bash
   package-conflicts-resolver verify
   ```

2. **Ensure conflicts are in package.json or package-lock.json**:
   The tool only resolves conflicts in these files.

3. **Check if .gitattributes exists**:

   ```bash
   cat .gitattributes
   ```

   Should contain:

   ```
   package.json merge=package-conflicts-resolver
   package-lock.json merge=package-conflicts-resolver
   npm-shrinkwrap.json merge=package-conflicts-resolver
   ```

4. **Re-run setup**:
   ```bash
   package-conflicts-resolver setup
   ```

### Manual resolution after merge

If you encounter conflicts after a merge:

```bash
# Resolve conflicts in package.json
package-conflicts-resolver package.json

# Or just run in the directory with package.json
package-conflicts-resolver
```

### Verify installation

```bash
# Check if the tool is installed
which package-conflicts-resolver

# Check version
package-conflicts-resolver --version

# Verify Git integration
package-conflicts-resolver verify
```

### Common Issues

**"No Git conflict markers found"**

- This means your file doesn't have conflicts, or they've already been resolved.
- Run `package-conflicts-resolver verify` to check your setup.

**"Git merge driver is NOT configured"**

- Run `package-conflicts-resolver setup` to configure the merge driver.

**"merged lockfile is not consistent" during `git merge`**

- The two branches' lockfiles cannot be combined into a graph that satisfies every dependency (the message lists the ones that fail). Run `npm install --package-lock-only`, then `git add package-lock.json` and finish the merge. See [Lockfile consistency](#lockfile-consistency).

**.gitattributes not working**

- Make sure `.gitattributes` is committed to your repository.
- Check that it's in the root directory of your repository.
- Try running `git check-attr -a package.json` to verify Git sees the attributes.

**"Git integration is still active after uninstall"**

- Run `package-conflicts-resolver verify` to check current status.
- Try the manual removal steps if the uninstall command fails.
- Check both local and global Git configurations: `git config --list | grep package-conflicts-resolver`

## Requirements

- Node.js 20+
- npm (for package-lock.json regeneration)
- Git 2.0+

## Support

If this tool saves you time, consider [sponsoring development on GitHub](https://github.com/sponsors/DanielAmenou).

## License

MIT &copy; [Daniel Amenou](https://github.com/DanielAmenou)
