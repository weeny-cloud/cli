import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url))
const api = 'http://127.0.0.1:3123'
function fixture(source) {
  const dir = mkdtempSync(join(tmpdir(), 'weeny-cli-admission-'))
  const profile = join(dir, 'profile'), key = join(profile, 'ssh', 'weeny_ed25519')
  mkdirSync(join(profile, 'ssh'), { recursive: true })
  writeFileSync(key, 'fixture-private-key')
  writeFileSync(key + '.pub', 'ssh-ed25519 fixture-public-key fixture')
  writeFileSync(join(profile, 'credentials.json'), JSON.stringify({ email: 'person@example.test', token: 'test-token', apiBase: api, keyPath: key }))
  const preload = join(dir, 'fixture.mjs')
  writeFileSync(preload, `import assert from 'node:assert/strict';
import child from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
const timer = globalThis.setTimeout;
globalThis.setTimeout = (fn,ms,...args) => timer(fn,ms===5000?0:ms,...args);
const machine = {id:'fixture',name:'weeny-stg-m1234abcd',status:'running',ip:'192.0.2.1',tier:'free',memMb:1024,freeIdleMinutes:17};
${source}
`)
  const env = { ...process.env, WEENY_ENV: 'staging', WEENY_API: api, WEENY_CONFIG_DIR: profile }
  delete env.WEENY_TOKEN; delete env.WEENY_SSH_KEY_FILE; delete env.WEENY_KNOWN_HOSTS_FILE
  return {
    dir, profile,
    run: (...args) => spawnSync(process.execPath, ['--import', preload, cli, ...args], { env, encoding: 'utf8', timeout: 10000 }),
    close: () => rmSync(dir, { recursive: true, force: true }),
  }
}

test('free creation requests the free offer and gives one configured limits notice on stderr', () => {
  const f = fixture(`let created=false;
globalThis.fetch=async(url,opts)=>{
 if(url.endsWith('/api/me')) return Response.json({serverAccess:{status:'available',freeIdleMinutes:17}});
 assert.equal(url,${JSON.stringify(api + '/api/machines')});
 if(opts.method==='POST') {created=true; assert.deepEqual(JSON.parse(opts.body),{sshPublicKey:'ssh-ed25519 fixture-public-key fixture',offer:'free'});}
 else {assert.ok(created); assert.equal(opts.method,'GET');}
 return Response.json(opts.method==='POST'?machine:{machines:[machine]});
};`)
  try {
    const r = f.run('create', '--free')
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /your server is ready/)
    assert.match(r.stderr, /Free · 1 GB RAM · sleeps after 17 idle minutes/)
    assert.match(r.stderr, /Tell your human about sleeping/)
    assert.equal((r.stderr.match(/Free ·/g) ?? []).length, 1)
    assert.doesNotMatch(r.stdout, /idle minutes|Tell your human|Build larger/)
  } finally { f.close() }
})

test('default creation lets the server choose the existing entitlement without claiming free limits', () => {
  const f = fixture(`globalThis.fetch=async(url,opts)=>{
 assert.equal(url,${JSON.stringify(api + '/api/machines')});
 const paid={...machine,tier:'weeny',memMb:4096};
 if(opts.method==='POST') assert.ok(!Object.hasOwn(JSON.parse(opts.body),'offer'));
 return Response.json(opts.method==='POST'?paid:{machines:[paid]});
};`)
  try {
    const r = f.run('create')
    assert.equal(r.status, 0, r.stderr)
    assert.doesNotMatch(r.stderr, /Free ·|1 GB RAM/)
  } finally { f.close() }
})

test('login accepts object availability, saves the token and explains free capacity to the agent', () => {
  const f = fixture(`globalThis.fetch=async(url,opts)=>{
 assert.equal(url,${JSON.stringify(api + '/api/auth/verify')});
 return Response.json({status:'ok',email:'person@example.test',token:'new-token',serverAccess:{status:'available',freeIdleMinutes:17,offers:{trial:{available:false},free:{available:true}}}});
};`)
  try {
    const r = f.run('login', '--email', 'person@example.test', '--code', '123456')
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stderr, /create --free/)
    assert.match(r.stderr, /First tell your human.*17 idle minutes/)
    assert.doesNotMatch(r.stderr, /trial available|No trial time|#undefined/)
    assert.doesNotMatch(r.stdout, /1 GB|idle minutes|paid plan/)
    assert.equal(JSON.parse(readFileSync(join(f.profile, 'credentials.json'), 'utf8')).token, 'new-token')
  } finally { f.close() }
})

test('bare CLI reads availability when there is no server and does not promise a trial', () => {
  const f = fixture(`globalThis.fetch=async(url)=>{
 if(url.endsWith('/api/machines')) return Response.json({machines:[]});
 assert.equal(url,${JSON.stringify(api + '/api/me')});
 return Response.json({serverAccess:{status:'waitlisted',offers:{trial:{available:false},free:{available:false}},plans:[{tier:'teeny',available:true}]}});
};`)
  try {
    const r = f.run()
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stderr, /waiting for a server/)
    assert.match(r.stderr, /Only the human should choose a paid plan/)
    assert.match(r.stderr, /charges immediately without a free trial/)
    assert.doesNotMatch(r.stdout, /starts your free trial/)
  } finally { f.close() }
})

test('bare CLI shows a free server once without rechecking admission or waking it', () => {
  const f = fixture(`globalThis.fetch=async(url,opts)=>{
 assert.equal(url,${JSON.stringify(api + '/api/machines')}); assert.equal(opts.method,'GET');
 return Response.json({machines:[{...machine,status:'sleeping'}]});
};`)
  try {
    const r = f.run()
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /server: sleeping/)
    assert.equal((r.stderr.match(/Free ·/g) ?? []).length, 1)
    assert.match(r.stderr, /17 idle minutes/)
    assert.doesNotMatch(r.stdout, /idle minutes/)
  } finally { f.close() }
})

test('create refusal prints available free alternative and paid handoff without polling', () => {
  const f = fixture(`globalThis.fetch=async(url,opts)=>{
 assert.equal(url,${JSON.stringify(api + '/api/machines')}); assert.equal(opts.method,'POST');
 return Response.json({statusMessage:'Full-size trials are full',data:{code:'waitlisted',freeIdleMinutes:17,offers:{trial:{available:false},free:{available:true}}}},{status:403});
};`)
  try {
    const r = f.run('create')
    assert.equal(r.status, 1)
    assert.match(r.stderr, /create --free/)
    assert.match(r.stderr, /Only the human should choose a paid plan/)
    assert.match(r.stderr, /Full-size trials are full/)
    assert.doesNotMatch(r.stdout, /setting up|queued/)
  } finally { f.close() }
})

for (const initial of ['sleeping', 'resuming']) {
  test(`ssh waits for a ${initial} free server and keeps its stdout clean`, () => {
    const f = fixture(`let reads=0,posts=0;
globalThis.fetch=async(url,opts)=>{
 if(url.endsWith('/resume')) {assert.equal(${JSON.stringify(initial)},'sleeping');assert.equal(opts.method,'POST');posts++;return Response.json({status:'resuming'});}
 assert.equal(url,${JSON.stringify(api + '/api/machines')});
 reads++;return Response.json({machines:[{...machine,status:reads===1?${JSON.stringify(initial)}:reads===2?'resuming':'running'}]});
};
child.execFileSync=(command,args,opts)=>{assert.equal(command,'ssh');assert.equal(args.at(-1),'echo payload');process.stdout.write('payload\\n');};
syncBuiltinESMExports();
process.on('exit',()=>{assert.equal(reads,3);assert.equal(posts,${initial === 'sleeping' ? 1 : 0});});`)
    try {
      const r = f.run('ssh', 'echo payload')
      assert.equal(r.status, 0, r.stderr)
      assert.equal(r.stdout, 'payload\n')
      assert.equal((r.stderr.match(/waking your server/g) ?? []).length, 1)
      assert.doesNotMatch(r.stderr, /Free ·|larger builds/)
    } finally { f.close() }
  })
}

test('ssh never resumes a suspended server', () => {
  const f = fixture(`globalThis.fetch=async(url,opts)=>{
 assert.equal(url,${JSON.stringify(api + '/api/machines')});assert.equal(opts.method,'GET');
 return Response.json({machines:[{...machine,status:'suspended'}]});
};
child.execFileSync=()=>{throw Error('Must not SSH');};syncBuiltinESMExports();`)
  try {
    const r = f.run('ssh', 'true')
    assert.equal(r.status, 1)
    assert.match(r.stderr, /status: suspended/)
    assert.doesNotMatch(r.stderr, /waking your server/)
  } finally { f.close() }
})

test('wake polling is bounded and never connects before the server is ready', () => {
  const f = fixture(`let reads=0;
globalThis.fetch=async(url,opts)=>{
 assert.equal(url,${JSON.stringify(api + '/api/machines')});assert.equal(opts.method,'GET');reads++;
 return Response.json({machines:[{...machine,status:'resuming'}]});
};
child.execFileSync=()=>{throw Error('Must not SSH');};syncBuiltinESMExports();
process.on('exit',()=>assert.equal(reads,61));`)
  try {
    const r = f.run('ssh', 'true')
    assert.equal(r.status, 1)
    assert.match(r.stderr, /still waking after 5 minutes/)
  } finally { f.close() }
})

for (const { name, build, remembered, tier, memMb, expected, sleep } of [
  { name: 'explicit free build after wake', build: 'npm run build', tier: 'free', memMb: 1024, expected: true, sleep: true },
  { name: 'remembered teeny build', remembered: 'npm ci && npm run build', tier: 'teeny', memMb: 1024, expected: true },
  { name: 'disabled remembered build', build: '', remembered: 'npm run build', tier: 'free', memMb: 1024, expected: false },
  { name: 'prebuilt free deployment', tier: 'free', memMb: 1024, expected: false },
  { name: '4 GB build', build: 'npm run build', tier: 'weeny', memMb: 4096, expected: false },
]) {
  test(`push ${name} uses one memory notice and preserves the deploy payload`, () => {
    const f = fixture(`let reads=0,resumed=false,uploaded=false,finalized=false;
globalThis.fetch=async(url,opts)=>{
 if(url.endsWith('/resume')) {assert.ok(${!!sleep});assert.equal(opts.method,'POST');resumed=true;return Response.json({status:'resuming'});}
 assert.equal(url,${JSON.stringify(api + '/api/machines')});
 reads++;return Response.json({machines:[{...machine,tier:${JSON.stringify(tier)},memMb:${memMb},status:${!!sleep}&&reads===1?'sleeping':'running'}]});
};
child.execFileSync=(command,args,opts)=>{
 if(command==='git') throw Error('No git metadata');
 if(command==='rsync') {uploaded=true;assert.ok(args.includes('node_modules'));return '';}
 assert.equal(command,'ssh');const line=args.at(-1);
 if(line==='weeny _deploy-begin fixture') return JSON.stringify({deploymentId:'deploy-123',incomingDir:'/apps/fixture/incoming/deploy-123',defaults:{start:['node','server.js'],build:${JSON.stringify(remembered ?? null)}}});
 assert.ok(uploaded);assert.equal(line.startsWith('WEENY_BUILD_ADVICE_SHOWN=1 '),${expected});
 assert.match(line,/weeny _deploy-finalize fixture --id deploy-123/);
 ${build !== undefined ? `assert.ok(line.includes(${JSON.stringify("--build '" + build + "'")}));` : "assert.ok(!line.includes('--build'));"}
 finalized=true;process.stdout.write('{"deployed":true}\\n');return '';
};
syncBuiltinESMExports();process.on('exit',()=>{assert.ok(finalized);assert.equal(resumed,${!!sleep});});`)
    try {
      const app = join(f.dir, 'fixture')
      mkdirSync(app); writeFileSync(join(app, 'server.js'), 'process.exit(0)')
      const r = f.run('push', app, 'fixture', ...(build !== undefined ? ['--build', build] : []))
      assert.equal(r.status, 0, r.stderr)
      assert.equal((r.stderr.match(/larger builds may run out of memory/g) ?? []).length, expected ? 1 : 0)
      assert.doesNotMatch(r.stdout, /larger builds may run out of memory|Free ·|Tell your human/)
      assert.match(r.stdout, /\{"deployed":true\}/)
    } finally { f.close() }
  })
}

test('legacy approved login does not assume an existing account needs a server', () => {
  const f = fixture(`globalThis.fetch=async()=>Response.json({status:'ok',email:'person@example.test',token:'returning-token',serverAccess:'approved'});`)
  try {
    const r = f.run('login', '--email', 'person@example.test', '--code', '123456')
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /signed in/)
    assert.doesNotMatch(r.stderr, /No server|create --free|waiting/)
  } finally { f.close() }
})

test('bare CLI tells an existing paid account to create its purchased server', () => {
  const f = fixture(`globalThis.fetch=async(url)=>{
 if(url.endsWith('/api/machines')) return Response.json({machines:[]});
 return Response.json({serverAccess:{status:'available',paid:true,canCreate:true,offers:{trial:{available:false},free:{available:false}}}});
};`)
  try {
    const r = f.run()
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stderr, /create uses your purchased plan/)
    assert.doesNotMatch(r.stderr, /Full-size trial available|Free ·|should choose a paid/)
  } finally { f.close() }
})

test('wake stops promptly on a failure instead of running an SSH command', () => {
  const f = fixture(`let reads=0;
globalThis.fetch=async(url,opts)=>{
 assert.equal(url,${JSON.stringify(api + '/api/machines')});assert.equal(opts.method,'GET');reads++;
 return Response.json({machines:[{...machine,status:reads===1?'resuming':'failed'}]});
};
child.execFileSync=()=>{throw Error('Must not SSH');};syncBuiltinESMExports();
process.on('exit',()=>assert.equal(reads,2));`)
  try {
    const r = f.run('ssh', 'true')
    assert.equal(r.status, 1)
    assert.match(r.stderr, /could not wake \(status: failed\)/)
  } finally { f.close() }
})
