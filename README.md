# Package Conflicts Resolver

A Node.js CLI tool that automatically resolves conflicts in `package.json` and `package-lock.json` files.

## Features

- 🔄 **Automatic conflict resolution** with configurable strategies
- 🎯 **Smart version resolution** using semver
- 🔧 **Git integration** as merge driver or in hooks
- 📝 **Comprehensive logging** with human-readable and JSON output
- ✅ **Stable JSON formatting** - preserves field order and structure

## Installation

```bash
# Global installation
npm install -g package-conflicts-resolver

# Local installation
npm install --save-dev package-conflicts-resolver

# Use with npx (no installation needed)
npx package-conflicts-resolver
```

## Usage

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

### Options

```bash
-s, --strategy <strategy>     Resolution strategy (highest, lowest, ours, theirs)
-d, --dry-run                 Show what would be done without making changes
-q, --quiet                   Suppress output except errors
-j, --json                    Output in JSON format
-v, --verbose                 Enable verbose logging
--no-regenerate-lock          Skip package-lock.json regeneration
```

## Git Integration

### As Git Merge Driver

Set up automatic conflict resolution during Git merges:

```bash
# Setup for current repository
package-conflicts-resolver setup

# Setup globally for all repositories
package-conflicts-resolver setup --global
```

Then add to your `.gitattributes`:

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

## Requirements

- Node.js 20+
- npm (for package-lock.json regeneration)

## License

MIT &copy; [Daniel Amenou](https://github.com/DanielAmenou)
