# Package Conflicts Resolver

A Node.js CLI tool that automatically resolves conflicts in `package.json` and `package-lock.json` files.

## Features

- **Automatic conflict resolution** with configurable strategies
- **True 3-way merges** - a change made on only one branch is always kept; strategies only decide fields both branches changed (the same rule Git uses for `-X ours` / `-X theirs`). Lists such as `files` and `keywords` merge item by item: what either branch added is kept, and what either branch removed stays removed. A dependency one branch removed stays removed too, even if the other branch upgraded it
- **No guessing** - a value the strategy has no order for is left for you between conflict markers around just that property, while everything else is merged: a script both branches changed, a script one branch removed while the other changed it, or two specs that cannot be compared, such as a git URL and a range (see [Values left for you to decide](#values-left-for-you-to-decide))
- **Smart version resolution** using semver: ranges and pre-releases are ordered correctly, and `npm:` aliases, `workspace:` ranges and git tags are compared by their versions, never by digits that happen to be in a URL, a file name or a commit hash
- **List conflicted packages** - `--list` shows every package whose version conflicts, with our, their (and the base) version and what the resolution would keep, as a table or JSON (see [Listing conflicted packages](#listing-conflicted-packages))
- **Pick versions per package** - `--pick lodash@4.17.21` resolves the packages you choose to the versions you choose, checked against the registry first, while the strategy resolves everything else (see [Choosing versions for specific packages](#choosing-versions-for-specific-packages))
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

# List the conflicted packages with our and their versions (changes nothing)
npx package-conflicts-resolver --list

# Choose the version of some packages; the strategy resolves the rest
npx package-conflicts-resolver --pick lodash@4.17.21 --pick typescript@~5.5.4
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

Lists of plain values, such as `files`, `keywords`, `os` or `workspaces`, merge item by item against the common ancestor: an item either branch added is kept, and an item either branch removed stays removed. Without the ancestor, the two lists are combined. Lists of objects are decided as a whole.

A dependency one branch removed stays removed, even when the other branch changed its version: a new version says which version to use, not that the package is still needed. The merge goes on, and lists the changes it dropped:

```
package-conflicts-resolver: dependencies.lodash: our branch removed it, their change to ^4.17.21 was dropped
```

To keep such a dependency, [pick its version](#choosing-versions-for-specific-packages), use the strategy of the branch that changed it (`--strategy ours` or `--strategy theirs`), or add it back afterwards. A lockfile follows package.json: its root entry drops the dependency, and the installed entry stays until npm regenerates the lockfile, which prunes it unless another package needs it.

With `highest`, a stable release beats a pre-release even when the pre-release has a higher base version (`2.68.6` wins over `2.68.4-beta.3`, `^1.9.0` wins over `^2.0.0-beta.1`). Two pre-releases, or two stable versions, compare by semver precedence. The same rule applies to package.json ranges and to the exact versions in package-lock.json, so both files always land on the same side.

To decide some packages yourself instead, [pick their versions](#choosing-versions-for-specific-packages).

#### Values left for you to decide

`highest` and `lowest` order versions. Some conflicts have no higher or lower side:

- **Values that are not versions**, such as a script, the description, `main`, a boolean or an object, changed differently on both branches.
- **Versions that cannot be compared**: specs that point at different things, or at something without a version, such as a git URL and a range, two `file:` tarballs, two commits of a repository, or dist-tags. Specs of the same kind are still compared by their versions: two `npm:` aliases of the same package, two `workspace:` ranges, two tags of the same git repository (`#v1.2.0`, `#semver:^1.2.0`), two `packageManager` versions of the same package manager.
- **A value one branch removed while the other changed it**, such as a script or a config block. Whether it should still be there is a decision, not a comparison. A dependency is the exception: [it stays removed](#resolution-strategies).

They are left for you to decide: everything else is merged, and package.json keeps Git conflict markers around just those properties.

```
  "scripts": {
<<<<<<< ours
    "build": "tsc -b",
=======
    "build": "tsc && vite build",
>>>>>>> theirs
    "test": "jest"
  },
```

When the common ancestor is known (always in the merge driver, and with `diff3`/`zdiff3` conflict markers), the conflicts also show its value, in a `|||||||` section that is empty when it did not have the value. The side of a branch that removed the value has no line, and the property comes first in its object, so that keeping either side as it is gives valid JSON:

```
  "scripts": {
<<<<<<< ours
||||||| base
    "lint": "eslint .",
=======
    "lint": "eslint --fix .",
>>>>>>> theirs
    "build": "tsc"
  },
```

The command lists these values with the reason for each, and exits with code 1. Finish by editing them, by picking versions for the dependencies among them with [`--pick`](#choosing-versions-for-specific-packages), or by running again with `--strategy ours` or `--strategy theirs`, which decide them like any other conflict, removals included. Lockfiles are regenerated once package.json has no conflict markers left, since a package manager cannot read it before that.

The merge driver does the same and exits 1, so Git stops before committing the merge: `git status` shows package.json as conflicted, with only those properties between markers.

A lockfile never leaves values for you: it follows package.json, so it keeps ours (or, for an installed entry one branch removed, the changed one), and npm rewrites it when the lockfile is regenerated.

### Listing conflicted packages

See which packages conflict, what each branch wants, and what the resolution would keep, without changing any file:

```bash
npx package-conflicts-resolver --list
```

```
📋 package.json: 3 conflicted packages (strategy: highest)

   Package     Where            Ours      Theirs    Resolved
   lodash      dependencies     ^4.17.19  ^4.17.21  ^4.17.21
   react       dependencies     ^18.2.0   ^18.3.1   ^18.3.1
   typescript  devDependencies  ~5.4.5    ~5.6.2    ~5.6.2

   Also conflicted: version (ours 1.1.0, theirs 1.2.0 → 1.2.0)

📋 package-lock.json: 3 conflicted packages (strategy: highest)

   Package     Where                    Ours      Theirs    Resolved
   lodash      root › dependencies      ^4.17.19  ^4.17.21  ^4.17.21
   lodash      node_modules/lodash      4.17.19   4.17.21   4.17.21
   react       root › dependencies      ^18.2.0   ^18.3.1   ^18.3.1
   react       node_modules/react       18.2.0    18.3.1    18.3.1
   typescript  root › devDependencies   ~5.4.5    ~5.6.2    ~5.6.2
   typescript  node_modules/typescript  5.4.5     5.6.2     5.6.2

Choose the version of a package with --pick <name>@<version>, for example --pick lodash@^4.17.21
```

- **Where** is the dependency field of a declared range (`dependencies`, `devDependencies`, `peerDependencies`, `optionalDependencies`; in a lockfile, `root › dependencies` is the project's own entry and `packages/web › dependencies` a workspace's), or the install location of a locked version (`node_modules/lodash`, `node_modules/debug/node_modules/ms`).
- A **Base** column shows the common ancestor's version when the conflict markers carry it (`diff3`/`zdiff3` conflict style). Then a package only one branch changed is no conflict: it merges to that branch's version and is not listed.
- **Resolved** follows `--strategy`, and previews `--pick` (marked `(picked)`). A package the strategy cannot decide reads `(left for you)` (see [Values left for you to decide](#values-left-for-you-to-decide)), and a version a branch removed reads `(removed)`.
- **Left for you to decide** lists the other values a run leaves between conflict markers, such as scripts.
- With `--json`, the report is printed as a single JSON document: `{"strategy", "files": [{"file", "analyzed", "packages": [{"name", "kind", "location", "path", "ours", "theirs", "base"?, "resolved", "resolvedBy", "pick"?}], "otherConflicts": [{"field", "ours", "theirs", "resolved"}], "unresolved": [{"field", "path", "reason", "ours", "theirs", "base"?}]}]}`. `kind` is `"spec"` for a declared range and `"lock"` for a locked version. `ours` and `theirs` are `null` for a branch that removed the value, and `resolved` is `null` when the resolution removes the value or leaves it for you. `resolvedBy` is then `"removal"` for a dependency that stays removed, and `"user"` for a value left for you. `unresolved` lists every value left for you, packages included, with a `reason` of `"not-a-version"`, `"not-comparable"` or `"removed"`.

Like a normal run, `--list` looks at the conflicted lockfiles next to a package.json. Conflicted `yarn.lock`, `pnpm-lock.yaml` and `bun.lock` files are mentioned but not analyzed, since their package manager resolves them. The command exits with code 1 only when a conflicted npm file cannot be analyzed, or when a `--pick` is invalid.

### Choosing versions for specific packages

Decide the version of any conflicted package yourself, with one `--pick` per package. Every other conflict is still resolved by the strategy:

```bash
npx package-conflicts-resolver --pick typescript@~5.5.4 --pick react@18.3.1
npx package-conflicts-resolver --strategy lowest --pick lodash@^4.17.21
```

- **package.json** gets the picked spec exactly as you wrote it: `--pick lodash@4.17.21` pins `4.17.21`, `--pick lodash@^4.17.21` keeps a caret range. A lockfile's copy of the specs (its root and workspace entries) gets the same value.
- **package-lock.json** keeps, for every conflicted install of the package, the branch's entry whose locked version satisfies the pick, with its `version`, `resolved` and `integrity` together. When neither branch locked a matching version (you picked a third version), npm locks it when the lockfile is regenerated, which is the default. With `--no-regenerate-lock` the lockfile is reported as inconsistent until you run `npm install --package-lock-only`.

Nothing is written unless every pick passes these checks:

1. It reads `<name>@<version>`, with an exact version or a semver range. `npm:` aliases (`my-lodash@npm:lodash@^4.17.0`), `file:` paths, git and tarball URLs work too. Dist-tags such as `latest` do not: they say nothing about which version gets installed.
2. The package is conflicted. A typo gets a suggestion (`lodsh is not conflicted (did you mean lodash?)`). A package that is only conflicted in package-lock.json entries can only be picked at a version one of the branches locked, since a lockfile entry for another version can only come from npm.
3. The version exists. It is looked up with `npm view <name> versions` in your project, so your `.npmrc` settings (registry, scoped registries, credentials, proxy) apply. `file:` paths are checked on disk, while git, URL and `workspace:` specs cannot be checked and are used as given, with a warning. `--no-version-check` skips the lookup, for example when working offline.

`--pick` combines with `--dry-run` (check and preview), `--list`, `--json` and `--quiet`.

#### With the merge driver installed

The merge driver resolves package.json and package-lock.json during `git merge` itself, so no conflict markers are left to list or to pick from. To decide versions yourself in one merge, let Git do its own line merge for that merge only (`--diff3` adds the common ancestor to the markers):

```bash
git -c merge.package-conflicts-resolver.driver="git merge-file --diff3 -L HEAD -L base -L incoming %A %O %B" merge feature
npx package-conflicts-resolver --list
npx package-conflicts-resolver --pick lodash@4.17.21
```

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
-q, --quiet                   Suppress output except warnings and errors
-j, --json                    Output in JSON format
-v, --verbose                 Enable verbose logging
--no-regenerate-lock          Skip package-lock.json regeneration
-l, --list                    List conflicted packages with our and their versions, without changing anything
-p, --pick <name@version>     Resolve a conflicted package to this version instead of using the strategy (repeatable)
--no-version-check            Do not check that picked versions exist in the registry
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
  // Formatted like the original; values left for you are written between conflict markers
  await resolver.writeResolvedPackage(result.packageJson, "package.json", conflictedContent, result.unresolved)
}

// `result.unresolved` lists the values highest and lowest cannot decide: field, path,
// reason ("not-a-version", "not-comparable" or "removed"), ours, theirs (undefined for
// a branch that removed the value), and base when it is known.
// `result.packageJson` holds our value in their place until you decide.

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

Conflicts on package versions are reported in a structured form, and versions can be picked per package:

```typescript
// Every conflicting spec or locked version: name, kind ("spec" | "lock"), location, path,
// ours, theirs, base (when known), resolved, resolvedBy (the strategy, "pick", "removal" for
// a dependency that stays removed, or "user" for a value left for you). ours and theirs are
// null for a branch that removed the value; resolved is null when the value is removed or
// left for you.
for (const conflict of result.packageConflicts ?? []) {
  console.log(`${conflict.name} (${conflict.location}): ${conflict.ours} vs ${conflict.theirs} -> ${conflict.resolved}`)
}

// Pick versions for some packages; the strategy resolves every other conflict
const picks = {lodash: "4.17.21", typescript: "~5.5.4"}
const picker = new PackageResolver({...options, picks})
const picked = await picker.resolveConflicts(conflictedContent)

// Check picks like the CLI does before writing anything
import {findPickProblems, verifyVersionPicks, createNpmVersionLookup} from "package-conflicts-resolver"
const problems = findPickProblems(picks, picked.packageConflicts ?? []) // not conflicted, or cannot apply
const checks = await verifyVersionPicks(picks, {
  lookup: createNpmVersionLookup({cwd: projectDir}), // or your own (name) => {versions, distTags} | null
  cwd: projectDir,
})
const missing = checks.filter(check => check.status === "error")
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

**"left ... between conflict markers for you to decide" during `git merge`**

- The merge driver found values the strategy has no order for, such as a script both branches changed or removed on one branch, or two specs that cannot be compared, and left them for you between conflict markers; everything else is merged. Edit package.json, or run `package-conflicts-resolver` with `--pick <package>@<version>` or `--strategy ours` (or `theirs`), then `git add package.json` and finish the merge. See [Values left for you to decide](#values-left-for-you-to-decide).

**"our branch removed it, their change to ... was dropped" during `git merge`**

- One branch removed a dependency that the other branch upgraded, so it stays removed and the merge finished without it. If the code still needs it, add it back with `npm install <name>@<version>`. See [Resolution Strategies](#resolution-strategies).

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

## Development

The project is developed on Node 24, as pinned in `.nvmrc`:

```bash
nvm use
npm ci
npm run check # format check, type check, build and tests
```

## Support

If this tool saves you time, consider [sponsoring development on GitHub](https://github.com/sponsors/DanielAmenou).

## License

MIT &copy; [Daniel Amenou](https://github.com/DanielAmenou)
