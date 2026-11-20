/**
 * Binary provisioning: resolve an existing donsetch binary, download
 * and SHA256-verify one from GitHub Releases when missing, extract it
 * (system tar, present on every supported OS), and check for newer
 * releases on a throttled schedule. No deps.
 */

import { compareSemver, isNewer, parseSemver, type Semver } from './version.js'

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

const REPO = 'dondai44423/donsetch'
// Internal seam: tests point these at a local HTTP fixture. Read at
// call time so tests can set the env after module import.
function releasesBase(): string {
  return process.env.DONSETCH_DSH_RELEASES_BASE?.trim() || `https://github.com/${REPO}/releases/download`
}
function apiBase(): string {
  return process.env.DONSETCH_DSH_API_BASE?.trim() || `https://api.github.com/repos/${REPO}`
}
const MAX_DOWNLOAD_BYTES = 300 * 1024 * 1024

const BINARY_NAME = process.platform === 'win32' ? 'donsetch.exe' : 'donsetch'

interface PlatformInfo {
  key: string
  asset: string
  supported: boolean
}

/**
 * Exactly the targets the donsetch release pipeline ships. Anything
 * else is unsupported and fails with the actionable list in the
 * download error, never with a guessed asset name (musl is not built
 * by the release workflow; do not claim it).
 */
function platformInfo(): PlatformInfo {
  if (process.platform === 'linux' && process.arch === 'x64') {
    return { key: 'linux-x64', asset: 'donsetch-linux-x64.tar.gz', supported: true }
  }
  if (process.platform === 'linux' && process.arch === 'arm64') {
    return { key: 'linux-arm64', asset: 'donsetch-linux-arm64.tar.gz', supported: true }
  }
  if (process.platform === 'darwin' && process.arch === 'arm64') {
    return { key: 'darwin-arm64', asset: 'donsetch-darwin-arm64.tar.gz', supported: true }
  }
  if (process.platform === 'darwin' && process.arch === 'x64') {
    return { key: 'darwin-x64', asset: 'donsetch-darwin-x64.tar.gz', supported: true }
  }
  if (process.platform === 'win32' && process.arch === 'x64') {
    return { key: 'win32-x64', asset: 'donsetch-win32-x64.tar.gz', supported: true }
  }
  return { key: `${process.platform}-${process.arch}`, asset: 'unsupported', supported: false }
}

export const PLATFORM = platformInfo()

export function cacheDir(): string {
  const env = process.env.DONSETCH_DSH_CACHE_DIR
  if (env && env.trim()) return env.trim()
  const home = process.env.DONSETCH_DSH_HOME?.trim() || homedir()
  return join(home, '.cache', 'donsetch', 'dsh')
}

export function binDir(version: string): string {
  return join(cacheDir(), 'bin', version)
}

export function binaryAt(version: string): string {
  return join(binDir(version), BINARY_NAME)
}

/** Latest installed version under the cache, or null. */
export function installedVersions(): Semver[] {
  const root = join(cacheDir(), 'bin')
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return []
  }
  const out: Semver[] = []
  for (const entry of entries) {
    const parsed = parseSemver(entry)
    if (parsed === null) continue
    if (!isRegularFile(join(root, entry, BINARY_NAME))) continue
    out.push(parsed)
  }
  return out
}

export interface ResolvedBinary {
  path: string
  version: string
  source: 'release' | 'path'
}

export interface DownloadOptions {
  /** Timeouts in ms. */
  timeoutMs?: number
  onProgress?(state: string): void
}

/**
 * Resolve the binary to run. Order:
 *  1. DONSETCH_BIN env override (absolute or on PATH).
 *  2. The newest verified release binary already in the cache.
 *  3. A fresh download of `pinned` from GitHub Releases, verified.
 *  4. A `donsetch` on PATH, when allowPathFallback (degraded).
 */
function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function findOnPath(name: string): string | null {
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  const suffixes =
    process.platform === 'win32' && !/\.(exe|cmd|bat)$/i.test(name)
      ? ['', '.exe', '.cmd', '.bat']
      : ['']
  for (const dir of dirs) {
    for (const suffix of suffixes) {
      const candidate = join(dir, name + suffix)
      if (isRegularFile(candidate)) return candidate
    }
  }
  return null
}

function resolveEnvBinary(spec: string): string | null {
  if (spec.includes('/') || spec.includes('\\') || isRegularFile(spec)) {
    return isRegularFile(spec) ? spec : null
  }
  return findOnPath(spec)
}

export async function resolveBinary(
  pinned: string,
  allowPathFallback: boolean,
  options: DownloadOptions = {},
): Promise<ResolvedBinary> {
  const env = process.env.DONSETCH_BIN?.trim()
  if (env) {
    const resolvedEnv = resolveEnvBinary(env)
    if (resolvedEnv !== null) return { path: resolvedEnv, version: 'env', source: 'path' }
    throw new Error(`DONSETCH_BIN points at ${env}, which does not exist or is not a file.`)
  }

  const installed = installedVersions().sort((a, b) => compareSemver(versionString(a), versionString(b)))
  const newest = installed.length > 0 ? versionString(installed[installed.length - 1]!) : null
  const newestPath = newest !== null ? binaryAt(newest) : null
  const hasCached = newest !== null && newestPath !== null && isRegularFile(newestPath)
  // Honor pinned as a minimum floor while allowing newer auto-updated
  // installs in the cache to win.
  if (hasCached && (parseSemver(pinned) === null || !isNewer(pinned, newest))) {
    return { path: newestPath, version: newest, source: 'release' }
  }

  try {
    const path = await downloadBinary(pinned, options)
    return { path, version: pinned, source: 'release' }
  } catch (err) {
    if (!allowPathFallback) throw err
    if (hasCached) {
      options.onProgress?.(`donsetch v${pinned} download failed; using cached v${newest}`)
      return { path: newestPath, version: newest, source: 'release' }
    }
    // Last resort: any donsetch already on this machine. Version may
    // lag the plugin's tools; the status tool says so.
    const onPath = whichDonsetch()
    if (onPath !== null) {
      options.onProgress?.('donsetch download failed; using donsetch from PATH (degraded)')
      return { path: onPath, version: 'path', source: 'path' }
    }
    throw err
  }
}

function versionString(v: Semver): string {
  const pre = v.prerelease.length > 0 ? `-${v.prerelease.join('.')}` : ''
  return `${v.major}.${v.minor}.${v.patch}${pre}`
}

function whichDonsetch(): string | null {
  return findOnPath(BINARY_NAME)
}

const STALE_LOCK_MAX_AGE_MS = 10 * 60_000

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'EPERM'
  }
}

function isStaleLock(lock: string, ownerFile: string): boolean {
  try {
    if (existsSync(ownerFile)) {
      const pid = Number(readFileSync(ownerFile, 'utf8').trim())
      if (Number.isInteger(pid) && pid > 0) {
        return !isProcessAlive(pid)
      }
    }
    return Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MAX_AGE_MS
  } catch {
    return false
  }
}

async function acquireLock(dir: string, timeoutMs: number): Promise<void> {
  mkdirSync(dir, { recursive: true })
  const lock = join(dir, '.install.lock')
  const ownerFile = join(lock, 'owner.pid')
  const start = Date.now()
  for (;;) {
    try {
      mkdirSync(lock)
      try {
        writeFileSync(ownerFile, `${process.pid}\n`)
      } catch {
        // Best-effort owner stamp; age check still covers unlabeled locks.
      }
      return
    } catch {
      if (isStaleLock(lock, ownerFile)) {
        rmSync(lock, { recursive: true, force: true })
        continue
      }
      if (Date.now() - start > timeoutMs) {
        throw new Error('timed out waiting for another donsetch install to finish (stale lock?)')
      }
      await new Promise((r) => setTimeout(r, 100))
    }
  }
}

function releaseLock(dir: string): void {
  try {
    rmSync(join(dir, '.install.lock'), { recursive: true, force: true })
  } catch {
    // Best effort.
  }
}

/** Extract the .tar.gz with the OS tar (Windows 10 1803+ ships bsdtar). */
function extract(tarball: string, dest: string): void {
  mkdirSync(dest, { recursive: true })
  const r = spawnSync('tar', ['-xzf', tarball, '-C', dest], { encoding: 'utf8', timeout: 120_000 })
  if (r.error) throw new Error(`tar extraction failed: ${r.error.message}`)
  if (r.status !== 0) throw new Error(`tar extraction failed: ${(r.stderr || r.stdout || '').trim()}`)
}

/**
 * Download the pinned release asset, verify its .sha256 sidecar,
 * extract to its own versioned dir, and atomically swap it in.
 */
export async function downloadBinary(version: string, options: DownloadOptions = {}): Promise<string> {
  const parsed = parseSemver(version)
  if (parsed === null) throw new Error(`refusing to download donsetch version ${version}: not a valid semver`)

  const root = cacheDir()
  const timeout = options.timeoutMs ?? 120_000

  await acquireLock(root, timeout)
  try {
    if (!PLATFORM.supported) {
      throw new Error(
        `donsetch does not ship a binary for ${PLATFORM.key}. Supported platforms: linux-x64, linux-arm64, darwin-x64, darwin-arm64, win32-x64.`,
      )
    }
    // Already fully installed? Short-circuit (also covers races).
    const target = binaryAt(version)
    if (isRegularFile(target)) return target

    const asset = PLATFORM.asset
    const base = `${releasesBase()}/v${version}/${asset}`

    const tarballResp = await httpGet(`${base}`, timeout).catch(() => null)
    if (tarballResp === null) throw new Error(`could not reach ${releasesBase()} (network down?) while installing donsetch v${version}`)
    if (!tarballResp.ok) {
      await tarballResp.drain()
      throw new Error(
        `donsetch does not ship a ${PLATFORM.key} binary for v${version} (release fetch returned HTTP ${tarballResp.status}). Supported platforms: linux-x64, linux-arm64, darwin-x64, darwin-arm64, win32-x64.`,
      )
    }

    const sidecarResp = await httpGet(`${base}.sha256`, timeout).catch(() => null)
    if (sidecarResp === null || !sidecarResp.ok) {
      if (sidecarResp !== null) await sidecarResp.drain()
      await tarballResp.drain()
      throw new Error(`donsetch v${version} ${PLATFORM.key} asset found but its .sha256 sidecar is missing; refusing to install an unverifiable binary`)
    }
    let sidecarText: string
    try {
      sidecarText = (await sidecarResp.text(64 * 1024)).trim()
    } catch (err) {
      await tarballResp.drain()
      throw err
    }
    const sidecarMatch = /^([a-f0-9]{64})(?:\s|$)/.exec(sidecarText)
    if (sidecarMatch === null) {
      await tarballResp.drain()
      throw new Error(`donsetch v${version} .sha256 sidecar is malformed; refusing to install`)
    }
    const expected = sidecarMatch[1]!

    mkdirSync(root, { recursive: true })
    const tmpDir = join(root, `.tmp-${process.pid}-${Date.now()}`)
    const tarballPath = join(tmpDir, 'donsetch.tar.gz')
    const extractDir = join(tmpDir, 'out')
    mkdirSync(tmpDir, { recursive: true })

    try {
      options.onProgress?.(`downloading donsetch v${version} for ${PLATFORM.key}`)
      const hash = createHash('sha256')
      let bytes = 0
      const chunks: Buffer[] = []
      for await (const buf of tarballResp) {
        bytes += buf.length
        if (bytes > MAX_DOWNLOAD_BYTES) throw new Error('download exceeds the 300 MB guard; aborting')
        hash.update(buf)
        chunks.push(buf)
      }
      const digest = hash.digest('hex')
      if (digest !== expected) {
        throw new Error(`SHA256 mismatch for donsetch v${version} ${PLATFORM.key}: expected ${expected}, got ${digest}`)
      }
      writeFileSync(tarballPath, Buffer.concat(chunks))

      options.onProgress?.(`verifying and extracting donsetch v${version}`)
      extract(tarballPath, extractDir)
      const extracted = join(extractDir, BINARY_NAME)
      if (!isRegularFile(extracted)) {
        throw new Error(`expected ${BINARY_NAME} after extraction but it is missing; refusing to install`)
      }
      if (process.platform !== 'win32') chmodSync(extracted, 0o755)
      const finalDir = binDir(version)
      mkdirSync(join(cacheDir(), 'bin'), { recursive: true })
      if (existsSync(finalDir)) rmSync(finalDir, { recursive: true, force: true })
      renameSync(extractDir, finalDir)
      return binaryAt(version)
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  } finally {
    releaseLock(root)
  }
}

export interface HttpResult {
  ok: boolean
  status: number
  /** Drain and discard the body, releasing the socket. */
  drain(): Promise<void>
  /** Full body text, capped; rejects when the cap is exceeded. */
  text(maxBytes: number): Promise<string>
  /** Async-iterable body chunks. */
  [Symbol.asyncIterator](): AsyncIterator<Buffer>
}

function httpResult(res: IncomingMessage): HttpResult {
  const consumed = { done: false }
  let streamError: Error | null = null
  res.on('error', (err) => {
    streamError = err instanceof Error ? err : new Error(String(err))
  })
  res.on('end', () => {
    consumed.done = true
  })
  res.on('close', () => {
    consumed.done = true
  })
  const drain = (): Promise<void> =>
    new Promise((resolve) => {
      if (consumed.done || res.destroyed || res.complete) {
        consumed.done = true
        resolve()
        return
      }
      consumed.done = true
      res.resume()
      res.once('end', resolve)
      res.once('error', () => resolve())
      res.once('close', resolve)
    })
  return {
    ok: res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300,
    status: res.statusCode ?? 0,
    drain,
    text(maxBytes: number): Promise<string> {
      return new Promise((resolve, reject) => {
        if (streamError !== null) {
          reject(streamError)
          return
        }
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > maxBytes) {
            consumed.done = true
            res.destroy()
            reject(new Error(`response body exceeds ${maxBytes} bytes`))
            return
          }
          chunks.push(chunk)
        })
        res.on('end', () => {
          consumed.done = true
          resolve(Buffer.concat(chunks).toString('utf8'))
        })
        res.on('error', reject)
      })
    },
    [Symbol.asyncIterator]() {
      if (streamError !== null) {
        const err = streamError
        return {
          next: () => Promise.reject(err),
        }
      }
      return res[Symbol.asyncIterator]() as AsyncIterator<Buffer>
    },
  }
}

/**
 * GET with timeout + redirect following, via raw node:http(s). No
 * undici, no pooled sockets: every request owns its socket and the
 * body contract (drain/text/iterate) guarantees release. The timeout
 * covers both response headers and full body transfer so a stalled CDN
 * stream cannot hold the install lock forever.
 */
function httpGet(url: string, timeoutMs: number): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    const makeTimeoutError = (): Error => new Error(`request timed out after ${timeoutMs}ms`)
    const driver = (target: string, redirectsLeft: number): void => {
      let parsed: URL
      try {
        parsed = new URL(target)
      } catch {
        reject(new Error(`invalid URL: ${target}`))
        return
      }
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        reject(makeTimeoutError())
        return
      }
      let activeRes: IncomingMessage | null = null
      const mod = parsed.protocol === 'https:' ? httpsRequest : httpRequest
      const timer = setTimeout(() => {
        const err = makeTimeoutError()
        if (activeRes !== null) activeRes.destroy(err)
        req.destroy(err)
        reject(err)
      }, remaining)
      const req = mod(
        parsed,
        { method: 'GET', headers: { 'user-agent': 'donsetch-dsh-plugin', accept: '*/*', connection: 'close' } },
        (res) => {
          activeRes = res
          const result = httpResult(res)
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            if (redirectsLeft <= 0) {
              clearTimeout(timer)
              void result.drain().finally(() => reject(new Error('too many redirects')))
              return
            }
            const next = new URL(res.headers.location, parsed).toString()
            if (next !== target && (next.startsWith('http://') || next.startsWith('https://'))) {
              void result.drain().finally(() => {
                clearTimeout(timer)
                driver(next, redirectsLeft - 1)
              })
              return
            }
          }
          const clear = (): void => clearTimeout(timer)
          res.once('end', clear)
          res.once('close', clear)
          resolve(result)
        },
      )
      req.on('error', (err) => {
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      })
      req.end()
    }
    driver(url, 5)
  })
}

export interface UpdateInfo {
  current: string
  latest: string
  newer: boolean
}

/** Fetch the newest suitable release tag; null on network failure. */
async function fetchLatestTag(channel: 'stable' | 'latest'): Promise<string | null> {
  try {
    if (channel === 'stable') {
      const resp = await httpGet(`${apiBase()}/releases/latest`, 15_000).catch(() => null)
      if (resp === null || !resp.ok) {
        if (resp !== null) await resp.drain()
        return null
      }
      const body = (JSON.parse(await resp.text(2 * 1024 * 1024).catch(() => '{}')) ?? {}) as { tag_name?: unknown }
      if (typeof body.tag_name === 'string') return body.tag_name
      return null
    }
    const resp = await httpGet(`${apiBase()}/releases?per_page=10`, 15_000).catch(() => null)
    if (resp === null || !resp.ok) {
      if (resp !== null) await resp.drain()
      return null
    }
    const body = (JSON.parse(await resp.text(2 * 1024 * 1024).catch(() => '[]')) ?? []) as Array<{ tag_name?: unknown; prerelease?: unknown }>
    for (const release of body) {
      if (typeof release.tag_name !== 'string') continue
      if (parseSemver(release.tag_name) === null) continue
      return release.tag_name
    }
    return null
  } catch {
    return null
  }
}

let lastCheckAt = 0

/**
 * Update check, throttled to `intervalHours`. Never throws: update
 * failures must not block tool service. Returns null when nothing
 * new on the channel.
 */
export async function checkForUpdate(
  currentVersion: string,
  channel: 'stable' | 'latest',
  intervalHours: number,
): Promise<UpdateInfo | null> {
  const intervalMs = Math.max(1, intervalHours) * 3600_000
  const now = Date.now()
  if (now - lastCheckAt < intervalMs) return null
  lastCheckAt = now
  try {
    const tag = await fetchLatestTag(channel)
    if (tag === null) return null
    if (parseSemver(tag) === null) return null
    if (isNewer(tag, currentVersion)) {
      return { current: currentVersion, latest: tag, newer: true }
    }
    return null
  } catch {
    return null
  }
}