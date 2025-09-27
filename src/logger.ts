/**
 * Logging utility with support for human-readable and JSON output
 */

import {LoggerOptions, ResolvedConflict} from "./types.js"

export class Logger {
  private options: LoggerOptions

  constructor(options: LoggerOptions) {
    this.options = options
  }

  info(message: string, data?: any): void {
    if (this.options.quiet) return

    if (this.options.json) {
      console.log(
        JSON.stringify({
          level: "info",
          message,
          data,
          timestamp: new Date().toISOString(),
        })
      )
    } else {
      console.log(`ℹ ${message}`)
      if (data && this.options.verbose) {
        console.log(JSON.stringify(data, null, 2))
      }
    }
  }

  success(message: string, data?: any): void {
    if (this.options.quiet) return

    if (this.options.json) {
      console.log(
        JSON.stringify({
          level: "success",
          message,
          data,
          timestamp: new Date().toISOString(),
        })
      )
    } else {
      console.log(`✅ ${message}`)
      if (data && this.options.verbose) {
        console.log(JSON.stringify(data, null, 2))
      }
    }
  }

  warn(message: string, data?: any): void {
    if (this.options.json) {
      console.log(
        JSON.stringify({
          level: "warn",
          message,
          data,
          timestamp: new Date().toISOString(),
        })
      )
    } else {
      console.warn(`⚠️  ${message}`)
      if (data && this.options.verbose) {
        console.warn(JSON.stringify(data, null, 2))
      }
    }
  }

  error(message: string, data?: any): void {
    if (this.options.json) {
      console.error(
        JSON.stringify({
          level: "error",
          message,
          data,
          timestamp: new Date().toISOString(),
        })
      )
    } else {
      console.error(`❌ ${message}`)
      if (data) {
        console.error(JSON.stringify(data, null, 2))
      }
    }
  }

  debug(message: string, data?: any): void {
    if (!this.options.verbose || this.options.quiet) return

    if (this.options.json) {
      console.log(
        JSON.stringify({
          level: "debug",
          message,
          data,
          timestamp: new Date().toISOString(),
        })
      )
    } else {
      console.log(`🔍 ${message}`)
      if (data) {
        console.log(JSON.stringify(data, null, 2))
      }
    }
  }

  logConflicts(conflicts: ResolvedConflict[]): void {
    if (this.options.quiet) return

    if (this.options.json) {
      console.log(
        JSON.stringify({
          level: "info",
          message: "Resolved conflicts",
          data: {conflicts},
          timestamp: new Date().toISOString(),
        })
      )
    } else {
      console.log("\n📋 Resolved Conflicts:")
      console.log("─".repeat(50))

      for (const conflict of conflicts) {
        console.log(`Field: ${conflict.field}`)
        console.log(`  Our value:      ${conflict.ourValue}`)
        console.log(`  Their value:    ${conflict.theirValue}`)
        console.log(`  Resolved value: ${conflict.resolvedValue} (${conflict.strategy})`)
        console.log("")
      }
    }
  }

  summary(resolved: number, total: number, dryRun: boolean): void {
    if (this.options.quiet) return

    const message = dryRun ? `Would resolve ${resolved}/${total} conflicts` : `Resolved ${resolved}/${total} conflicts`

    if (this.options.json) {
      console.log(
        JSON.stringify({
          level: "info",
          message,
          data: {resolved, total, dryRun},
          timestamp: new Date().toISOString(),
        })
      )
    } else {
      console.log(`\n📊 Summary: ${message}`)
    }
  }
}
