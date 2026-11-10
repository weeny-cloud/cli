import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readdirSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { maybeShowResourceNotices, resourceNoticesAllowed } from './resource-notices.mjs'
test('optional notices are scoped, cached, deduplicated, silent offline, and never redirect tokens', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'weeny-resource-'))
  const env = { api: 'https://staging.weeny.cloud', dir }, messages = [], calls = []
  let now = Date.now()
  const alert = { id: 'm:memory:1', machineName: 'mine', severity: 'warning', summary: 'Memory pressure', advice: 'Preview weeny', alternative: 'Build locally', recommendation: { tier: 'weeny' } }
  const fetchImpl = async (url, options) => {
    calls.push({ url, options }); return { ok: true, json: async () => ({ alerts: [alert] }) }
  }
  try {
    const opts = () => ({ now, fetchImpl, notify: x => messages.push(x) })
    await Promise.all([maybeShowResourceNotices(env, { token: 'a' }, opts()), maybeShowResourceNotices(env, { token: 'a' }, opts())])
    assert.equal(calls.length, 1); assert.equal(messages.length, 1)
    assert.equal(calls[0].options.redirect, 'error'); assert.equal(calls[0].options.headers.Authorization, 'Bearer a')
    await maybeShowResourceNotices(env, { token: 'a' }, opts()); assert.equal(calls.length, 1)
    now += 61_000
    await maybeShowResourceNotices(env, { token: 'a' }, opts()); assert.equal(messages.length, 1)
    alert.severity = 'critical'; now += 61_000
    await maybeShowResourceNotices(env, { token: 'a' }, opts()); assert.equal(messages.length, 2)
    await maybeShowResourceNotices(env, { token: 'other' }, opts()); assert.equal(messages.length, 3)
    now += 61_000
    await maybeShowResourceNotices(env, { token: 'a' }, { now, fetchImpl: async () => { throw Error('offline') }, notify: () => assert.fail() })
    await maybeShowResourceNotices(env, { token: 'a' }, opts()); assert.equal(calls.length, 4)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
test('JSON, CI, SSH, token output and internal protocols never receive optional notices', () => {
  for (const argv of [['server', '--json'], ['_relay'], ['ssh'], ['exec'], ['token'], ['login'], ['help'], ['skill']]) assert.equal(resourceNoticesAllowed(argv, {}), false)
  assert.equal(resourceNoticesAllowed(['push'], { CI: '1' }), false)
  assert.equal(resourceNoticesAllowed(['push'], { WEENY_TOKEN: 'x' }), false)
  assert.equal(resourceNoticesAllowed(['push'], {}), true)
  assert.equal(resourceNoticesAllowed(['server'], {}), true)
})
test('old APIs and missing credentials cannot block ordinary commands', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'weeny-resource-old-')), env = { api: 'https://staging.weeny.cloud', dir }
  try {
    await maybeShowResourceNotices(env, null, { fetchImpl: () => assert.fail() })
    await maybeShowResourceNotices(env, { token: 'x' }, { fetchImpl: async () => ({ ok: false }), notify: () => assert.fail() })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a slow notice fetch keeps its live lock even after the old stale-lock timeout', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'weeny-resource-lock-')), env = { api: 'https://staging.weeny.cloud', dir }
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  let finish, calls = 0
  const pending = new Promise(resolve => { finish = resolve }), now = Date.now()
  const first = maybeShowResourceNotices(env, { token: 'x' }, { now, fetchImpl: async () => {
    calls++; await pending; return { ok: true, json: async () => ({ alerts: [] }) }
  } })
  try {
    const lock = join(dir, readdirSync(dir).find(name => name.endsWith('.lock')))
    for (const owner of readdirSync(lock)) utimesSync(join(lock, owner), new Date(0), new Date(0))
    utimesSync(lock, new Date(0), new Date(0))
    await maybeShowResourceNotices(env, { token: 'x' }, { now: now + 61_000, fetchImpl: async () => {
      calls++; return { ok: true, json: async () => ({ alerts: [] }) }
    } })
    assert.equal(calls, 1)
    assert.equal(readdirSync(lock).length, 1)
  } finally { finish(); await first }
  assert.equal(readdirSync(dir).some(name => name.endsWith('.lock') || name.endsWith('.tmp')), false)
})
