import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { installSkill, maybeCheckUpdates, renderSkill, skillPath } from './skill-updates.mjs'

const DAY = 86400000
const old = '---\nname: weeny\ndescription: Deploy apps\n---\nOld guide: npx weeny-cloud push\n'
const latest = old.replace('Old guide', 'Current guide') + 'https://weeny.cloud\n'
const hash = text => createHash('sha256').update(text).digest('hex')

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'weeny-skill-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const env = { production: false, api: 'http://127.0.0.1:3123', dir: join(home, 'profile') }
  const cli = join(home, 'candidate with spaces', 'cli.mjs'), path = skillPath(env, home), cache = join(env.dir, 'skill-update.json')
  mkdirSync(dirname(path), { recursive: true })
  const writeSkill = source => writeFileSync(path, renderSkill(source, env, cli))
  const state = () => JSON.parse(readFileSync(cache, 'utf8'))
  return { home, env, cli, path, cache, writeSkill, state }
}

function requests(fetchImpl) {
  const calls = []
  return { calls, fetchImpl(...args) { calls.push(args); return fetchImpl(...args) } }
}

test('install records source and installed hashes, isolates staging, and clears old notices', async t => {
  const f = fixture(t)
  writeFileSync(f.cache, JSON.stringify({ notifiedAt: Date.now(), latestHash: 'stale' }))
  await installSkill(f.env, f.cli, { home: f.home, now: 1000, fetchImpl: async (url, opts) => {
    assert.equal(url, f.env.api + '/weeny-skill.md'); assert.equal(opts.redirect, 'error')
    assert.equal(opts.headers, undefined)
    return new Response(latest)
  } })
  assert.equal(readFileSync(f.path, 'utf8'), renderSkill(latest, f.env, f.cli))
  assert.match(readFileSync(f.path, 'utf8'), /WEENY_ENV=staging/)
  assert.equal(f.state().sourceHash, hash(latest))
  assert.equal(f.state().installedHash, hash(readFileSync(f.path)))
  assert.equal(f.state().notifiedAt, 0)
  assert.equal(f.state().checkedAt, 1000)
  assert.equal(existsSync(join(f.home, '.claude')), false)
  const net = requests(() => { throw Error('must not check immediately after install') }), notices = []
  await maybeCheckUpdates(f.env, f.cli, { ...net, home: f.home, now: 1001, notify: text => notices.push(text) })
  assert.equal(net.calls.length, 0); assert.equal(notices.length, 0)
})

test('legacy installations get a cached daily notice without being overwritten', async t => {
  const f = fixture(t); f.writeSkill(old)
  const notices = [], net = requests(async () => new Response(latest)), now = Date.now()
  const run = time => maybeCheckUpdates(f.env, f.cli, { ...net, home: f.home, now: time, notify: text => notices.push(text) })
  await run(now)
  assert.equal(notices.length, 1)
  assert.match(notices[0], /skill, then re-read/)
  assert.match(notices[0], /WEENY_API=http:\/\/127.0.0.1:3123/)
  assert.doesNotMatch(notices[0], /npx weeny-cloud/)
  await run(now + 200)
  assert.equal(notices.length, 1); assert.equal(net.calls.length, 1)
  assert.equal(readFileSync(f.path, 'utf8'), renderSkill(old, f.env, f.cli))
  await run(now + DAY + 200)
  assert.equal(net.calls.length, 2); assert.equal(notices.length, 2)
})

test('missing skills do no work; corrupt caches recover and offline attempts back off daily', async t => {
  const f = fixture(t), net = requests(async () => { throw Error('offline') }), now = Date.now()
  await maybeCheckUpdates(f.env, f.cli, { ...net, home: f.home })
  assert.equal(net.calls.length, 0); assert.equal(existsSync(f.cache), false)
  f.writeSkill(old); writeFileSync(f.cache, '{broken')
  await maybeCheckUpdates(f.env, f.cli, { ...net, home: f.home, now })
  await maybeCheckUpdates(f.env, f.cli, { ...net, home: f.home, now: now + 100 })
  assert.equal(net.calls.length, 1)
  assert.equal(readFileSync(f.path, 'utf8'), renderSkill(old, f.env, f.cli))
})

test('a cache from another origin cannot produce an update notice', async t => {
  const f = fixture(t); f.writeSkill(old)
  writeFileSync(f.cache, JSON.stringify({ api: 'https://weeny.cloud', renderer: f.cli, latestHash: 'different', checkedAt: Date.now() }))
  const net = requests(async () => new Response(old)), notices = []
  await maybeCheckUpdates(f.env, f.cli, { ...net, home: f.home, notify: text => notices.push(text) })
  assert.equal(notices.length, 0)
  assert.equal(net.calls.length, 1); assert.equal(f.state().api, f.env.api)
})

test('local customizations alone do not trigger a notice or get overwritten', async t => {
  const f = fixture(t), now = Date.now()
  await installSkill(f.env, f.cli, { home: f.home, now, fetchImpl: async () => new Response(latest) })
  writeFileSync(f.path, readFileSync(f.path, 'utf8') + 'My local notes\n')
  const net = requests(async () => new Response(latest)), notices = []
  const opts = { ...net, home: f.home, notify: text => notices.push(text) }
  await maybeCheckUpdates(f.env, f.cli, { ...opts, now: now + DAY })
  await maybeCheckUpdates(f.env, f.cli, { ...opts, now: now + DAY + 1 })
  assert.equal(notices.length, 0)
  assert.match(readFileSync(f.path, 'utf8'), /My local notes/)
})

test('a refresh serializes its guide and cache commit after an in-flight check', async t => {
  const f = fixture(t); f.writeSkill(old)
  let respond
  const notices = []
  const checking = maybeCheckUpdates(f.env, f.cli, { home: f.home,
    fetchImpl: () => new Promise(resolve => { respond = resolve }), notify: text => notices.push(text) })
  let refreshed = false
  const refreshing = installSkill(f.env, f.cli, { home: f.home, fetchImpl: async () => new Response(latest) })
    .then(() => { refreshed = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(refreshed, false, 'refresh must wait for the check lock')
  assert.equal(readFileSync(f.path, 'utf8'), renderSkill(old, f.env, f.cli))
  respond(new Response(old)); await checking; await refreshing
  assert.equal(f.state().latestSourceHash, hash(latest))
  assert.equal(f.state().installedHash, hash(readFileSync(f.path)))
  assert.equal(notices.length, 0)
})

test('bad HTTP, HTML and oversized responses cannot replace an installed guide', async t => {
  const f = fixture(t); f.writeSkill(old)
  for (const response of [new Response('unavailable', { status: 503 }), new Response('<html>Login</html>'), new Response(latest + 'x'.repeat(256 * 1024))]) {
    await assert.rejects(installSkill(f.env, f.cli, { home: f.home, fetchImpl: async () => response }))
    assert.equal(readFileSync(f.path, 'utf8'), renderSkill(old, f.env, f.cli))
  }
})

test('production refresh uses its existing Claude path and latest npm command in notices', async t => {
  const f = fixture(t), env = { ...f.env, production: true, api: 'https://weeny.cloud' }, now = Date.now()
  const path = await installSkill(env, f.cli, { home: f.home, now, fetchImpl: async () => new Response(old) })
  assert.equal(path, join(f.home, '.claude', 'skills', 'weeny', 'SKILL.md'))
  assert.equal(readFileSync(path, 'utf8'), old)
  const net = requests(async () => new Response(latest)), notices = []
  const run = time => maybeCheckUpdates(env, f.cli, { ...net, home: f.home, now: time, notify: text => notices.push(text) })
  await run(now + DAY); await run(now + DAY + 1)
  assert.equal(notices.length, 1)
  assert.match(notices[0], /npx weeny-cloud@latest skill/)
  assert.equal(readFileSync(path, 'utf8'), old)
})

test('concurrent commands share a single in-flight check and notice', async t => {
  const f = fixture(t); f.writeSkill(old)
  let respond
  const net = requests(() => new Promise(resolve => { respond = resolve })), notices = []
  const opts = { ...net, home: f.home, notify: text => notices.push(text) }
  const checking = maybeCheckUpdates(f.env, f.cli, opts)
  await maybeCheckUpdates(f.env, f.cli, opts)
  assert.equal(net.calls.length, 1)
  respond(new Response(latest)); await checking
  await maybeCheckUpdates(f.env, f.cli, opts)
  assert.equal(net.calls.length, 1); assert.equal(notices.length, 1)
})
