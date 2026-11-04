import { test } from 'node:test'
import assert from 'node:assert/strict'
import { accountCommands } from './account-commands.mjs'

function fixture() {
  const calls = [], lines = []
  const machine = { id: 'mine', name: 'server', status: 'suspended', tier: 'weeny', tunnelSecret: 'never-print', apps: [{ id: 'a', name: 'app' }] }
  let policy = { free: false, enabled: true, settings: { position: 'left', branding: true } }, cleared = false
  const call = async (path, request = {}) => {
    calls.push({ path, ...request })
    if (path === '/api/machines') return { machines: [machine] }
    if (path.endsWith('/resume')) return { id: 'mine', status: 'resuming' }
    if (path === '/api/apps/a/widget') {
      if (request.method === 'PUT') policy = { ...policy, settings: request.body }
      return policy
    }
    if (path === '/api/billing/status') return { tier: 'weeny', founding: true, tiers: [{ name: 'teeny', memGb: 1, vcpu: 1, foundingUsd: 3, listUsd: 5 }] }
    if (path === '/api/billing/tier') return request.body.preview ? { preview: true, warning: 'memory warning' } : { tier: 'teeny', resizing: true }
    if (path === '/api/billing/portal') return { url: 'https://billing.example.test' }
    if (path === '/api/billing/checkout') return { url: 'https://checkout.example.test' }
    if (path === '/api/auth/logout') return { ok: true }
    throw new Error(`Unexpected request ${path}`)
  }
  return { calls, lines, machine, get cleared() { return cleared }, commands: accountCommands({ call,
    loadCreds: () => ({ token: 'fixture' }), clearCredentials: () => { cleared = true }, interactive: false,
    output: line => lines.push(line) }) }
}
test('server status is structured and omits credentials; disruptive actions require explicit approval', async () => {
  const f = fixture()
  await f.commands.server(['status', '--json'])
  const output = f.lines.pop()
  assert.equal(JSON.parse(output).machines[0].status, 'suspended')
  assert.ok(!output.includes('never-print'))
  for (const action of ['suspend','rebuild','delete']) await assert.rejects(f.commands.server([action]), /approval/)
  await assert.rejects(f.commands.server(['delete','--confirm','--preview']), /Unknown option --preview/)
  assert.equal(f.calls.filter(c => c.method).length, 0)
  await f.commands.server(['resume','--json'])
  assert.deepEqual(JSON.parse(f.lines.pop()), { id: 'mine', status: 'resuming' })
})
test('widget changes preserve unspecified appearance and use owner APIs without SSH', async () => {
  const f = fixture()
  await f.commands.widget(['--json','app','--branding','off'])
  assert.deepEqual(JSON.parse(f.lines.pop()).settings, { branding: false, position: 'left' })
  assert.deepEqual(f.calls.find(c => c.method === 'PUT').body, { branding: false, position: 'left' })
  await assert.rejects(f.commands.widget(['app','--branding','maybe']), /on or off/)
})
test('tier previews never mutate and confirmed changes pass the explicit memory override', async () => {
  const f = fixture()
  await f.commands.tier(['teeny','--preview','--json'])
  assert.equal(JSON.parse(f.lines.pop()).monthlyUsd, 3)
  assert.deepEqual(f.calls.at(-1).body, { tier: 'teeny', preview: true })
  await assert.rejects(f.commands.tier(['teeny','--force']), /human pays/)
  await f.commands.tier(['teeny','--confirm','--force','--json'])
  assert.deepEqual(f.calls.at(-1).body, { tier: 'teeny', force: true })
})
test('billing links require a chosen tier for checkout and never submit payment', async () => {
  const f = fixture()
  await f.commands.billing(['portal','--json'])
  assert.equal(JSON.parse(f.lines.pop()).url, 'https://billing.example.test')
  await assert.rejects(f.commands.billing(['checkout','teeny']), /human must choose/)
  await f.commands.billing(['checkout','teeny','--direct-paid','--confirm'])
  assert.deepEqual(f.calls.at(-1).body, { tier: 'teeny', purpose: 'direct_paid' })
})
test('logout revokes before clearing; offline logout explicitly preserves the remote token', async () => {
  const f = fixture()
  await f.commands.logout(['--json'])
  assert.equal(f.calls[0].path, '/api/auth/logout'); assert.equal(f.cleared, true)
  const offline = fixture()
  await offline.commands.logout(['--local','--json'])
  assert.equal(offline.calls.length, 0); assert.equal(JSON.parse(offline.lines[0]).revoked, false)
  let cleared = false
  const failed = accountCommands({ call: async () => { throw new Error('offline') }, loadCreds: () => ({ token: 'fixture' }), clearCredentials: () => { cleared = true } })
  await assert.rejects(failed.logout([]), /offline/); assert.equal(cleared, false)
})

test('JSON tier changes never prompt, even in a terminal; env-only offline logout cannot claim success', async () => {
  const commands = accountCommands({ call: async () => ({ tier: 'weeny', tiers: [{ name: 'teeny' }] }),
    interactive: true, ask: () => assert.fail('JSON mode must not prompt'), fromEnv: true })
  await assert.rejects(commands.tier(['teeny','--json']), /human pays/)
  await assert.rejects(commands.logout(['--local','--json']), /Unset WEENY_TOKEN/)
})
