import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { installSkill, maybeCheckSkillUpdate, checkSkillUpdate, renderSkill, skillPath } from './skill-updates.mjs'

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

function background(fetchImpl) {
  const jobs = [], launches = []
  return { jobs, launches, spawnImpl(_node, argv, opts) {
    assert.equal(opts.detached, true); assert.equal(opts.stdio, 'ignore')
    const args = JSON.parse(argv[2]); launches.push(args)
    jobs.push(checkSkillUpdate(args, { fetchImpl }))
    return { on() {}, unref() {} }
  } }
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
  const bg = background(() => { throw Error('must not check immediately after install') })
  maybeCheckSkillUpdate(f.env, f.cli, { ...bg, home: f.home, now: 1001, notify() { assert.fail('current guide must be quiet') } })
  assert.equal(bg.launches.length, 0)
})

test('legacy installations get a cached daily notice without being overwritten', async t => {
  const f = fixture(t); f.writeSkill(old)
  const notices = [], bg = background(async () => new Response(latest)), now = Date.now()
  const run = time => maybeCheckSkillUpdate(f.env, f.cli, { ...bg, home: f.home, now: time, notify: text => notices.push(text) })
  run(now)
  assert.equal(notices.length, 0)
  await Promise.all(bg.jobs)
  run(now + 100)
  assert.equal(notices.length, 1)
  assert.match(notices[0], /skill, then re-read/)
  assert.match(notices[0], /WEENY_API=http:\/\/127.0.0.1:3123/)
  assert.doesNotMatch(notices[0], /npx weeny-cloud/)
  run(now + 200)
  assert.equal(notices.length, 1); assert.equal(bg.launches.length, 1)
  assert.equal(readFileSync(f.path, 'utf8'), renderSkill(old, f.env, f.cli))
  run(now + DAY + 200)
  await Promise.all(bg.jobs)
  assert.equal(bg.launches.length, 2); assert.equal(notices.length, 2)
})

test('missing skills do no work; corrupt caches recover and offline attempts back off daily', async t => {
  const f = fixture(t), bg = background(async () => { throw Error('offline') }), now = Date.now()
  maybeCheckSkillUpdate(f.env, f.cli, { ...bg, home: f.home })
  assert.equal(bg.launches.length, 0); assert.equal(existsSync(f.cache), false)
  f.writeSkill(old); writeFileSync(f.cache, '{broken')
  maybeCheckSkillUpdate(f.env, f.cli, { ...bg, home: f.home, now })
  await Promise.all(bg.jobs)
  maybeCheckSkillUpdate(f.env, f.cli, { ...bg, home: f.home, now: now + 100 })
  assert.equal(bg.launches.length, 1)
  assert.equal(readFileSync(f.path, 'utf8'), renderSkill(old, f.env, f.cli))
})

test('a cache from another origin cannot produce an update notice', async t => {
  const f = fixture(t); f.writeSkill(old)
  writeFileSync(f.cache, JSON.stringify({ api: 'https://weeny.cloud', renderer: f.cli, latestHash: 'different', checkedAt: Date.now() }))
  const bg = background(async () => new Response(old))
  maybeCheckSkillUpdate(f.env, f.cli, { ...bg, home: f.home, notify() { assert.fail('foreign cache') } })
  await Promise.all(bg.jobs)
  assert.equal(bg.launches.length, 1); assert.equal(f.state().api, f.env.api)
})

test('local customizations alone do not trigger a notice or get overwritten', async t => {
  const f = fixture(t), now = Date.now()
  await installSkill(f.env, f.cli, { home: f.home, now, fetchImpl: async () => new Response(latest) })
  writeFileSync(f.path, readFileSync(f.path, 'utf8') + 'My local notes\n')
  const bg = background(async () => new Response(latest))
  maybeCheckSkillUpdate(f.env, f.cli, { ...bg, home: f.home, now: now + DAY, notify() { assert.fail('no upstream update') } })
  await Promise.all(bg.jobs)
  maybeCheckSkillUpdate(f.env, f.cli, { ...bg, home: f.home, now: now + DAY + 1, notify() { assert.fail('no upstream update') } })
  assert.match(readFileSync(f.path, 'utf8'), /My local notes/)
})

test('a refresh wins over an older background request still in flight', async t => {
  const f = fixture(t); f.writeSkill(old)
  let respond
  const bg = background(() => new Promise(resolve => { respond = resolve }))
  maybeCheckSkillUpdate(f.env, f.cli, { ...bg, home: f.home })
  await installSkill(f.env, f.cli, { home: f.home, fetchImpl: async () => new Response(latest) })
  respond(new Response(old)); await Promise.all(bg.jobs)
  assert.equal(f.state().latestSourceHash, hash(latest))
  assert.equal(f.state().installedHash, hash(readFileSync(f.path)))
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
  const bg = background(async () => new Response(latest)), notices = []
  const run = time => maybeCheckSkillUpdate(env, f.cli, { ...bg, home: f.home, now: time, notify: text => notices.push(text) })
  run(now + DAY); await Promise.all(bg.jobs); run(now + DAY + 1)
  assert.equal(notices.length, 1)
  assert.match(notices[0], /npx weeny-cloud@latest skill/)
  assert.equal(readFileSync(path, 'utf8'), old)
})
