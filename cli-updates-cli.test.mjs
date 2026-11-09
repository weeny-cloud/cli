import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url))
function fixture(t, timeout = false) {
  const dir = mkdtempSync(join(tmpdir(), 'weeny-version-cli-')), profile = join(dir, 'profile')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const preload = join(dir, 'fetch.mjs'), requests = join(dir, 'requests.jsonl')
  writeFileSync(preload, `import assert from 'node:assert/strict';
import os from 'node:os';import {syncBuiltinESMExports} from 'node:module';
import {appendFileSync} from 'node:fs';
os.homedir=()=>${JSON.stringify(dir)};syncBuiltinESMExports();
globalThis.fetch=async(url,opts)=>{
 assert.equal(url,'https://registry.npmjs.org/weeny-cloud/latest');
 assert.equal(opts.redirect,'error');assert.equal(opts.headers,undefined);
 appendFileSync(${JSON.stringify(requests)},JSON.stringify({url})+'\\n');
 ${timeout ? `return new Promise((resolve,reject)=>{const keepAlive=setInterval(()=>{},100);opts.signal.addEventListener('abort',()=>{clearInterval(keepAlive);reject(opts.signal.reason)},{once:true})});` : `return Response.json({name:'weeny-cloud',version:'9999.0.0'});`}
};`)
  const env = { ...process.env, WEENY_ENV: 'production', WEENY_API: 'https://weeny.cloud', WEENY_CONFIG_DIR: profile }
  for (const key of ['CI','WEENY_TOKEN','WEENY_SSH_KEY_FILE','WEENY_KNOWN_HOSTS_FILE']) delete env[key]
  const run = (args, overrides = {}) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, cli, ...args], {
      env: { ...env, ...overrides }, stdio: ['ignore','pipe','pipe'], timeout: 10000,
    })
    let stdout = '', stderr = ''
    child.stdout.on('data', value => { stdout += value }); child.stderr.on('data', value => { stderr += value })
    child.on('error', reject); child.on('close', status => resolve({ status, stdout, stderr }))
  })
  return { dir, profile, requests, run }
}

test('a non-TTY agent gets the CLI notice on stderr once, without installing a guide', async t => {
  const f = fixture(t)
  const first = await f.run(['help', 'create'])
  assert.equal(first.status, 0, first.stderr)
  assert.match(first.stderr, /Weeny CLI update available: \d+\.\d+\.\d+ → 9999\.0\.0/)
  assert.match(first.stderr, /npx weeny-cloud@latest <command> for subsequent commands/)
  assert.doesNotMatch(first.stdout, /update available/)
  assert.match(first.stdout, /npx weeny-cloud create/)
  const second = await f.run(['help', 'create'])
  assert.equal(second.status, 0, second.stderr)
  assert.equal(second.stdout, first.stdout)
  assert.doesNotMatch(second.stderr, /update available/)
  assert.equal(readFileSync(f.requests, 'utf8').trim().split('\n').length, 1)
  assert.equal(existsSync(join(f.dir, '.claude')), false)
})

test('CI and JSON output skip version requests and notices entirely', async t => {
  for (const kind of ['ci', 'json']) {
    const f = fixture(t)
    const result = await f.run(['help', 'create', ...(kind === 'json' ? ['--json'] : [])], kind === 'ci' ? { CI: 'true' } : {})
    assert.equal(result.status, 0, result.stderr)
    assert.doesNotMatch(result.stderr, /update available/)
    assert.equal(existsSync(f.requests), false)
    assert.equal(existsSync(join(f.profile, 'skill-update.json')), false)
  }
})

test('a stalled version check times out and lets the command finish, with daily backoff', { timeout: 12000 }, async t => {
  const f = fixture(t, true), began = Date.now()
  const result = await f.run(['help', 'create'])
  const elapsed = Date.now() - began
  assert.equal(result.status, 0, result.stderr)
  assert.ok(elapsed >= 2500 && elapsed < 6000, `three-second check took ${elapsed}ms`)
  assert.match(result.stdout, /npx weeny-cloud create/)
  assert.doesNotMatch(result.stderr, /update available|TimeoutError|AbortError/)
  const retry = await f.run(['help', 'create'])
  assert.equal(retry.status, 0, retry.stderr)
  assert.equal(readFileSync(f.requests, 'utf8').trim().split('\n').length, 1)
})
