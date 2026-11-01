import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { renderSkill } from './skill-updates.mjs'

const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url))
const source = '---\nname: weeny\ndescription: Deploy apps\n---\nCurrent guide: npx weeny-cloud push\n'
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(fn) {
  const deadline = Date.now() + 5000
  while (!fn()) { assert.ok(Date.now() < deadline, 'background helper did not finish'); await pause(20) }
}
function run(env, args, extra = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...extra, cli, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', data => { stdout += data }); child.stderr.on('data', data => { stderr += data })
    child.on('error', reject); child.on('close', status => resolve({ status, stdout, stderr }))
  })
}

test('real CLI returns before a stalled update request, notices later, and refreshes explicitly', { timeout: 15000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'weeny-skill-cli-'))
  const server = createServer()
  let firstResponse, requests = 0
  server.on('request', (req, res) => {
    assert.equal(req.url, '/weeny-skill.md'); assert.equal(req.headers.authorization, undefined)
    requests++
    if (requests === 1) firstResponse = res
    else res.end(source)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { firstResponse?.end(source); server.closeAllConnections(); server.close(); rmSync(dir, { recursive: true, force: true }) })
  const api = `http://127.0.0.1:${server.address().port}`, profile = join(dir, 'profile')
  const path = join(profile, 'skills', 'weeny', 'SKILL.md'), cache = join(profile, 'skill-update.json')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, renderSkill(source.replace('Current', 'Older'), { api, dir: profile, production: false }, cli))
  const env = { ...process.env, WEENY_ENV: 'staging', WEENY_API: api, WEENY_CONFIG_DIR: profile }
  for (const key of ['CI', 'WEENY_TOKEN', 'WEENY_SSH_KEY_FILE', 'WEENY_KNOWN_HOSTS_FILE']) delete env[key]
  // The HTTP response remains deliberately blocked until the foreground has exited.
  const first = await run(env, ['help', 'skill'])
  assert.equal(first.status, 0, first.stderr); assert.doesNotMatch(first.stderr, /guide update available/)
  await until(() => firstResponse)
  firstResponse.end(source)
  await until(() => {
    try { return JSON.parse(readFileSync(cache)).latestHash && !existsSync(join(profile, 'skill-update.lock')) } catch { return false }
  })
  const second = await run(env, ['help', 'skill'])
  assert.equal(second.status, 0); assert.equal(second.stdout, first.stdout)
  assert.match(second.stderr, /guide update available/)
  assert.doesNotMatch(second.stdout, /guide update available/)
  const third = await run(env, ['help', 'skill'])
  assert.doesNotMatch(third.stderr, /guide update available/); assert.equal(requests, 1)
  const refresh = await run(env, ['skill'])
  assert.equal(refresh.status, 0, refresh.stderr)
  assert.equal(readFileSync(path, 'utf8'), renderSkill(source, { api, dir: profile, production: false }, cli))
  assert.equal(JSON.parse(readFileSync(cache)).notifiedAt, 0)
  assert.doesNotMatch((await run(env, ['help', 'skill'])).stderr, /guide update available/)

  // Suppression is independent of the cache being fresh or of TTY detection.
  rmSync(cache)
  assert.equal((await run({ ...env, CI: 'true' }, ['help', 'skill'])).status, 0)
  assert.equal(existsSync(cache), false)
  assert.equal((await run({ ...env, WEENY_TOKEN: 'weeny_' + 'a'.repeat(40), WEENY_SSH_KEY_FILE: '/fixture/key', WEENY_KNOWN_HOSTS_FILE: '/fixture/hosts' }, ['help', 'skill'])).status, 0)
  assert.equal(existsSync(cache), false)
  const preload = join(dir, 'relay.mjs')
  writeFileSync(preload, 'globalThis.fetch = async () => Response.json({machines: []})')
  assert.equal((await run(env, ['_relay', 'fixture'], ['--import', preload])).status, 1)
  assert.equal(existsSync(cache), false); assert.equal(requests, 2)
})
