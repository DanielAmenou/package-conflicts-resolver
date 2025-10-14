# Package Conflicts Resolver

A Node.js CLI tool that automatically resolves conflicts in `package.json` and `package-lock.json` files.

## Features

- **Automatic conflict resolution** with configurable strategies
- **Smart version resolution** using semver
- **Git integration** as merge driver or in hooks
- **Stable JSON formatting** - preserves field order and structure

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
package-conflicts-resolver setup

# Verify the setup is working
package-conflicts-resolver verify
```

That's it! The tool will now automatically resolve conflicts in `package.json` and `package-lock.json` during Git merges.

### Basic Usage

```bash
# Resolve conflicts in package.json
package-conflicts-resolver

# Resolve conflicts in specific file
package-conflicts-resolver path/to/package.json

# Dry run to see what would be changed
package-conflicts-resolver --dry-run

# Use different resolution strategy
package-conflicts-resolver --strategy lowest
```

### Resolution Strategies

- `highest` (default) - Use the highest version
- `lowest` - Use the lowest version
- `ours` - Use our version (current branch)
- `theirs` - Use their version (incoming branch)

### Commands

```bash
# Main commands
package-conflicts-resolver [file]           # Resolve conflicts in file (default: package.json)
package-conflicts-resolver setup            # Setup Git integration for current repository
package-conflicts-resolver setup --global   # Setup Git integration globally
package-conflicts-resolver uninstall        # Remove Git integration for current repository
package-conflicts-resolver uninstall --global # Remove global Git integration
package-conflicts-resolver verify           # Verify Git integration is working
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

## License

MIT &copy; [Daniel Amenou](https://github.com/DanielAmenou)
