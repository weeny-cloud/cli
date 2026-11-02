import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { proxyCommand } from './ssh-command.mjs'

test('the real OpenSSH client launches relay arguments literally from a path with spaces', () => {
  const dir = mkdtempSync(join(tmpdir(), 'weeny SSH & spaces '))
  try {
    const probe = join(dir, 'relay probe.mjs')
    writeFileSync(probe, 'process.stderr.write("RELAY_ARGS="+JSON.stringify(process.argv.slice(2))+"\\n")')
    const args = ['machine-id', 'https://staging.example.test', "profile with 'quotes' & spaces", '100%literal', 'back\\slash']
    const result = spawnSync('ssh', ['-F', 'none', '-o', 'BatchMode=yes', '-o',
      `ProxyCommand=${proxyCommand([process.execPath, probe, ...args])}`, 'relay-fixture'], { encoding: 'utf8', timeout: 20000 })
    assert.equal(result.status, 255, result.stderr)
    const output = result.stderr.match(/RELAY_ARGS=(.*)/)?.[1]
    assert.ok(output, result.stderr)
    assert.deepEqual(JSON.parse(output), args)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('relay arguments cannot inject additional SSH config lines', () => {
  for (const argument of ['path\nHost *', 'path\rProxyCommand other', 'nul\0path'])
    assert.throws(() => proxyCommand(['node', argument]), /line breaks or NUL/)
})
