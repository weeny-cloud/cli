import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url))
test('actual CLI delivers account warnings only on stderr and keeps JSON fully machine-readable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'weeny-resource-cli-')), profile = join(dir, 'profile'), log = join(dir, 'requests')
  const preload = join(dir, 'fetch.mjs')
  mkdirSync(profile)
  writeFileSync(join(profile, 'credentials.json'), JSON.stringify({ apiBase: 'https://staging.weeny.cloud', token: 'weeny_test' }))
  writeFileSync(preload, `import {appendFileSync} from 'node:fs';
const alert={id:'m:memory:1',machineName:'mine',severity:'warning',summary:'Sustained memory pressure',advice:'Recommended plan: weeny. Preview: tier weeny --preview.',alternative:'Build locally'};
globalThis.fetch=async(url,opts)=>{appendFileSync(${JSON.stringify(log)},url+'\\n');
if(url.endsWith('/api/resource-alerts'))return Response.json({alerts:[alert]});
if(url.endsWith('/api/machines'))return Response.json({machines:[{id:'m',name:'mine',status:'running',tier:'free',alerts:[alert],health:{memUsedMb:960,memTotalMb:1024},tunnelSecret:'never-print'}]});
throw Error('Unexpected '+url)};`)
  const env = { ...process.env, WEENY_ENV: 'staging', WEENY_API: 'https://staging.weeny.cloud', WEENY_CONFIG_DIR: profile }
  for (const key of ['CI','WEENY_TOKEN','WEENY_SSH_KEY_FILE','WEENY_KNOWN_HOSTS_FILE']) delete env[key]
  const run = args => spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, cli, ...args], { env, encoding: 'utf8', timeout: 5000 })
  try {
    const first = run(['server', 'status'])
    assert.equal(first.status, 0, first.stderr)
    assert.match(first.stderr, /Sustained memory pressure/)
    assert.match(first.stderr, /Recommended plan: weeny/)
    assert.doesNotMatch(first.stdout, /resource alert|Recommended plan/)
    const second = run(['server', 'status'])
    assert.equal(second.status, 0, second.stderr)
    assert.doesNotMatch(second.stderr, /resource alert/)
    const structured = run(['server', 'status', '--json'])
    assert.equal(structured.status, 0, structured.stderr)
    assert.equal(structured.stderr, '')
    const machine = JSON.parse(structured.stdout).machines[0]
    assert.equal(machine.alerts[0].severity, 'warning')
    assert.equal(machine.health.memUsedMb, 960)
    assert.equal(machine.tunnelSecret, undefined)
    assert.equal(readFileSync(log, 'utf8').split('\n').filter(x => x.endsWith('/api/resource-alerts')).length, 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

for (const kind of ['origin mismatch', 'unreadable credentials']) test(`optional resource notices preserve whoami help with ${kind}`, t => {
  const dir = mkdtempSync(join(tmpdir(), 'weeny-resource-creds-')), preload = join(dir, 'credentials.mjs')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const credentials = join(dir, 'credentials.json')
  writeFileSync(credentials, JSON.stringify({ apiBase: 'https://staging.other.weeny.cloud', token: 'weeny_test' }))
  writeFileSync(preload, `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
const read=fs.readFileSync;
fs.readFileSync=(path,...args)=>{if(path===${JSON.stringify(credentials)}&&${kind === 'unreadable credentials'})throw Object.assign(Error('denied'),{code:'EACCES'});return read(path,...args)};
syncBuiltinESMExports();
globalThis.fetch=async()=>{throw Error('optional notices must not fetch with unusable credentials')};`)
  const env = { ...process.env, WEENY_ENV: 'staging', WEENY_API: 'https://staging.weeny.cloud', WEENY_CONFIG_DIR: dir }
  for (const key of ['CI','WEENY_TOKEN','WEENY_SSH_KEY_FILE','WEENY_KNOWN_HOSTS_FILE']) delete env[key]
  const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, cli, 'whoami'], { env, encoding: 'utf8', timeout: 5000 })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /npx weeny-cloud login/)
  assert.doesNotMatch(result.stderr, /Saved credentials|Cannot access Weeny|resource alert/)
})
