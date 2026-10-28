import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url))
const unsafe = 'Host *\n  StrictHostKeyChecking no\n  UserKnownHostsFile /dev/null\n  GlobalKnownHostsFile /tmp/untrusted\n'

function fixture({ production = false, tunnel = false, ci = true, keyName = 'key with "quotes" and \\backslash' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'weeny-cli-ssh-'))
  const profile = join(dir, 'profile with spaces'), sshDir = join(profile, 'ssh')
  mkdirSync(sshDir, { recursive: true })
  const key = join(sshDir, keyName), hosts = ci ? join(dir, 'pins with "quotes" and \\backslash') : join(profile, 'known_hosts')
  writeFileSync(key, 'fixture-private-key'); writeFileSync(hosts, 'fixture-host-pin')
  const api = production ? 'https://weeny.cloud' : 'http://127.0.0.1:3123'
  const preload = join(dir, 'fixture.mjs')
  // The CLI selects its real transport arguments. Only add -G to its actual ssh
  // invocation: OpenSSH parses the generated config, without making a connection.
  writeFileSync(preload, `import assert from 'node:assert/strict';
import child from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module';
const exec = child.execFileSync;
child.execFileSync = (command,args,options) => { assert.equal(command,'ssh'); return exec(command,['-G',...args],options); };
syncBuiltinESMExports();
globalThis.fetch = async url => { assert.equal(url,${JSON.stringify(api + '/api/machines')});
 return Response.json({machines:[{id:'fixture',name:'fixture',status:'running',ip:'192.0.2.1',reachable:${JSON.stringify(tunnel ? 'tunnel' : 'direct')}}]}); };
`)
  const env = { ...process.env, WEENY_ENV: production ? 'production' : 'staging', WEENY_API: api, WEENY_CONFIG_DIR: profile }
  delete env.WEENY_TOKEN; delete env.WEENY_SSH_KEY_FILE; delete env.WEENY_KNOWN_HOSTS_FILE
  if (ci) {
    Object.assign(env, { WEENY_TOKEN: 'weeny_' + 'a'.repeat(40), WEENY_SSH_KEY_FILE: key, WEENY_KNOWN_HOSTS_FILE: hosts })
    writeFileSync(join(sshDir, 'config'), unsafe)
    writeFileSync(join(sshDir, 'ci-config'), unsafe)
  } else writeFileSync(join(profile, 'credentials.json'), JSON.stringify({ token: 'fixture-token', apiBase: api, keyPath: key }))
  return { dir, profile, sshDir, key, hosts, run: () => spawnSync(process.execPath, ['--import', preload, cli, 'ssh', 'true'], { env, encoding: 'utf8', timeout: 10000 }) }
}

for (const [name, options] of Object.entries({ 'staging direct': {}, 'production direct': { production: true }, 'production tunnel': { production: true, tunnel: true } })) {
  test(`CI ${name} ignores unsafe earlier rules and preserves quoted credential paths`, () => {
    const f = fixture(options)
    try {
      const r = f.run()
      assert.equal(r.status, 0, r.stderr)
      const lines = r.stdout.split('\n')
      assert.ok(lines.includes('stricthostkeychecking true'), r.stdout)
      assert.ok(lines.includes('batchmode yes'))
      assert.ok(lines.includes('globalknownhostsfile /dev/null'))
      assert.ok(lines.includes('userknownhostsfile ' + f.hosts), r.stdout)
      assert.ok(lines.includes('identityfile ' + f.key), r.stdout)
      assert.equal(readFileSync(join(f.sshDir, 'config'), 'utf8'), unsafe, 'normal profile is untouched')
      assert.equal(existsSync(join(f.profile, 'credentials.json')), false, 'CI does not persist its token')
    } finally { rmSync(f.dir, { recursive: true, force: true }) }
  })
}

test('interactive profiles also support credential paths with spaces, quotes and backslashes', () => {
  const f = fixture({ ci: false })
  try {
    const r = f.run()
    assert.equal(r.status, 0, r.stderr)
    const lines = r.stdout.split('\n')
    assert.ok(lines.includes('identityfile ' + f.key), r.stdout)
    assert.ok(lines.includes('userknownhostsfile ' + f.hosts), r.stdout)
  } finally { rmSync(f.dir, { recursive: true, force: true }) }
})

test('credential path line breaks cannot inject SSH directives', () => {
  const f = fixture({ keyName: 'key\nStrictHostKeyChecking no' })
  try {
    const r = f.run()
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /SSH credential paths cannot contain line breaks/)
  } finally { rmSync(f.dir, { recursive: true, force: true }) }
})
