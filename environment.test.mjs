import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cliEnvironment, credentialsForOrigin } from './environment.mjs'
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('production keeps its existing paths and legacy credentials', () => {
  const c = cliEnvironment({}, '/test-home')
  assert.equal(c.api, 'https://weeny.cloud')
  assert.equal(c.dir, '/test-home/.weeny')
  assert.equal(c.sshDir, '/test-home/.ssh')
  assert.deepEqual(credentialsForOrigin({ token: 'legacy' }, c), { token: 'legacy' })
})
test('staging isolates account, SSH and skill storage by API origin', () => {
  const a = cliEnvironment({ WEENY_ENV: 'staging', WEENY_API: 'https://staging.weeny.cloud' }, '/test-home')
  const b = cliEnvironment({ WEENY_API: 'https://staging.other.test' }, '/test-home')
  assert.notEqual(a.dir, '/test-home/.weeny')
  assert.notEqual(a.dir, b.dir)
  assert.equal(a.sshDir, a.dir + '/ssh')
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
    { WEENY_API: 'https://staging.weeny.cloud', WEENY_CONFIG_DIR: '/test-home/.weeny' },
  ]) assert.throws(() => cliEnvironment(env, '/test-home'))
  assert.equal(cliEnvironment({ WEENY_API: 'http://127.0.0.1:3123' }, '/test-home').production, false)
})
test('a symlink cannot redirect staging writes into the production profile', () => {
  const home = mkdtempSync(join(tmpdir(), 'weeny-profile-test-'))
  try {
    mkdirSync(join(home, '.weeny'))
    symlinkSync(join(home, '.weeny'), join(home, 'alias'))
    assert.throws(() => cliEnvironment({ WEENY_API: 'https://staging.weeny.cloud', WEENY_CONFIG_DIR: join(home, 'alias') }, home), /own configuration/)
  } finally { rmSync(home, { recursive: true, force: true }) }
})
