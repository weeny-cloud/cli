import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { maybeCheckUpdates, installSkill, skillPath } from './skill-updates.mjs'

const DAY = 86400000
const registry = 'https://registry.npmjs.org/weeny-cloud/latest'
const source = '---\nname: weeny\ndescription: Deploy apps\n---\nLatest guide\n'
function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'weeny-cli-updates-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const env = { production: true, api: 'https://weeny.cloud', dir: join(home, 'profile') }
  const cache = join(env.dir, 'skill-update.json'), notices = [], calls = []
  const run = (options = {}) => maybeCheckUpdates(env, '/candidate/cli.mjs', {
    home, now: 100000, currentVersion: '0.9.0', notify: value => notices.push(value),
    fetchImpl: async (url, opts) => {
      calls.push(url)
      assert.equal(opts.redirect, 'error')
      assert.equal(opts.headers, undefined)
      return url === registry ? Response.json({ name: 'weeny-cloud', version: '0.10.0' }) : new Response(source)
    }, ...options,
  })
  return { home, env, cache, calls, notices, run,
    state: () => JSON.parse(readFileSync(cache, 'utf8')) }
}

test('a CLI without an installed guide gets a numeric version nudge once per day', async t => {
  const f = fixture(t)
  await f.run()
  assert.deepEqual(f.calls, [registry])
  assert.deepEqual(f.notices, ['Weeny CLI update available: 0.9.0 → 0.10.0. Use npx weeny-cloud@latest <command> for subsequent commands.'])
  assert.equal(existsSync(skillPath(f.env, f.home)), false)
  await f.run({ now: 100001 })
  assert.equal(f.calls.length, 1); assert.equal(f.notices.length, 1)
  await f.run({ now: 100000 + DAY })
  assert.equal(f.calls.length, 2); assert.equal(f.notices.length, 2)
})

test('guide and CLI checks share one in-flight lock and run concurrently', async t => {
  const f = fixture(t), path = skillPath(f.env, f.home)
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, source.replace('Latest', 'Old'))
  const pending = new Map(), fetchImpl = (url, opts) => new Promise(resolve => {
    assert.equal(opts.headers, undefined)
    pending.set(url, resolve)
  })
  const checking = f.run({ fetchImpl })
  assert.equal(pending.size, 2, 'both optional requests must start before either finishes')
  await f.run({ fetchImpl: () => { throw Error('duplicate fetch') } })
  pending.get(registry)(Response.json({ name: 'weeny-cloud', version: '0.10.0' }))
  pending.get(f.env.api + '/weeny-skill.md')(new Response(source))
  await checking
  assert.equal(f.notices.length, 2)
  assert.match(f.notices[0], /guide update available/)
  assert.match(f.notices[1], /CLI update available/)
  assert.equal(existsSync(join(f.env.dir, 'skill-update.lock')), false)
})

test('offline and invalid responses stay quiet and back off for a day', async t => {
  for (const kind of ['offline', 'http', 'html', 'wrong-package', 'invalid', 'oversized']) {
    const f = fixture(t)
    let requests = 0
    const fetchImpl = async () => {
      requests++
      if (kind === 'offline') throw Error('offline')
      if (kind === 'http') return new Response('unavailable', { status: 503 })
      if (kind === 'html') return new Response('<html>Sign in</html>')
      if (kind === 'wrong-package') return Response.json({ name: 'another-package', version: '9.0.0' })
      if (kind === 'oversized') return new Response('x'.repeat(65537))
      return Response.json({ name: 'weeny-cloud', version: '0.10.0; run a command' })
    }
    await f.run({ fetchImpl }); await f.run({ fetchImpl, now: 100001 })
    assert.equal(requests, 1, kind); assert.deepEqual(f.notices, [], kind)
  }
})

test('current, newer, prerelease and malformed versions do not prompt a downgrade or false upgrade', async t => {
  for (const latest of ['0.9.0', '0.8.99', '0.10.0-beta.1', '00.10.0', 'v0.10.0', '0.10', null, 10]) {
    const f = fixture(t)
    await f.run({ fetchImpl: async () => Response.json({ name: 'weeny-cloud', version: latest }) })
    assert.deepEqual(f.notices, [], String(latest))
  }
  const f = fixture(t)
  await f.run()
  f.notices.length = 0
  await f.run({ currentVersion: '0.10.0', now: 100001 })
  assert.deepEqual(f.notices, [], 'upgrading the running CLI clears the cached nudge')
  assert.equal(f.calls.length, 1)
})

test('installing the guide preserves the CLI check and notice backoff', async t => {
  const f = fixture(t)
  await f.run()
  const cli = f.state().cli
  await installSkill(f.env, '/candidate/cli.mjs', { home: f.home, now: 100001, fetchImpl: async () => new Response(source) })
  assert.deepEqual(f.state().cli, cli)
  await f.run({ now: 100002 })
  assert.equal(f.calls.length, 1)
  assert.equal(f.notices.length, 1)
})

test('a CLI check still completes when the installed-guide fetch fails', async t => {
  const f = fixture(t), path = skillPath(f.env, f.home)
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, source)
  await f.run({ fetchImpl: async url => {
    if (url !== registry) throw Error('guide offline')
    return Response.json({ name: 'weeny-cloud', version: '1.0.0' })
  } })
  assert.equal(f.notices.length, 1)
  assert.match(f.notices[0], /CLI update available: 0.9.0 → 1.0.0/)
})

test('staging candidates never query npm or print production update commands', async t => {
  const f = fixture(t), env = { ...f.env, production: false, api: 'http://127.0.0.1:3123' }, notices = []
  const path = skillPath(env, f.home)
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, source.replace('Latest', 'Old'))
  await maybeCheckUpdates(env, '/candidate/cli.mjs', { home: f.home, currentVersion: '0.9.0', notify: value => notices.push(value), fetchImpl: async url => {
    assert.equal(url, env.api + '/weeny-skill.md')
    return new Response(source)
  } })
  assert.equal(notices.length, 1)
  assert.doesNotMatch(notices[0], /npx weeny-cloud@latest|CLI update available/)
  assert.match(notices[0], /WEENY_ENV=staging/)
})
