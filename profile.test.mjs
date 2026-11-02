import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { checkProfileWritable, writeProfile } from './profile.mjs'

test('a fresh profile with spaces is writable and leaves no write probe behind', () => {
  const dir = mkdtempSync(join(tmpdir(), 'weeny profile '))
  try {
    const profile = join(dir, 'account')
    checkProfileWritable(profile)
    assert.deepEqual(readdirSync(profile), [])
    writeProfile(join(profile, 'credentials.json'), '{"token":"test-only"}')
    checkProfileWritable(profile)
    assert.equal(readFileSync(join(profile, 'credentials.json'), 'utf8'), '{"token":"test-only"}')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('EPERM during profile creation and EACCES in an existing profile do not consume login codes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'weeny-permissions-'))
  try {
    const profile = join(dir, 'profile')
    mkdirSync(profile)
    for (const [operation, code] of [['mkdirSync', 'EPERM'], ['openSync', 'EACCES']]) {
      const preload = join(dir, 'denied.mjs')
      writeFileSync(preload, `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
const original=fs.${operation};
fs.${operation}=(path,...args)=>{if(String(path).startsWith(${JSON.stringify(profile)}))throw Object.assign(new Error('denied'),{code:${JSON.stringify(code)}});return original(path,...args)};
syncBuiltinESMExports();globalThis.fetch=async()=>{process.stderr.write('LOGIN_CODE_CONSUMED');throw Error('unexpected API call')};`)
      const env = { ...process.env, CI: 'true', WEENY_ENV: 'staging', WEENY_API: 'http://127.0.0.1:3123', WEENY_CONFIG_DIR: profile }
      delete env.WEENY_TOKEN
      const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, fileURLToPath(new URL('./cli.mjs', import.meta.url)),
        'login', '--email', 'windows-test@example.test', '--code', '123456'], { env, encoding: 'utf8', timeout: 20000 })
      assert.equal(result.status, 1, result.stderr)
      assert.match(result.stderr, /Cannot access Weeny configuration/)
      assert.ok(result.stderr.includes(profile) && result.stderr.includes(code))
      assert.match(result.stderr, /WEENY_CONFIG_DIR/)
      assert.doesNotMatch(result.stderr, /LOGIN_CODE_CONSUMED|at file:/)
      assert.deepEqual(readdirSync(profile), [])
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
