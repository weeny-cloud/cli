import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
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
