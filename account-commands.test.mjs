import { test } from 'node:test'
import assert from 'node:assert/strict'
import { accountCommands } from './account-commands.mjs'

function fixture() {
  const calls = [], lines = []
  const machine = { id: 'mine', name: 'server', status: 'suspended', tier: 'weeny', diskMb: 30720, tunnelSecret: 'never-print', apps: [{ id: 'a', name: 'app' }] }
  let policy = { free: false, enabled: true, settings: { position: 'left', branding: true } }, cleared = false
  const call = async (path, request = {}) => {
    calls.push({ path, ...request })
    if (path === '/api/machines') return { machines: [machine] }
    if (path.endsWith('/resume')) return { id: 'mine', status: 'resuming' }
    if (path === '/api/apps/a/widget') {
      if (request.method === 'PUT') policy = { ...policy, settings: request.body }
      return policy
    }
    if (path === '/api/billing/status') return { tier: 'weeny', machineDiskGb: 30, founding: true, tiers: [{ name: 'teeny', memGb: 1, diskGb: 10, vcpu: 1, foundingUsd: 3, listUsd: 5 }] }
    if (path === '/api/billing/tier') return request.body.preview ? { preview: true, targetDiskMb: 30720, warning: 'memory warning' } : { tier: 'teeny', resizing: true }
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


test('shows catalogue disk allowances separately from the existing server and retained upgrade size', async()=>{
 const f=fixture()
 await f.commands.server(['status'])
 assert.match(f.lines.at(-1),/30 GiB disk/)
 await f.commands.tier([])
 assert.match(f.lines.at(-1),/your server has 30 GiB disk/)
 assert.match(f.lines.at(-1),/teeny: 1 GB, 1 vCPU, 10 GiB disk/)
 await f.commands.tier(['teeny','--preview'])
 assert.match(f.lines.at(-1),/resulting disk 30 GiB/)
 assert.equal(f.calls.filter(c=>c.path==='/api/billing/tier'&&!c.body.preview).length,0)
})

test('structured server status retains measured health and resource advice without credentials', async () => {
  const f = fixture()
  f.machine.health = { memUsedMb: 960, memTotalMb: 1024 }
  f.machine.alerts = [{ kind: 'memory', recommendation: { tier: 'weeny' } }]
  await f.commands.server(['status', '--json'])
  const output = JSON.parse(f.lines.pop()).machines[0]
  assert.deepEqual(output.health, f.machine.health)
  assert.deepEqual(output.alerts, f.machine.alerts)
  assert.equal(output.tunnelSecret, undefined)
})

function checkoutFixture(purchase, failure) {
  const calls=[], lines=[]
  const commands=accountCommands({output:line=>lines.push(line),call:async(path,request={})=>{
    calls.push({path,...request})
    if (path==='/api/me') return {serverAccess:{purchase}}
    assert.equal(path,'/api/billing/cancel-checkout')
    assert.equal(request.method,'POST')
    if (failure) throw failure
    return {ok:true}
  }})
  return {commands,calls,lines}
}
for (const status of ['held','checkout']) {
  test(`billing cancel-checkout discovers and cancels a ${status} purchase without paid actions`,async()=>{
    const f=checkoutFixture({id:'purchase-one',status})
    await f.commands.billing(['cancel-checkout','--json'])
    assert.deepEqual(f.calls,[{path:'/api/me'},{path:'/api/billing/cancel-checkout',method:'POST',body:{purchaseId:'purchase-one'}}])
    assert.deepEqual(JSON.parse(f.lines[0]),{ok:true,purchaseId:'purchase-one',cancelled:true})
  })
}
test('billing cancel-checkout explains preserved waitlist/server and capacity without promising a server or refund',async()=>{
  const f=checkoutFixture({id:'purchase-one',status:'checkout'})
  await f.commands.billing(['cancel-checkout'])
  assert.match(f.lines[0],/waitlist place and existing server are preserved/)
  assert.match(f.lines[0],/depend on capacity/)
  assert.match(f.lines[0],/npx weeny-cloud create/)
  assert.doesNotMatch(f.lines[0],/refunded|server is ready|no charges/i)
})
for (const status of [undefined,'expired','revoked','refunded']) {
  test(`billing cancel-checkout is a read-only no-op without a pending purchase (${status})`,async()=>{
    const f=checkoutFixture(status?{id:'old',status}:null)
    await f.commands.billing(['cancel-checkout','--json'])
    assert.deepEqual(f.calls,[{path:'/api/me'}])
    assert.deepEqual(JSON.parse(f.lines[0]),{ok:true,cancelled:false})
  })
}
for (const status of ['paid','provisioning','delivered','refunding']) {
  test(`billing cancel-checkout protects a ${status} purchase and leaves subscription cancellation to billing`,async()=>{
    const f=checkoutFixture({id:'purchase-one',status})
    await assert.rejects(f.commands.billing(['cancel-checkout']),/already completed or is being processed.*billing portal/)
    assert.deepEqual(f.calls,[{path:'/api/me'}])
    assert.deepEqual(f.lines,[])
  })
}
test('billing cancel-checkout --id retries that exact purchase without selecting a newer checkout',async()=>{
  const f=checkoutFixture({id:'newer-purchase',status:'checkout'})
  await f.commands.billing(['cancel-checkout','--id','purchase-one','--json'])
  assert.deepEqual(f.calls,[{path:'/api/billing/cancel-checkout',method:'POST',body:{purchaseId:'purchase-one'}}])
  assert.deepEqual(JSON.parse(f.lines[0]),{ok:true,purchaseId:'purchase-one',cancelled:true})
})
for (const message of ['This checkout has completed or changed.','Checkout not found','Could not confirm checkout cancellation.']) {
  test(`billing cancel-checkout preserves server cancellation failures: ${message}`,async()=>{
    const failure=new Error(message), f=checkoutFixture({id:'purchase-one',status:'checkout'},failure)
    await assert.rejects(f.commands.billing(['cancel-checkout','--json']),error=>error===failure)
    assert.deepEqual(f.lines,[])
    assert.equal(f.calls.length,2)
  })
}
test('billing cancel-checkout does not treat missing availability as proof that no checkout exists',async()=>{
  const calls=[],commands=accountCommands({call:async path=>{calls.push(path);return {}},output:()=>assert.fail('No success output')})
  await assert.rejects(commands.billing(['cancel-checkout']),/Checkout status is unavailable/)
  assert.deepEqual(calls,['/api/me'])
})
test('billing cancellation rejects malformed selectors and arguments before making requests',async()=>{
  const f=checkoutFixture(null)
  await assert.rejects(f.commands.billing(['cancel-checkout','--id']),/--id needs a value/)
  await assert.rejects(f.commands.billing(['cancel-checkout','extra']),/Usage:/)
  await assert.rejects(f.commands.billing(['portal','--id','purchase-one']),/only used with billing cancel-checkout/)
  assert.deepEqual(f.calls,[])
})
