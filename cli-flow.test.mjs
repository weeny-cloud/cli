import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

test('create completes and saves its device key after a server becomes running', () => {
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
globalThis.fetch = async (url,opts) => {
  assert.equal(url,'http://127.0.0.1:3123/api/machines');
  assert.equal(opts.headers.Authorization,'Bearer test-token');
  const machine = {id:'fixture',name:'weeny-stg-m1234abcd',status:'running',ip:'192.0.2.1'};
  if(opts.method==='POST') {assert.match(JSON.parse(opts.body).sshPublicKey,/fixture-public-key/); return Response.json(machine);}
  assert.equal(opts.method,'GET'); return Response.json({machines:[machine]});
};`)
    const env = { ...process.env, WEENY_ENV: 'staging', WEENY_API: 'http://127.0.0.1:3123', WEENY_CONFIG_DIR: profile }
    delete env.WEENY_TOKEN; delete env.WEENY_SSH_KEY_FILE; delete env.WEENY_KNOWN_HOSTS_FILE
    const r = spawnSync(process.execPath, ['--import', preload, fileURLToPath(new URL('./cli.mjs', import.meta.url)), 'create'], { env, encoding: 'utf8', timeout: 10000 })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /your server is ready/)
    assert.equal(JSON.parse(readFileSync(join(profile, 'credentials.json'), 'utf8')).keyPath, key)
    assert.match(readFileSync(join(profile, 'ssh', 'config'), 'utf8'), /HostKeyAlias weeny-staging-fixture/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})


test('waitlisted login saves an origin-bound account token and explains paid access', () => {
  const dir=mkdtempSync(join(tmpdir(),'weeny-cli-waitlist-'))
  try {
    const profile=join(dir,'profile'),preload=join(dir,'fixture.mjs')
    writeFileSync(preload,`globalThis.fetch=async(url,opts)=>{
      if(url!=='http://127.0.0.1:3123/api/auth/verify')throw Error('Unexpected request');
      return Response.json({status:'ok',email:'waiting@example.test',token:'waitlisted-token',serverAccess:'waitlisted',position:7});
    };`)
    const env={...process.env,WEENY_ENV:'staging',WEENY_API:'http://127.0.0.1:3123',WEENY_CONFIG_DIR:profile}
    delete env.WEENY_TOKEN;delete env.WEENY_SSH_KEY_FILE;delete env.WEENY_KNOWN_HOSTS_FILE
    const r=spawnSync(process.execPath,['--import',preload,fileURLToPath(new URL('./cli.mjs',import.meta.url)),'login','--email','waiting@example.test','--code','123456'],{env,encoding:'utf8',timeout:10000})
    assert.equal(r.status,0,r.stderr)
    assert.match(r.stdout,/#7.*free trial waitlist/)
    assert.match(r.stdout,/charges immediately without a free trial/)
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
  const r=spawnSync(process.execPath,['--import',preload,fileURLToPath(new URL('./cli.mjs',import.meta.url)),'create'],{env,encoding:'utf8',timeout:10000})
  assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/queued for free capacity/);assert.doesNotMatch(r.stdout,/takes ~2 minutes/)
 }finally{rmSync(dir,{recursive:true,force:true})}
})
