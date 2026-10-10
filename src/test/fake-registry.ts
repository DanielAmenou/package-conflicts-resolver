/**
 * A local npm registry for tests: it serves package documents for a fixed set
 * of packages, so the real npm CLI can look versions up (`npm view`) and
 * build lockfiles (`npm install --package-lock-only`, which needs no
 * tarball) without a network.
 *
 * Two names behave badly on purpose: "broken" answers with a 500 and
 * "hanging" never answers.
 */

import {createHash} from "node:crypto"
import {createServer} from "node:http"
import {AddressInfo} from "node:net"
import {mkdtemp, rm} from "fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"

export interface FakePackage {
  versions: string[]
  /** Defaults to {latest: <last version>} */
  distTags?: Record<string, string>
}

export interface FakeRegistry {
  url: string
  /** Names of the packages npm asked for, in order */
  requests: string[]
  /**
   * Environment that points npm at this registry and keeps it away from the
   * user's own npm configuration, cache and proxies.
   */
  npmEnv: Record<string, string>
  close(): Promise<void>
}

/** The integrity npm records for a package version (stable, never checked: no tarball is downloaded) */
export function fakeIntegrity(name: string, version: string): string {
  return `sha512-${createHash("sha512").update(`${name}@${version}`).digest("base64")}`
}

export async function startFakeRegistry(packages: Record<string, FakePackage | string[]>): Promise<FakeRegistry> {
  const requests: string[] = []
  let base = ""

  const packument = (name: string, spec: FakePackage | string[]) => {
    const {versions, distTags} = Array.isArray(spec) ? {versions: spec, distTags: undefined} : spec
    return {
      name: name,
      "dist-tags": distTags ?? {latest: versions[versions.length - 1]},
      versions: Object.fromEntries(
        versions.map(version => [
          version,
          {
            name,
            version,
            dist: {
              tarball: `${base}${name}/-/${name.split("/").pop()}-${version}.tgz`,
              integrity: fakeIntegrity(name, version),
            },
          },
        ])
      ),
    }
  }

  const server = createServer((request, response) => {
    const name = decodeURIComponent((request.url ?? "/").slice(1).split("?")[0] as string)
    requests.push(name)
    if (name === "hanging") {
      return
    }
    if (name === "broken") {
      response.writeHead(500)
      response.end("internal error")
      return
    }
    const spec = Object.prototype.hasOwnProperty.call(packages, name) ? packages[name] : undefined
    response.writeHead(spec !== undefined ? 200 : 404, {"content-type": "application/json"})
    response.end(JSON.stringify(spec !== undefined ? packument(name, spec) : {error: "Not found"}))
  })

  await new Promise<void>(resolvePromise => server.listen(0, "127.0.0.1", resolvePromise))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
  const home = await mkdtemp(join(tmpdir(), "pcr-npm-"))

  return {
    url: base,
    requests,
    npmEnv: {
      npm_config_registry: base,
      npm_config_cache: join(home, "cache"),
      npm_config_userconfig: join(home, "user.npmrc"),
      npm_config_globalconfig: join(home, "global.npmrc"),
      npm_config_noproxy: "127.0.0.1,localhost",
      npm_config_fetch_retries: "0",
      npm_config_update_notifier: "false",
      npm_config_audit: "false",
      npm_config_fund: "false",
    },
    async close() {
      server.closeAllConnections()
      await new Promise(resolvePromise => server.close(resolvePromise))
      // Retried: on Windows the folder stays busy for a moment after npm exits
      await rm(home, {recursive: true, force: true, maxRetries: 10, retryDelay: 100})
    },
  }
}
