import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

test('create wakes the returned server by ID and scopes connection instructions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'weeny-cli-create-'))
  try {
    const profile = join(dir, 'profile'), key = join(profile, 'ssh', 'weeny_ed25519')
    mkdirSync(join(profile, 'ssh'), { recursive: true })
    writeFileSync(key, 'fixture-private-key'); writeFileSync(key + '.pub', 'ssh-ed25519 fixture-public-key fixture')
    writeFileSync(join(profile, 'credentials.json'), JSON.stringify({ token: 'test-token', apiBase: 'http://127.0.0.1:3123' }))
    const preload = join(dir, 'fixture.mjs')
    writeFileSync(preload, `import assert from 'node:assert/strict';
const timer = globalThis.setTimeout;
globalThis.setTimeout = (fn,ms,...args) => timer(fn,ms===5000?0:ms,...args);
const sleeping = process.env.WEENY_TEST_SLEEPING === '1';
const machine = {id:'fixture',name:'weeny-stg-m1234abcd',status:'running',ip:'192.0.2.1',tier:'teeny',memMb:1024,tunnelSecret:'never-print'};
let resumed = false, polls = 0;
globalThis.fetch = async (url,opts) => {
  assert.equal(opts.headers.Authorization,'Bearer test-token');
  if (url === 'http://127.0.0.1:3123/api/machines/fixture/resume') {
    assert.ok(sleeping);
    assert.equal(opts.method, 'POST');
    resumed = true;
    return Response.json({status:'resuming'});
  }
  assert.equal(url,'http://127.0.0.1:3123/api/machines');
  if (opts.method === 'POST') {
    assert.match(JSON.parse(opts.body).sshPublicKey,/fixture-public-key/);
    return Response.json({...machine,status:sleeping ? 'sleeping' : 'queued'});
  }
  assert.equal(opts.method, 'GET');
  if (sleeping) {
    const current = {...machine,status:resumed ? 'running' : 'sleeping'};
    return Response.json({machines:[{id:'second',name:'web-b',status:'running'},current]});
  }
  const current = polls++ === 0 ? {...machine,status:'provisioning',note:'Setting up'} : machine;
  return Response.json({machines:[current]});
};`)
    const env = { ...process.env, CI: '1', WEENY_ENV: 'staging', WEENY_API: 'http://127.0.0.1:3123', WEENY_CONFIG_DIR: profile }
    delete env.WEENY_TOKEN; delete env.WEENY_SSH_KEY_FILE; delete env.WEENY_KNOWN_HOSTS_FILE
    const command = ['--import', pathToFileURL(preload).href, fileURLToPath(new URL('./cli.mjs', import.meta.url)), 'create']
    const r = spawnSync(process.execPath, command, { env: { ...env, WEENY_TEST_SLEEPING: '1' }, encoding: 'utf8', timeout: 10000 })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /your server is ready/)
    assert.match(r.stdout, /weeny-cloud ssh --server fixture/)
    assert.match(r.stdout, /weeny-cloud push \.\/myapp --server fixture/)
    assert.equal(JSON.parse(readFileSync(join(profile, 'credentials.json'), 'utf8')).keyPath, key)
    assert.match(readFileSync(join(profile, 'ssh', 'config'), 'utf8'), /HostKeyAlias weeny-staging-fixture/)

    const json = spawnSync(process.execPath, [...command, '--json'], { env: { ...env, WEENY_TEST_SLEEPING: '0' }, encoding: 'utf8', timeout: 10000 })
    assert.equal(json.status, 0, json.stderr)
    assert.equal(json.stderr, '')
    assert.deepEqual(JSON.parse(json.stdout), {
      id: 'fixture', name: 'weeny-stg-m1234abcd', status: 'running', tier: 'teeny', memMb: 1024,
    })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('named create uses its own endpoint and rejects blank and CI requests before fetching', () => {
  const dir=mkdtempSync(join(tmpdir(),'weeny-cli-named-create-'))
  try {
    const profile=join(dir,'profile'), preload=join(dir,'fixture.mjs'), api='http://127.0.0.1:3123'
    mkdirSync(profile)
    writeFileSync(join(profile,'credentials.json'),JSON.stringify({token:'test-token',apiBase:api}))
    writeFileSync(preload,`import assert from 'node:assert/strict'
globalThis.fetch=async (url,opts)=>{
  assert.equal(process.env.WEENY_TEST_FORBID_HTTP,undefined)
  assert.equal(url,'${api}/api/machines/named')
  assert.equal(opts.method,'POST')
  assert.deepEqual(JSON.parse(opts.body),{name:'web-b',tier:'teeny'})
  return Response.json({name:'web-b',status:'checkout',checkoutUrl:'https://billing.example.test/pay'})
};`)
    const env={...process.env,WEENY_ENV:'staging',WEENY_API:api,WEENY_CONFIG_DIR:profile}
    delete env.WEENY_TOKEN; delete env.WEENY_SSH_KEY_FILE; delete env.WEENY_KNOWN_HOSTS_FILE
    const args=['--import',pathToFileURL(preload).href,fileURLToPath(new URL('./cli.mjs',import.meta.url)),'create','--json']
    const run=(options,extra={})=>spawnSync(process.execPath,[...args,...options],{env:{...env,...extra},encoding:'utf8',timeout:10000})
    const good=run(['--name','web-b','--tier','teeny'])
    assert.equal(good.status,0,good.stderr)
    assert.equal(JSON.parse(good.stdout).name,'web-b')
    const rejected=run(['--name','','--tier',''],{WEENY_TEST_FORBID_HTTP:'1'})
    assert.equal(rejected.status,1)
    assert.match(JSON.parse(rejected.stderr).error.message,/Usage:.*create/)
    const ci=run(['--name','web-b','--tier','teeny'],{
      WEENY_TEST_FORBID_HTTP:'1',WEENY_TOKEN:'weeny_fixturedeploymenttoken',WEENY_SSH_KEY_FILE:join(dir,'id'),
      WEENY_KNOWN_HOSTS_FILE:join(dir,'known_hosts'),
    })
    assert.equal(ci.status,1)
    assert.match(JSON.parse(ci.stderr).error.message,/CI deployment credentials use an existing server/)
  } finally { rmSync(dir,{recursive:true,force:true}) }
})


test('legacy waitlisted login saves an origin-bound token and links to current offers', () => {
  const dir=mkdtempSync(join(tmpdir(),'weeny-cli-waitlist-'))
  try {
    const profile=join(dir,'profile'),preload=join(dir,'fixture.mjs')
    writeFileSync(preload,`globalThis.fetch=async(url,opts)=>{
      if(url!=='http://127.0.0.1:3123/api/auth/verify')throw Error('Unexpected request');
      return Response.json({status:'ok',email:'waiting@example.test',token:'waitlisted-token',serverAccess:'waitlisted',position:7});
    };`)
    const env={...process.env,WEENY_ENV:'staging',WEENY_API:'http://127.0.0.1:3123',WEENY_CONFIG_DIR:profile}
    delete env.WEENY_TOKEN;delete env.WEENY_SSH_KEY_FILE;delete env.WEENY_KNOWN_HOSTS_FILE
    const r=spawnSync(process.execPath,['--import',pathToFileURL(preload).href,fileURLToPath(new URL('./cli.mjs',import.meta.url)),'login','--email','waiting@example.test','--code','123456'],{env,encoding:'utf8',timeout:10000})
    assert.equal(r.status,0,r.stderr)
    assert.match(r.stderr,/waitlist position is #7/)
    assert.match(r.stderr,/Review current server options with your human/)
    assert.deepEqual(JSON.parse(readFileSync(join(profile,'credentials.json'),'utf8')),{email:'waiting@example.test',token:'waitlisted-token',apiBase:'http://127.0.0.1:3123'})
  } finally {rmSync(dir,{recursive:true,force:true})}
})

test('a free capacity queue returns promptly without pretending provisioning has started',()=>{
 const dir=mkdtempSync(join(tmpdir(),'weeny-cli-queue-'))
 try {
  const profile=join(dir,'profile'),preload=join(dir,'fixture.mjs');mkdirSync(join(profile,'ssh'),{recursive:true})
  writeFileSync(join(profile,'ssh','weeny_ed25519.pub'),'ssh-ed25519 fixture-public-key fixture')
  writeFileSync(join(profile,'credentials.json'),JSON.stringify({token:'test-token',apiBase:'http://127.0.0.1:3123'}))
  writeFileSync(preload,`globalThis.fetch=async(url,opts)=>{if(opts.method!=='POST')throw Error('Must not poll provisioning');return Response.json({id:'fixture',name:'queued-server',status:'queued',waitingForCapacity:true,capacityStatus:'waiting_free_capacity'})}`)
  const env={...process.env,WEENY_ENV:'staging',WEENY_API:'http://127.0.0.1:3123',WEENY_CONFIG_DIR:profile}
  delete env.WEENY_TOKEN;delete env.WEENY_SSH_KEY_FILE;delete env.WEENY_KNOWN_HOSTS_FILE
  const r=spawnSync(process.execPath,['--import',pathToFileURL(preload).href,fileURLToPath(new URL('./cli.mjs',import.meta.url)),'create'],{env,encoding:'utf8',timeout:10000})
  assert.equal(r.status,0,r.stderr);assert.match(r.stderr,/server request is queued/);assert.doesNotMatch(r.stdout,/takes ~2 minutes/)
  const json=spawnSync(process.execPath,['--import',pathToFileURL(preload).href,fileURLToPath(new URL('./cli.mjs',import.meta.url)),'create','--json'],{env,encoding:'utf8',timeout:10000})
  assert.equal(json.status,0,json.stderr)
  assert.equal(json.stderr,'')
  assert.equal(JSON.parse(json.stdout).waitingForCapacity,true)
 }finally{rmSync(dir,{recursive:true,force:true})}
})

test('help stays offline and command arguments reach OpenSSH and push intact', () => {
  const dir = mkdtempSync(join(tmpdir(), 'weeny-cli-arguments-'))
  try {
    const api = 'http://127.0.0.1:3123', profile = join(dir, 'profile'), preload = join(dir, 'fixture.mjs')
    mkdirSync(join(profile, 'ssh'), { recursive: true })
    writeFileSync(join(profile, 'ssh', 'weeny_ed25519'), 'fixture-private-key')
    writeFileSync(join(profile, 'credentials.json'), JSON.stringify({ token: 'test-token', apiBase: api }))
    writeFileSync(preload, `import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
globalThis.fetch = async (url, opts) => {
  if (process.env.WEENY_TEST_OFFLINE === '1') process.exit(70)
  assert.equal(url, '${api}/api/machines')
  assert.equal(opts.method, 'GET')
  return Response.json({ machines: [{ id:'fixture', name:'web-a', status:'running', ip:'192.0.2.1' }] })
}
childProcess.execFileSync = (program, args) => {
  if (program === 'git') throw new Error('no git metadata in this fixture')
  const deployment = process.env.WEENY_TEST_NETWORKING
  const appUser = process.env.WEENY_TEST_APP_USER
  if (program === 'rsync') {
    if (['unsupported', 'auto-unsupported'].includes(deployment) || appUser === 'unsupported') process.exit(70)
    return ''
  }
  assert.equal(program, 'ssh')
  if (process.argv[2] === 'ssh') return console.log(JSON.stringify(args.slice(2)))
  assert.equal(process.argv[2], 'push')
  if (args.at(-1) === 'weeny _deploy-begin demo') return JSON.stringify({
    deploymentId:'fixture', incomingDir:'/tmp/incoming', capabilities:{
      deploymentNetworking: ['supported','stale','auto','auto-unsupported'].includes(deployment), autoPort: deployment === 'auto', appUser: appUser === 'supported',
    },
  })
  const networking = deployment ? " --port '" + (deployment === 'auto' ? 'auto' : '3000') + "' --origin-route 'store'" : ''
  const userFlag = appUser ? " --user 'app.user'" : ""
  assert.equal(args.at(-1), "weeny _deploy-finalize demo --id fixture" + networking + userFlag + " --tag '-h' -- 'npm' 'start'")
  if (deployment === 'stale') throw Object.assign(new Error('stale deployment base'), { status: 3 })
  console.log('deployment finalized')
}
syncBuiltinESMExports()
`)
    const env = { ...process.env, CI: '1', WEENY_ENV: 'staging', WEENY_API: api, WEENY_CONFIG_DIR: profile }
    delete env.WEENY_TOKEN; delete env.WEENY_SSH_KEY_FILE; delete env.WEENY_KNOWN_HOSTS_FILE
    const command = ['--import', pathToFileURL(preload).href, fileURLToPath(new URL('./cli.mjs', import.meta.url))]
    const run = (args, offline = false, extra = {}) => spawnSync(process.execPath, [...command, ...args], {
      env: { ...env, WEENY_TEST_OFFLINE: offline ? '1' : '0', ...extra }, cwd: dir, encoding: 'utf8', timeout: 10000,
    })

    for (const [args, expected] of [
      [['whoami', '--help'], /weeny-cloud login/],
      [['status', '--json', '-h'], /weeny-cloud server status/],
      [['push', '.', 'demo', '--tag', '-h', '--help'], /weeny-cloud push/],
    ]) {
      const result = run(args, true)
      assert.equal(result.status, 0, result.stderr)
      assert.equal(result.stderr, '')
      assert.match(result.stdout, expected)
    }
    for (const [args, expected] of [
      [['ssh', '-t', 'true'], ['-t', 'true']],
      [['ssh', '--server', 'web-a', '-T', 'true'], ['-T', 'true']],
      [['ssh', '--server', 'web-a', '--', '-h'], ['--', '-h']],
    ]) {
      const result = run(args)
      assert.equal(result.status, 0, result.stderr)
      assert.deepEqual(JSON.parse(result.stdout), ['root@weeny-staging-fixture', ...expected])
    }
    const pushed = run(['push', '.', 'demo', '--tag', '-h', '--', 'npm', 'start'])
    assert.equal(pushed.status, 0, pushed.stderr)
    assert.match(pushed.stdout, /deployment finalized/)
    const networkPush = ['push', '.', 'demo', '--tag', '-h', '--port', '3000', '--origin-route', 'store', '--', 'npm', 'start']
    const ready = run(networkPush, false, { WEENY_TEST_NETWORKING: 'supported' })
    assert.equal(ready.status, 0, ready.stderr)
    assert.match(ready.stdout, /deployment finalized/)
    const unsupported = run(networkPush, false, { WEENY_TEST_NETWORKING: 'unsupported' })
    assert.equal(unsupported.status, 1, unsupported.stderr)
    assert.match(unsupported.stderr, /updated Weeny CLI before --port or --origin-route/)
    const stale = run(networkPush, false, { WEENY_TEST_NETWORKING: 'stale' })
    assert.equal(stale.status, 3, stale.stderr)
    assert.match(stale.stderr, /Rerun the same push command to keep its deployment options/)
    const autoPush = networkPush.map(arg => arg === '3000' ? 'auto' : arg)
    const automatic = run(autoPush, false, { WEENY_TEST_NETWORKING: 'auto' })
    assert.equal(automatic.status, 0, automatic.stderr)
    assert.match(automatic.stdout, /deployment finalized/)
    const unsupportedAuto = run(autoPush, false, { WEENY_TEST_NETWORKING: 'auto-unsupported' })
    assert.equal(unsupportedAuto.status, 1, unsupportedAuto.stderr)
    assert.match(unsupportedAuto.stderr, /updated Weeny CLI before --port auto can be used/)
    const userPush = ['push', '.', 'demo', '--tag', '-h', '--user', 'app.user', '--', 'npm', 'start']
    const userSupported = run(userPush, false, { WEENY_TEST_APP_USER: 'supported' })
    assert.equal(userSupported.status, 0, userSupported.stderr)
    assert.match(userSupported.stdout, /deployment finalized/)
    const userUnsupported = run(userPush, false, { WEENY_TEST_APP_USER: 'unsupported' })
    assert.equal(userUnsupported.status, 1, userUnsupported.stderr)
    assert.match(userUnsupported.stderr, /updated Weeny CLI before --user can be used/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a staging JSON failure has one parseable error and no plain-text banner', () => {
  const dir = mkdtempSync(join(tmpdir(), 'weeny-cli-json-'))
  try {
    const env = { ...process.env, WEENY_ENV: 'staging', WEENY_API: 'http://127.0.0.1:3123', WEENY_CONFIG_DIR: dir }
    delete env.WEENY_TOKEN; delete env.WEENY_SSH_KEY_FILE; delete env.WEENY_KNOWN_HOSTS_FILE
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./cli.mjs', import.meta.url)), 'server', 'delete', '--json'], { env, encoding: 'utf8', timeout: 10000 })
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.match(JSON.parse(result.stderr).error.message, /approval/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('rejected and unreadable plan change responses exit nonzero with structured output', () => {
  const dir=mkdtempSync(join(tmpdir(),'weeny-cli-rejected-tier-'))
  try {
    const profile=join(dir,'profile'), preload=join(dir,'fixture.mjs')
    mkdirSync(profile)
    writeFileSync(join(profile,'credentials.json'),JSON.stringify({token:'test-token',apiBase:'http://127.0.0.1:3123'}))
    writeFileSync(preload,`import assert from 'node:assert/strict';
globalThis.fetch = async (url,opts) => {
  if (url.endsWith('/api/billing/status')) return Response.json({founding:true,tiers:[{name:'weeny',foundingUsd:8}]});
  assert.equal(url,'http://127.0.0.1:3123/api/billing/tier');
  assert.equal(JSON.parse(opts.body).quote,'signed-preview');
  if (process.env.WEENY_TEST_UNREADABLE_REPLY) return new Response('<html>Unavailable</html>');
  return Response.json({ok:false,tier:'weeny',operationId:'failed-op',operationStatus:'failed'});
};`)
    const env={...process.env,WEENY_ENV:'staging',WEENY_API:'http://127.0.0.1:3123',WEENY_CONFIG_DIR:profile}
    delete env.WEENY_TOKEN;delete env.WEENY_SSH_KEY_FILE;delete env.WEENY_KNOWN_HOSTS_FILE
    const cli=fileURLToPath(new URL('./cli.mjs',import.meta.url))
    const args=['--import',pathToFileURL(preload).href,cli,
      'tier','weeny','--confirm','--monthly-usd','8','--quote','signed-preview','--json']
    const result=spawnSync(process.execPath,args,{env,encoding:'utf8',timeout:10000})
    assert.equal(result.status,1,result.stderr)
    assert.deepEqual(JSON.parse(result.stdout),{ok:false,tier:'weeny',operationId:'failed-op',operationStatus:'failed'})

    const unreadable=spawnSync(process.execPath,args,{env:{...env,WEENY_TEST_UNREADABLE_REPLY:'1'},encoding:'utf8',timeout:10000})
    assert.equal(unreadable.status,1)
    assert.equal(unreadable.stdout,'')
    assert.match(JSON.parse(unreadable.stderr).error.message,/outcome is unknown.*billing status before retrying/)
  } finally { rmSync(dir,{recursive:true,force:true}) }
})
