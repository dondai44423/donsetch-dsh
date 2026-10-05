/**
 * Native web_search routing (donsetch-dsh#4): the plugin registers a
 * `donsetch` search provider on the ctx.web seam, and one provider
 * search drives a real tools/call to the (fake) daemon and maps the
 * result into the seam's WebSearchResult shape.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const { apply } = await import('../dist/index.js')

const HERE = dirname(fileURLToPath(import.meta.url))
const FAKE = join(HERE, 'fake-mcp-server.mjs')

let artifact
let searchArgsLog

before(() => {
  artifact = mkdtempSync(join(tmpdir(), 'donsetch-dsh-web-'))
  searchArgsLog = join(artifact, 'search-args.log')
  process.env.FAKE_SEARCH_ARGS_LOG = searchArgsLog
  process.env.DONSETCH_BIN = process.platform === 'win32' ? join(HERE, 'fake-mcp-server.cmd') : FAKE
  process.env.DONSETCH_DSH_HOME = join(artifact, 'home')
  process.env.DONSETCH_DSH_AUTOUPDATE = 'off'
  chmodSync(FAKE, 0o755)
})

after(() => {
  delete process.env.FAKE_SEARCH_ARGS_LOG
  delete process.env.DONSETCH_BIN
  delete process.env.DONSETCH_DSH_HOME
  delete process.env.DONSETCH_DSH_AUTOUPDATE
  rmSync(artifact, { recursive: true, force: true })
})

/** A minimal ctx.web seam with the real registry's duplicate semantics. */
function fakeWebSeam() {
  const providers = new Map()
  return {
    providers,
    registerSearchProvider(provider) {
      if (providers.has(provider.id)) throw new Error(`duplicate provider ${provider.id}`)
      providers.set(provider.id, provider)
      return () => providers.delete(provider.id)
    },
  }
}

/** The smallest ctx the plugin accepts: tools registry, effect, logging. */
function fakeCtx({ web, inject } = {}) {
  const ctx = {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    effect(fn) {
      const d = fn()
      return { dispose: () => (typeof d === 'function' ? d() : undefined) }
    },
    on: () => () => {},
    tools: { register: () => () => {} },
    get: (id) => (id === 'web' ? web : undefined),
  }
  if (inject !== undefined) ctx.inject = inject
  return ctx
}

test('apply registers the donsetch provider and one search flows through the daemon', async () => {
  const web = fakeWebSeam()
  const ctx = fakeCtx({ web })
  const handle = apply(ctx, { fallbackToPath: false, callTimeoutMs: 8000, bootTimeoutMs: 8000 })
  try {
    assert.ok(web.providers.has('donsetch'), 'the donsetch provider must be registered at apply time')
    const provider = web.providers.get('donsetch')
    assert.equal(provider.id, 'donsetch')
    assert.equal(provider.available(), true)

    const result = await provider.search({ query: 'rust language', maxResults: 3 })
    assert.equal(result.truncated, false)
    assert.equal(result.sources.length, 2, JSON.stringify(result))
    assert.deepEqual(result.sources[0], {
      url: 'https://example.com/a',
      title: 'Example A',
      snippet: 'first snippet',
    })
    assert.deepEqual(result.sources[1], {
      url: 'https://example.com/b',
      title: 'Example B',
      snippet: 'second snippet',
    })

    // maxResults rode through to the daemon call as max_results.
    const argsLine = readFileSync(searchArgsLog, 'utf8').trim().split('\n').pop()
    assert.deepEqual(JSON.parse(argsLine), { query: 'rust language', max_results: 3 })
  } finally {
    await handle.dispose()
  }
})

test('a daemon error result becomes a provider error carrying a code', async () => {
  const web = fakeWebSeam()
  const ctx = fakeCtx({ web })
  const handle = apply(ctx, { fallbackToPath: false, callTimeoutMs: 8000, bootTimeoutMs: 8000 })
  try {
    const provider = web.providers.get('donsetch')
    await assert.rejects(
      () => provider.search({ query: 'fail me' }),
      (err) => {
        assert.equal(err.code, 'WEB_PROVIDER_ERROR')
        assert.match(String(err.message), /search failed/)
        return true
      },
    )
  } finally {
    await handle.dispose()
  }
})

test('no seam and no ctx.inject: the plugin still loads without crashing', async () => {
  const ctx = fakeCtx({})
  delete ctx.get
  const handle = apply(ctx, { fallbackToPath: false, callTimeoutMs: 8000, bootTimeoutMs: 8000 })
  try {
    // The tools path is covered by apply.test.mjs; here the only claim is
    // that a profile with no web seam loads and disposes cleanly.
    await new Promise((resolve) => setTimeout(resolve, 50))
  } finally {
    await handle.dispose()
  }
})

test('a late-activating seam still receives the provider (ctx.inject fallback)', async () => {
  const web = fakeWebSeam()
  let deferred = null
  const ctx = fakeCtx({})
  delete ctx.get
  ctx.inject = (names, cb) => {
    assert.deepEqual(names, ['web'])
    deferred = cb
    return { dispose() {} }
  }
  const handle = apply(ctx, { fallbackToPath: false, callTimeoutMs: 8000, bootTimeoutMs: 8000 })
  try {
    assert.equal(web.providers.size, 0)
    assert.ok(typeof deferred === 'function', 'the plugin must wait on ctx.inject')
    deferred({ get: (id) => (id === 'web' ? web : undefined) })
    assert.ok(web.providers.has('donsetch'))
  } finally {
    await handle.dispose()
  }
})
