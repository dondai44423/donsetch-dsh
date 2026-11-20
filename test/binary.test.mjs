/**
 * Binary provisioning tests against a local HTTP fixture: the full
 * download, SHA256 verification, extraction and cache lifecycle, plus
 * every failure mode that must refuse to install. The fixture serves
 * tarball + .sha256 sidecar exactly like GitHub Releases does.
 *
 * NOTE: the vendored http layer under test uses node:http internally,
 * so the fixture runs the same stack end to end (no undici sockets to
 * pin the runner: every request drains or is destroyed).
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

let artifact
let cacheRoot
let goodTarball
let goodHash
let tamperedTarball
let server
let tarballHits = 0
let serveMode = 'good'
let serveMissingSidecar = false
const servedVersions = new Set(['3.5.2', '3.5.3', '3.5.4', '3.5.5'])
let binaryApi

before(async () => {
  // Test-seam hygiene: DONSETCH_BIN would hijack resolveBinary past
  // the cache fixtures if the caller exported it on the process.
  delete process.env.DONSETCH_BIN
  artifact = mkdtempSync(join(tmpdir(), 'donsetch-dsh-bin-'))
  cacheRoot = join(artifact, 'cache')
  const payload = '#!/bin/sh\necho fake-donsetch\n'
  const stage = mkdtempSync(join(artifact, 'stage-'))
  mkdirSync(join(stage, 'pkg'), { recursive: true })
  binaryApi = await import('../dist/binary.js')

  const platform = binaryApi.PLATFORM
  const binaryName = platform.key === 'win32-x64' ? 'donsetch.exe' : 'donsetch'
  goodTarball = join(artifact, 'good.tar.gz')
  writeFileSync(join(stage, 'pkg', binaryName), payload)
  execFileSync('tar', ['-czf', goodTarball, '-C', join(stage, 'pkg'), '.'])
  goodHash = createHash('sha256').update(readFileSync(goodTarball)).digest('hex')

  tamperedTarball = join(artifact, 'tampered.tar.gz')
  writeFileSync(tamperedTarball, 'this is not a tarball at all')

  server = createServer((req, res) => {
    const versionMatch = /^\/v([^/]+)\//.exec(req.url)
    if (versionMatch && !servedVersions.has(versionMatch[1])) {
      res.statusCode = 404
      res.end('release not found')
      return
    }
    if (req.url.endsWith('.tar.gz.sha256')) {
      if (serveMissingSidecar) {
        res.statusCode = 404
        res.end('nope')
        return
      }
      res.setHeader('content-type', 'text/plain')
      res.end(goodHash + '  donsetch-linux-x64.tar.gz\n')
      return
    }
    if (req.url.endsWith('.tar.gz')) {
      tarballHits++
      if (serveMode === 'stalled-body') {
        res.writeHead(200, { 'content-type': 'application/gzip' })
        res.write(Buffer.from('partial-bytes'))
        // Intentionally never end() to simulate a mid-stream stall; clean up on close.
        req.on('close', () => res.destroy())
        return
      }
      const body = serveMode === 'tampered' ? readFileSync(tamperedTarball) : readFileSync(goodTarball)
      res.setHeader('content-type', 'application/gzip')
      res.end(body)
      return
    }
    res.statusCode = 404
    res.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  process.env.DONSETCH_DSH_RELEASES_BASE = `http://127.0.0.1:${server.address().port}`
  process.env.DONSETCH_DSH_CACHE_DIR = cacheRoot
})

after(async () => {
  delete process.env.DONSETCH_DSH_RELEASES_BASE
  delete process.env.DONSETCH_DSH_CACHE_DIR
  await new Promise((resolve) => server.close(resolve))
  rmSync(artifact, { recursive: true, force: true })
})

test('downloadBinary: happy path verifies, extracts, chmods, caches', async () => {
  const { downloadBinary, installedVersions, PLATFORM } = binaryApi
  const path = await downloadBinary('3.5.2', { timeoutMs: 15000 })
  assert.equal(path, join(cacheRoot, 'bin', '3.5.2', PLATFORM.key === 'win32-x64' ? 'donsetch.exe' : 'donsetch'))
  assert.ok(existsSync(path))
  if (process.platform !== 'win32') {
    assert.ok(statSync(path).mode & 0o100, 'binary must be executable')
  }
  assert.equal(readFileSync(path, 'utf8'), '#!/bin/sh\necho fake-donsetch\n')
  assert.equal(installedVersions().length, 1)
  // No temporary staging directories may survive in cacheRoot after install.
  assert.deepEqual(
    readdirSync(cacheRoot).filter((entry) => entry.startsWith('.tmp-')),
    [],
    'downloadBinary must clean up its .tmp-* staging directory on success',
  )
  // Idempotent: second call short-circuits on the cached install.
  const again = await downloadBinary('3.5.2', { timeoutMs: 15000 })
  assert.equal(again, path)
})

test('downloadBinary: SHA256 mismatch refuses to install and leaves no cache entry', async () => {
  const { downloadBinary, binaryAt } = binaryApi
  serveMode = 'tampered'
  await assert.rejects(() => downloadBinary('3.5.4', { timeoutMs: 15000 }), /SHA256 mismatch/)
  assert.equal(existsSync(binaryAt('3.5.4')), false)
  serveMode = 'good'
})

test('downloadBinary: missing sidecar refuses to install', async () => {
  const { downloadBinary, binaryAt } = binaryApi
  serveMissingSidecar = true
  await assert.rejects(() => downloadBinary('3.5.5', { timeoutMs: 15000 }), /unverifiable/)
  assert.equal(existsSync(binaryAt('3.5.5')), false)
  serveMissingSidecar = false
})

test('downloadBinary: non-semver version is refused before any network work', async () => {
  const { downloadBinary } = binaryApi
  await assert.rejects(() => downloadBinary('latest', { timeoutMs: 15000 }), /not a valid semver/)
  await assert.rejects(() => downloadBinary('3.5.2; rm -rf /', { timeoutMs: 15000 }), /not a valid semver/)
})

test('downloadBinary: missing release gets the actionable platform list', async () => {
  const { downloadBinary, binaryAt } = binaryApi
  await assert.rejects(() => downloadBinary('9.9.9', { timeoutMs: 15000 }), /does not ship a .* binary/)
  assert.equal(existsSync(binaryAt('9.9.9')), false)
})

test('concurrent downloads: one install, no torn cache', async () => {
  const { downloadBinary, installedVersions } = binaryApi
  tarballHits = 0
  const [a, b] = await Promise.all([
    downloadBinary('3.5.3', { timeoutMs: 15000 }),
    downloadBinary('3.5.3', { timeoutMs: 15000 }),
  ])
  assert.equal(a, b)
  assert.ok(existsSync(a))
  assert.equal(installedVersions().length, 2) // 3.5.2 + 3.5.3
})

test('resolveBinary: newest cached install wins over the pinned floor', async () => {
  const { resolveBinary } = binaryApi
  const resolved = await resolveBinary('3.5.2', false, { timeoutMs: 15000 })
  assert.equal(resolved.source, 'release')
  assert.match(resolved.version, /^3\.5\./)
})

test('resolveBinary: DONSETCH_BIN override wins over cache', async () => {
  const { resolveBinary } = binaryApi
  const sentinel = join(artifact, 'sentinel-bin')
  writeFileSync(sentinel, '#!/bin/sh\n')
  process.env.DONSETCH_BIN = sentinel
  try {
    const resolved = await resolveBinary('3.5.2', false, { timeoutMs: 15000 })
    assert.equal(resolved.path, sentinel)
    assert.equal(resolved.source, 'path')
  } finally {
    delete process.env.DONSETCH_BIN
  }
})

test('resolveBinary: upgrades when cached install is older than the pinned floor', async () => {
  const { resolveBinary } = binaryApi
  // 3.5.2 and 3.5.3 are cached; pinning 3.5.4 must install 3.5.4 instead of returning 3.5.3.
  const resolved = await resolveBinary('3.5.4', false, { timeoutMs: 15000 })
  assert.equal(resolved.source, 'release')
  assert.equal(resolved.version, '3.5.4')
  assert.ok(existsSync(resolved.path))
})

test('resolveBinary: falls back to verified cached release when offline and fallback is allowed', async () => {
  const { resolveBinary } = binaryApi
  // 9.9.9 returns 404 on the fixture server; allowPathFallback=true keeps the verified 3.5.4 cache entry.
  const fallback = await resolveBinary('9.9.9', true, { timeoutMs: 5000 })
  assert.equal(fallback.source, 'release')
  assert.equal(fallback.version, '3.5.4')
  // Strict callers (allowPathFallback=false) still see the download error.
  await assert.rejects(() => resolveBinary('9.9.9', false, { timeoutMs: 5000 }), /does not ship/)
})

test('resolveBinary: DONSETCH_BIN rejects directories and resolves bare names on PATH', async () => {
  const { resolveBinary } = binaryApi
  const dirOnly = mkdtempSync(join(artifact, 'not-a-bin-'))
  process.env.DONSETCH_BIN = dirOnly
  try {
    await assert.rejects(() => resolveBinary('3.5.4', false), /not a file/)
  } finally {
    delete process.env.DONSETCH_BIN
  }

  const pathDir = mkdtempSync(join(artifact, 'path-bin-'))
  const cmdName = process.platform === 'win32' ? 'custom-donsetch.exe' : 'custom-donsetch'
  const cmdPath = join(pathDir, cmdName)
  writeFileSync(cmdPath, '#!/bin/sh\n')
  const prevPath = process.env.PATH
  process.env.PATH = `${pathDir}${delimiter}${prevPath ?? ''}`
  process.env.DONSETCH_BIN = 'custom-donsetch'
  try {
    const resolved = await resolveBinary('3.5.4', false)
    assert.equal(resolved.path, cmdPath)
    assert.equal(resolved.source, 'path')
  } finally {
    process.env.PATH = prevPath
    delete process.env.DONSETCH_BIN
  }
})

test('downloadBinary: reaps stale .install.lock left by a dead PID', async () => {
  const { downloadBinary } = binaryApi
  const lockDir = join(cacheRoot, '.install.lock')
  mkdirSync(lockDir, { recursive: true })
  // 2147483646 is above OS PID ranges / dead, so process.kill(pid, 0) fails with ESRCH.
  writeFileSync(join(lockDir, 'owner.pid'), '2147483646\n')
  const start = Date.now()
  const path = await downloadBinary('3.5.5', { timeoutMs: 5000 })
  assert.ok(existsSync(path))
  assert.ok(Date.now() - start < 3000, 'dead-owner lock must be reaped immediately')
  assert.equal(existsSync(lockDir), false)
})

test('downloadBinary: stalled tarball body times out instead of hanging forever', async () => {
  const { downloadBinary, binaryAt } = binaryApi
  servedVersions.add('3.5.6')
  serveMode = 'stalled-body'
  const start = Date.now()
  try {
    await assert.rejects(() => downloadBinary('3.5.6', { timeoutMs: 400 }), /timed out/)
    assert.ok(Date.now() - start < 4000, 'stalled body must abort near timeoutMs')
    assert.equal(existsSync(binaryAt('3.5.6')), false)
    assert.deepEqual(
      readdirSync(cacheRoot).filter((entry) => entry.startsWith('.tmp-')),
      [],
      'stalled download must clean up .tmp-* directory',
    )
  } finally {
    serveMode = 'good'
    servedVersions.delete('3.5.6')
  }
})
