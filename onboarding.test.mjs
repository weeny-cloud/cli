import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { runOnboarding, onboardingNotice, onboardingHelp } from './onboarding.mjs'

function fixture(profile = {}) {
  const calls = [], lines = []
  return { calls, lines, run: args => runOnboarding(args, { call: async (path, request) => {
    calls.push({ path, ...request })
    return { project: request?.body?.project ?? '', complete: request?.body?.complete ?? false, discovery: 'unknown', ...profile }
  }, output: line => lines.push(line) }) }
}
test('an agent submits known project context without asking, reading a server or inventing discovery', async () => {
  const f = fixture()
  await f.run(['--project', 'Booking app with a Node API and SQLite', '--json'])
  assert.deepEqual(f.calls, [{ path: '/api/builder-profile', method: 'PUT', body: { project: 'Booking app with a Node API and SQLite', complete: true } }])
  assert.equal(JSON.parse(f.lines[0]).complete, true)
  assert.equal(JSON.parse(f.lines[0]).discovery, 'unknown')
})
test('no answers reads; drafts and known discovery are explicit and omitted fields are preserved', async () => {
  const f = fixture()
  await f.run(['--json'])
  assert.deepEqual(f.calls.pop(), { path: '/api/builder-profile' })
  await f.run(['--discovery', 'social', '--discovery-detail', 'Reddit', '--draft'])
  assert.deepEqual(f.calls.pop().body, { discovery: 'social', discoveryDetail: 'Reddit', complete: false })
  assert.match(f.lines.at(-2) || f.lines.at(-1), /draft|Discovery/)
})
test('validates unknown/missing/repeated options before sending any API request', async () => {
  const f = fixture()
  for (const args of [['--project'], ['--project', '--json'], ['--unknown'], ['--discovery', 'made_up'], ['--json', '--json'], ['--project', 'x'.repeat(601)], ['--project', ' ']])
    await assert.rejects(f.run(args))
  assert.equal(f.calls.length, 0)
})
test('only incomplete required profiles produce a signup prompt and human fallback', () => {
  const lines = [], output = line => lines.push(line)
  onboardingNotice(undefined, output)
  onboardingNotice({ required: false }, output)
  onboardingNotice({ required: true, complete: true }, output)
  assert.equal(lines.length, 0)
  onboardingNotice({ required: true, complete: false, agentInstructions: 'Use known context; unknown discovery is fine.', completionUrl: 'https://staging.weeny.cloud/onboarding' }, output)
  assert.match(lines.join('\n'), /onboarding --project/)
  assert.match(lines.join('\n'), /known context/)
  assert.match(lines.join('\n'), /staging.weeny.cloud\/onboarding/)
})

test('CLI command sends an origin-bound authenticated profile request and prints clean JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'weeny-cli-onboarding-'))
  try {
    const profile = join(dir, 'profile'), preload = join(dir, 'fixture.mjs')
    mkdirSync(profile)
    writeFileSync(join(profile, 'credentials.json'), JSON.stringify({ token: 'test-profile-token', apiBase: 'http://127.0.0.1:3123' }))
    writeFileSync(preload, `import assert from 'node:assert/strict';
globalThis.fetch=async(url,opts)=>{
assert.equal(url,'http://127.0.0.1:3123/api/builder-profile');
assert.equal(opts.headers.Authorization,'Bearer test-profile-token');
assert.equal(opts.method,'PUT');assert.deepEqual(JSON.parse(opts.body),{project:'Booking app with SQLite',complete:true});
return Response.json({project:'Booking app with SQLite',complete:true,discovery:'unknown'});
};`)
    const env = { ...process.env, WEENY_ENV: 'staging', WEENY_API: 'http://127.0.0.1:3123', WEENY_CONFIG_DIR: profile }
    delete env.WEENY_TOKEN
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, fileURLToPath(new URL('./cli.mjs', import.meta.url)), 'onboarding', '--project', 'Booking app with SQLite', '--json'], { env, encoding: 'utf8', timeout: 10000 })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stderr, '')
    assert.deepEqual(JSON.parse(result.stdout), { project: 'Booking app with SQLite', complete: true, discovery: 'unknown' })
    assert.ok(!result.stdout.includes('test-profile-token'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a completed profile points to server selection as the next step', async () => {
  const f = fixture({ complete: true, nextStep: 'Check current server options next.' })
  await f.run(['--project', 'A booking app'])
  assert.ok(f.lines.includes('Check current server options next.'))
  assert.ok(!f.lines.some(line => /Human fallback/.test(line)))
})

test('plain onboarding retains the edit URL for a completed profile without repeating signup instructions', async () => {
  const f = fixture({ complete: true, project: 'A booking app', completionUrl: 'https://staging.weeny.cloud/onboarding', agentInstructions: 'Do not repeat this' })
  await f.run([])
  assert.ok(f.lines.includes('Edit profile: https://staging.weeny.cloud/onboarding'))
  assert.ok(!f.lines.some(line => line.includes('Do not repeat this') || line.includes('Human fallback')))
})


test('onboarding --help and -h work offline without credentials, profile writes or optional network work', () => {
  const dir = mkdtempSync(join(tmpdir(), 'weeny-cli-onboarding-help-'))
  try {
    const preload = join(dir, 'offline.mjs'), attempts = join(dir, 'requests')
    writeFileSync(preload, `import { writeFileSync } from 'node:fs';
globalThis.fetch = async () => { writeFileSync(${JSON.stringify(attempts)}, 'unexpected request'); throw new Error('offline'); };`)
    for (const signedIn of [false, true]) {
      const profile = join(dir, signedIn ? 'signed-in' : 'signed-out')
      const credentials = join(profile, 'credentials.json')
      const saved = JSON.stringify({ token: 'fixture-help-token', apiBase: 'https://weeny.cloud' })
      if (signedIn) { mkdirSync(profile); writeFileSync(credentials, saved) }
      const env = { ...process.env, WEENY_ENV: 'production', WEENY_API: 'https://weeny.cloud', WEENY_CONFIG_DIR: profile }
      for (const name of ['CI', 'WEENY_TOKEN', 'WEENY_SSH_KEY_FILE', 'WEENY_KNOWN_HOSTS_FILE']) delete env[name]
      for (const args of [['--help'], ['-h'], ['--project', 'Do not save this', '--help']]) {
        const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, fileURLToPath(new URL('./cli.mjs', import.meta.url)), 'onboarding', ...args], { env, encoding: 'utf8', timeout: 10000 })
        assert.equal(result.status, 0, result.stderr)
        assert.equal(result.stdout, onboardingHelp + '\n')
        assert.equal(result.stderr, '')
        assert.equal(existsSync(attempts), false, 'Help must not make even optional network requests')
        if (signedIn) assert.equal(readFileSync(credentials, 'utf8'), saved)
        else assert.equal(existsSync(profile), false, 'Help must not create a profile')
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
