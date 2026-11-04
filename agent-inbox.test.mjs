import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawnSync} from 'node:child_process'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {inboxClient,automaticInboxAllowed} from './agent-inbox.mjs'
test('automatic delivery is bounded, concurrent-safe, throttled, not an acknowledgement and never stdout',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'weeny-inbox-'));let now=Date.now(),reads=0;const calls=[],printed=[]
 const messages=[1,2,3].map(n=>({id:String(n),version:1,severity:'warning',summary:'A warning',action:'Read health',active:true}))
 const fetcher=async(url,opts)=>{calls.push([url,opts]);if(opts.method==='GET'){reads++;return {ok:true,json:async()=>({messages})}}return {ok:true,json:async()=>({ok:true})}}
 try{
  const c=inboxClient({api:'https://staging.weeny.cloud',token:'test',dir,fetcher,now:()=>now,print:x=>printed.push(x)})
  await Promise.all([c.automatic(),c.automatic()]);assert.equal(reads,1);assert.equal(printed.length,3);assert.doesNotMatch(printed.join('\n'),/Read health/)
  assert.ok(calls.every(([,o])=>o.redirect==='error'));assert.ok(calls.filter(([,o])=>o.body).every(([,o])=>JSON.parse(o.body).action==='display'))
  await c.automatic();assert.equal(reads,1)
  now+=61000;await c.automatic();assert.equal(printed.length,5) // the third, previously undisplayed warning
  now+=86400000;await c.automatic();assert.equal(printed.length,8)
  let data;await c.command(['--json'],x=>data=JSON.parse(x));assert.equal(data.messages.length,3)
  await c.command(['ack','1'],()=>{});assert.equal(JSON.parse(calls.at(-1)[1].body).action,'ack')
 }finally{rmSync(dir,{recursive:true,force:true})}
})
test('offline optional notices are silent, explicit inbox errors remain visible',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'weeny-inbox-'));try{
 const c=inboxClient({api:'https://staging.weeny.cloud',token:'x',dir,fetcher:async()=>{throw new Error('offline')},print:()=>assert.fail('must stay quiet')})
 await c.automatic();await assert.rejects(c.command([]),/offline/)
 }finally{rmSync(dir,{recursive:true,force:true})}
})
test('raw execution, CI, JSON and relays are excluded while ordinary non-TTY agent commands work',()=>{
 for(const cmd of ['_relay','_deploy-finalize','exec','token','inbox','help','skill','ssh'])assert.equal(automaticInboxAllowed([cmd],{},{laptop:true}),false)
 assert.equal(automaticInboxAllowed(['server','--json'],{}),false)
 assert.equal(automaticInboxAllowed(['push'],{CI:'1'}),false)
 assert.equal(automaticInboxAllowed(['push'],{}),true)
 assert.equal(automaticInboxAllowed(['health'],{}),true)
})
test('optional inbox credential setup preserves help fallback for unreadable or mismatched profiles',()=>{
 const dir=mkdtempSync(join(tmpdir(),'weeny-inbox-profile-'))
 try {
  const credentials=join(dir,'credentials.json'),preload=join(dir,'preload.mjs')
  const env={...process.env,CI:'',WEENY_ENV:'staging',WEENY_API:'http://127.0.0.1:3123',WEENY_CONFIG_DIR:dir}
  delete env.WEENY_TOKEN
  for(const denied of [false,true]) {
   writeFileSync(credentials,JSON.stringify({apiBase:'https://another.invalid',token:'test-only'}))
   writeFileSync(preload,`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
const read=fs.readFileSync;fs.readFileSync=(p,...args)=>{if(${denied}&&String(p)===${JSON.stringify(credentials)})throw Object.assign(Error('denied'),{code:'EACCES'});return read(p,...args)};syncBuiltinESMExports();
globalThis.fetch=async()=>{process.stderr.write('UNEXPECTED_FETCH');throw Error('unexpected network')};`)
   const r=spawnSync(process.execPath,['--import',pathToFileURL(preload).href,fileURLToPath(new URL('./cli.mjs',import.meta.url)),'whoami'],{env,encoding:'utf8',timeout:10000})
   assert.equal(r.status,0,r.stderr)
   assert.match(r.stdout,/weeny-cloud/)
   assert.doesNotMatch(r.stderr,/UNEXPECTED_FETCH|Saved credentials|Cannot access/)
  }
 }finally{rmSync(dir,{recursive:true,force:true})}
})
