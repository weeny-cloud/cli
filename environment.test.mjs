import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cliEnvironment, credentialsForOrigin, credentialsFromEnv } from './environment.mjs'
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const home = resolve('/test-home')

test('production keeps its existing paths and legacy credentials', () => {
  const c = cliEnvironment({}, home)
  assert.equal(c.api, 'https://weeny.cloud')
  assert.equal(c.dir, join(home, '.weeny'))
  assert.equal(c.sshDir, join(home, '.ssh'))
  assert.deepEqual(credentialsForOrigin({ token: 'legacy' }, c), { token: 'legacy' })
})
test('staging isolates account, SSH and skill storage by API origin', () => {
  const a = cliEnvironment({ WEENY_ENV: 'staging', WEENY_API: 'https://staging.weeny.cloud' }, home)
  const b = cliEnvironment({ WEENY_API: 'https://staging.other.test' }, home)
  assert.notEqual(a.dir, join(home, '.weeny'))
  assert.notEqual(a.dir, b.dir)
  assert.equal(a.sshDir, join(a.dir, 'ssh'))
  assert.throws(() => credentialsForOrigin({ token: 'prod', apiBase: 'https://weeny.cloud' }, a), /another API/)
  assert.throws(() => credentialsForOrigin({ token: 'legacy' }, a), /another API/)
  assert.equal(credentialsForOrigin({ token: 'stage', apiBase: a.api }, a).token, 'stage')
})
test('refuses contradictory modes, shared production storage and unsafe API origins', () => {
  for (const env of [
    { WEENY_ENV: 'staging' },
    { WEENY_ENV: 'production', WEENY_API: 'https://staging.weeny.cloud' },
    { WEENY_API: 'http://staging.weeny.cloud' },
    { WEENY_API: 'https://weeny.cloud/path' },
    { WEENY_API: 'https://user:pass@staging.weeny.cloud' },
    { WEENY_API: 'https://staging.weeny.cloud', WEENY_CONFIG_DIR: join(home, '.weeny') },
  ]) assert.throws(() => cliEnvironment(env, home))
  assert.equal(cliEnvironment({ WEENY_API: 'http://127.0.0.1:3123' }, home).production, false)
})
test('a symlink cannot redirect staging writes into the production profile', () => {
  const home = mkdtempSync(join(tmpdir(), 'weeny-profile-test-'))
  try {
    mkdirSync(join(home, '.weeny'))
    symlinkSync(join(home, '.weeny'), join(home, 'alias'), process.platform === 'win32' ? 'junction' : 'dir')
    assert.throws(() => cliEnvironment({ WEENY_API: 'https://staging.weeny.cloud', WEENY_CONFIG_DIR: join(home, 'alias') }, home), /own configuration/)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('explicit production profiles isolate SSH configuration for CI setup', () => {
  const e = cliEnvironment({ WEENY_CONFIG_DIR: join(home, 'ci-profile') }, home)
  assert.equal(e.sshDir, join(home, 'ci-profile', 'ssh'))
})
test('CI credentials are explicit, origin-bound and require a pre-enrolled key and pinned hosts', () => {
  const e = cliEnvironment({}, home)
  assert.equal(credentialsFromEnv({}, e), null)
  const env = { WEENY_TOKEN: 'weeny_' + 'a'.repeat(40), WEENY_SSH_KEY_FILE: '/tmp/ci-key', WEENY_KNOWN_HOSTS_FILE: '/tmp/ci-hosts' }
  assert.deepEqual(credentialsFromEnv(env, e), { token: env.WEENY_TOKEN, apiBase: e.api, keyPath: resolve('/tmp/ci-key'), knownHosts: resolve('/tmp/ci-hosts') })
  for (const patch of [{ WEENY_TOKEN: 'bad-token' }, { WEENY_SSH_KEY_FILE: '' }, { WEENY_KNOWN_HOSTS_FILE: '' }])
    assert.throws(() => credentialsFromEnv({ ...env, ...patch }, e))
})
