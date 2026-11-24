import { test } from 'node:test'
import assert from 'node:assert/strict'
import { accountCommands } from './account-commands.mjs'

function fixture({interactive=false,ask,tierPreview,tierResult,operation}={}) {
  const calls = [], lines = []
  const machine = { id: 'mine', name: 'server', status: 'suspended', tier: 'weeny', diskMb: 30720, tunnelSecret: 'never-print', apps: [{ id: 'a', name: 'app' }] }
  const billing={ tier:'weeny',machineDiskGb:30,founding:true,tiers:[{name:'teeny',memGb:1,diskGb:10,vcpu:1,foundingUsd:3,listUsd:5}] }
  let policy = { free: false, enabled: true, settings: { position: 'left', branding: true } }, cleared = false
  const call = async (path, request = {}) => {
    calls.push({ path, ...request })
    if (path === '/api/machines') return { machines: [machine] }
    if (path.endsWith('/resume')) return { id: 'mine', status: 'resuming' }
    if (path === '/api/apps/a/widget') {
      if (request.method === 'PUT') policy = { ...policy, settings: request.body }
      return policy
    }
    if (path === '/api/billing/status') return billing
    if (path === '/api/billing/tier') return request.body.preview ? (tierPreview ?? { preview: true, targetDiskMb: 30720, warning: 'memory warning' }) : (tierResult ?? { ok:true, tier:'teeny', resizing:true, operationId:'op' })
    if (path === '/api/billing/plan-change/op') return operation ?? {id:'op',tier:'teeny',status:'delivered'}
    if (path === '/api/billing/portal') return { url: 'https://billing.example.test' }
    if (path === '/api/billing/end-trial') return request.body?.reason ? { ok: true, feedbackRecorded: true } : { ok: true }
    if (path === '/api/billing/checkout') return { url: 'https://checkout.example.test' }
    if (path === '/api/auth/logout') return { ok: true }
    throw new Error(`Unexpected request ${path}`)
  }
  return { calls, lines, machine, billing, get cleared() { return cleared }, commands: accountCommands({ call,
    loadCreds: () => ({ token: 'fixture' }), clearCredentials: () => { cleared = true }, interactive, ask,
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
  await f.commands.tier(['teeny','--confirm','--monthly-usd','3','--force','--json'])
  assert.deepEqual(f.calls.at(-1).body, { tier: 'teeny', monthlyUsd: 3, force: true })
})
test('a preview approval cannot silently adopt a changed monthly price at confirmation',async()=>{
 const f=fixture()
 await f.commands.tier(['teeny','--preview','--json'])
 const approved=JSON.parse(f.lines.pop()).monthlyUsd
 assert.equal(approved,3)
 f.billing.founding=false
 await assert.rejects(f.commands.tier(['teeny','--confirm','--monthly-usd',String(approved)]),/price changed.*\$3.*\$5/)
 assert.equal(f.calls.filter(c=>c.path==='/api/billing/tier'&&!c.body.preview).length,0)
 await f.commands.tier(['teeny','--preview','--json'])
 const renewed=JSON.parse(f.lines.pop()).monthlyUsd
 await f.commands.tier(['teeny','--confirm','--monthly-usd',String(renewed)])
 assert.deepEqual(f.calls.at(-1).body,{tier:'teeny',monthlyUsd:5})
})
test('explicit confirmation requires a valid approved amount rather than inferring approval of current pricing',async()=>{
 const f=fixture()
 await assert.rejects(f.commands.tier(['teeny','--confirm']),/approved preview/)
 for(const amount of ['NaN','-1','0','infinity'])
  await assert.rejects(f.commands.tier(['teeny','--confirm','--monthly-usd',amount]),/positive USD/)
 assert.equal(f.calls.filter(c=>c.path==='/api/billing/tier').length,0)
})
test('pending plan retries display and submit the accepted price after catalogue changes',async()=>{
 const f=fixture();f.billing.founding=false;f.billing.pendingPlanChange={tier:'teeny',monthlyUsd:3,needsRetry:true}
 await f.commands.tier(['teeny','--preview','--json'])
 assert.equal(JSON.parse(f.lines.pop()).monthlyUsd,3)
 await f.commands.tier(['teeny','--confirm','--monthly-usd','3'])
 assert.deepEqual(f.calls.at(-1).body,{tier:'teeny',monthlyUsd:3})
})
test('interactive confirmation binds the amount shown in its prompt',async()=>{
 let prompt
 const f=fixture({interactive:true,ask:async text=>{prompt=text;return 'yes'}})
 await f.commands.tier(['teeny'])
 assert.match(prompt,/\$3\/mo/)
 assert.deepEqual(f.calls.at(-1).body,{tier:'teeny',monthlyUsd:3})
})
test('billing links require a chosen tier for checkout and never submit payment', async () => {
  const f = fixture()
  await f.commands.billing(['portal','--json'])
  assert.equal(JSON.parse(f.lines.pop()).url, 'https://billing.example.test')
  await assert.rejects(f.commands.billing(['checkout','teeny']), /human must choose/)
  await f.commands.billing(['checkout','teeny','--direct-paid','--confirm'])
  assert.deepEqual(f.calls.at(-1).body, { tier: 'teeny', purpose: 'direct_paid' })
})
test('end-trial requires approval and sends feedback only when provided', async () => {
  const f = fixture()
  await assert.rejects(f.commands.billing(['end-trial','--reason','Just testing']), /approval/)
  await assert.rejects(f.commands.billing(['portal','--reason','Just testing']), /only used with billing end-trial/)
  await assert.rejects(f.commands.billing(['end-trial','--confirm','--reason',' ']), /1–600 characters/)
  assert.deepEqual(f.calls, [])

  await f.commands.billing(['end-trial','--confirm','--reason','  Just testing  ','--json'])
  assert.deepEqual(f.calls.pop(), {path:'/api/billing/end-trial',method:'POST',body:{reason:'Just testing'}})
  assert.deepEqual(JSON.parse(f.lines.pop()), {ok:true,feedbackRecorded:true})

  await f.commands.billing(['end-trial','--confirm'])
  assert.deepEqual(f.calls.pop(), {path:'/api/billing/end-trial',method:'POST'})
  assert.equal(f.lines.pop(), 'Trial ended.')
})
test('end-trial can report cancellation when the server could not record the reason', async () => {
  const lines = []
  const commands = accountCommands({call: async () => ({ok:true}), output: line => lines.push(line)})
  await commands.billing(['end-trial','--confirm','--reason','Just testing','--json'])
  assert.deepEqual(JSON.parse(lines.pop()), {ok:true,feedbackRecorded:false})
})
for (const reason of ['Could not deploy my app', '']) {
  test(`interactive end-trial asks for optional feedback before confirmation (${reason ? 'answered' : 'skipped'})`, async () => {
    const prompts = []
    const f = fixture({interactive:true,ask:async prompt => {
      assert.equal(f.calls.some(call => call.method === 'POST'), false)
      prompts.push(prompt)
      return prompts.length === 1 ? reason : 'yes'
    }})
    Object.assign(f.billing, {status:'trialing',noFreeFallback:true})

    await f.commands.billing(['end-trial'])

    assert.equal(prompts.length, 2)
    assert.match(prompts[0], /optional, Enter to skip/)
    assert.match(prompts[1], /stop immediately .*End trial now/)
    assert.deepEqual(f.calls, [
      {path:'/api/billing/status'},
      {path:'/api/billing/end-trial',method:'POST',...(reason ? {body:{reason}} : {})},
    ])
  })
}
test('interactive end-trial leaves the trial active if final confirmation is declined', async () => {
  const answers = ['Could not deploy my app', '']
  const f = fixture({interactive:true,ask:async () => answers.shift()})
  f.billing.status = 'trialing'

  await f.commands.billing(['end-trial'])

  assert.deepEqual(f.calls, [{path:'/api/billing/status'}])
  assert.equal(f.lines.pop(), 'Trial kept active.')
})
test('JSON end-trial requires approval even on a terminal', async () => {
  const f = fixture({interactive:true,ask: () => assert.fail('JSON mode must not prompt')})
  await assert.rejects(f.commands.billing(['end-trial','--json']), /approval/)
  assert.deepEqual(f.calls, [])
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
 assert.match(f.lines.at(-1),/resulting disk: 30 GiB/i)
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

test('previews host downtime, binds the approved quote, and reads the operation by ID',async()=>{
 const f=fixture({tierPreview:{preview:true,action:'move',monthlyUsd:3,immediateCents:0,
   downtimeSeconds:120,downtimeMinutes:2,legacyAddressChanges:true,quote:'signed-quote'}})
 await f.commands.tier(['teeny','--preview'])
 assert.match(f.lines.pop(),/move to another host[\s\S]*2 minutes of downtime[\s\S]*new IP address[\s\S]*--quote signed-quote/)
 await f.commands.tier(['teeny','--confirm','--monthly-usd','3','--quote','signed-quote'])
 assert.deepEqual(f.calls.at(-1).body,{tier:'teeny',monthlyUsd:3,quote:'signed-quote'})
 assert.match(f.lines.pop(),/tier status op/)
 await f.commands.tier(['status','op','--json'])
 assert.equal(JSON.parse(f.lines.pop()).status,'delivered')
})

test('shows resize downtime in seconds when the preview supplies it', async () => {
  const f = fixture({ tierPreview: { preview:true, action:'resize', monthlyUsd:3, immediateCents:0,
    downtimeSeconds:20, downtimeMinutes:1, quote:'signed-quote' } })
  await f.commands.tier(['teeny','--preview'])
  assert.match(f.lines.pop(), /20 seconds of downtime/)
})

test('requires the approved quote on control versions that sign previews',async()=>{
 const f=fixture({tierPreview:{preview:true,monthlyUsd:3,quote:'fresh-quote',immediateCents:300}})
 await assert.rejects(f.commands.tier(['teeny','--confirm','--monthly-usd','3']),/Pass --quote/)
 assert.deepEqual(f.calls.filter(c=>c.path==='/api/billing/tier').map(c=>c.body),[{tier:'teeny',preview:true}])
})

test('reports terminal billing status alongside the retained move phase',async()=>{
 const f=fixture({operation:{id:'op',tier:'teeny',status:'failed',phase:'restored'}})
 await f.commands.tier(['status','op'])
 assert.match(f.lines.pop(),/failed \(restored\)/)
 assert.deepEqual(f.calls,[{path:'/api/billing/plan-change/op'}])
})

test('invalid previews cannot authorize unsigned confirmations or interactive prompts', async () => {
  for (const tierPreview of [{}, { preview:true, quote:null }, { preview:true, action:'resize' }]) {
    const f=fixture({tierPreview,interactive:true,ask:()=>assert.fail('invalid preview prompted for confirmation')})
    await assert.rejects(f.commands.tier(['teeny','--confirm','--monthly-usd','3']),/invalid plan preview/)
    await assert.rejects(f.commands.tier(['teeny']),/invalid plan preview/)
    assert.deepEqual(f.calls.filter(c=>c.path==='/api/billing/tier').map(c=>c.body),
      [{tier:'teeny',preview:true},{tier:'teeny',preview:true}])
  }
})

test('checkout previews show where the amount due will be confirmed', async () => {
  let prompt
  const f=fixture({tierPreview:{preview:true,action:'move',requiresCheckout:true,downtimeMinutes:5,
    monthlyUsd:3,immediateCents:null,quote:'signed-quote'},interactive:true,ask:async text=>{prompt=text;return 'no'}})
  await f.commands.tier(['teeny','--preview'])
  assert.match(f.lines.pop(),/Checkout is required and will show the amount due/)
  await f.commands.tier(['teeny'])
  assert.match(prompt,/Checkout is required and will show the amount due/)
  assert.match(prompt,/move to another host.*5 minutes of downtime/)
  assert.ok(f.calls.filter(c=>c.path==='/api/billing/tier').every(c=>c.body.preview))
})

test('an already selected tier needs no placement or confirmation', async () => {
  const f=fixture({tierPreview:{preview:true,action:'resize',unchanged:true,available:false,monthlyUsd:3,quote:'signed-quote'},
    interactive:true,ask:()=>assert.fail('unchanged plan prompted for confirmation')})
  await f.commands.tier(['teeny','--preview'])
  assert.equal(f.lines.pop(),'teeny is already selected.')
  await f.commands.tier(['teeny'])
  assert.equal(f.lines.pop(),'teeny is already selected.')
  await f.commands.tier(['teeny','--confirm','--monthly-usd','3','--json'])
  assert.deepEqual(JSON.parse(f.lines.pop()),{ok:true,tier:'teeny',unchanged:true})
  assert.ok(f.calls.filter(c=>c.path==='/api/billing/tier').every(c=>c.body.preview))
})

test('returns a checkout link for a confirmed change that requires payment', async () => {
  const f=fixture({tierResult:{checkoutUrl:'https://checkout.example.test'}})
  await f.commands.tier(['teeny','--confirm','--monthly-usd','3','--quote','signed-quote'])
  assert.equal(f.lines.pop(),'Human payment required: https://checkout.example.test')
})

test('rejects missing or mismatched plan change status replies', async () => {
  for (const operation of [{}, {id:'op',status:''}, {id:'other',status:'delivered'}]) {
    const f=fixture({operation})
    await assert.rejects(f.commands.tier(['status','op','--json']),/Unable to confirm the plan change status/)
    assert.deepEqual(f.lines,[])
  }
})
