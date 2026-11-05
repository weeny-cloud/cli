// Shared by the laptop and guest CLI. Optional notices never own a command's exit code.
import {readFileSync,writeFileSync,mkdirSync,renameSync,rmSync,statSync} from 'node:fs'
import {join} from 'node:path'
import {createHash,randomUUID} from 'node:crypto'
const read=p=>{try{return JSON.parse(readFileSync(p,'utf8'))}catch{return {}}}
function save(path,value) {
 const tmp=path+'.'+randomUUID()+'.tmp'
 try {writeFileSync(tmp,JSON.stringify(value),{mode:0o600});renameSync(tmp,path)} finally {rmSync(tmp,{force:true})}
}
export function automaticInboxAllowed(argv,env=process.env,{laptop=false}={}) {
 const cmd=argv[0]??''
 return !env.CI&&!env.WEENY_TOKEN&&!env.WEENY_SUPPRESS_NOTICES&&!argv.includes('--json')&&
 !cmd.startsWith('_')&&!['inbox','skill','help','--help','-h','token','login','logout','feedback','exec'].includes(cmd)&&
 !(laptop&&['ssh','keys'].includes(cmd))
}
export function inboxClient({api,token,machine=false,dir,fetcher=fetch,now=Date.now,print=console.error}) {
 const prefix=machine?'/api/machine/agent-messages':'/api/agent-messages'
 const identity=createHash('sha256').update(api+'\0'+token).digest('hex').slice(0,20)
 const cachePath=join(dir,'inbox-'+identity+'.json')
 async function request(path='',method='GET',body,timeout=10000) {
  const res=await fetcher(api+prefix+path,{method,redirect:'error',headers:{authorization:'Bearer '+token,'content-type':'application/json'},
   ...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(timeout)})
  if(!res.ok)throw new Error('Inbox request failed ('+res.status+')')
  return res.json()
 }
 const event=(id,action,recipient,version,timeout)=>request('/'+encodeURIComponent(id),'POST',{action,recipient,version},timeout)
 async function automatic() {
  const lock=cachePath+'.lock';let locked=false
  try {
   mkdirSync(dir,{recursive:true,mode:0o700})
   try {mkdirSync(lock);locked=true}catch {
    try{if(now()-statSync(lock).mtimeMs>30000){rmSync(lock,{recursive:true,force:true});mkdirSync(lock);locked=true}}catch{}
    if(!locked)return
   }
   let cache=read(cachePath); const at=now()
   if(cache.checkedAt&&at>=cache.checkedAt&&at-cache.checkedAt<60000)return
   cache={...cache,recipient:cache.recipient??randomUUID(),checkedAt:at,shown:cache.shown??{}}
   save(cachePath,cache) // An unwritable profile stays quiet, including network work.
   const data=await request('','GET',undefined,1000)
   const pending=data.messages.filter(m=>m.active&&!m.stale&&!m.acknowledged_at)
   let count=0
   for(const m of pending) {
    const key=m.id+':'+m.version,shown=cache.shown[key]
    if(shown&&at>=shown&&at-shown<86400000)continue
    print(`[Weeny ${m.severity}] ${m.summary.replace(/\s+/g,' ').slice(0,180)}`)
    cache.shown[key]=at; count++
    // Delivery receipts are best-effort and bounded; stdout is never touched.
    await event(m.id,'display',cache.recipient,m.version,1000).catch(()=>{})
    if(count===2)break
   }
   if(count)print(`${pending.length} active message(s). Read details: ${machine?'weeny':'npx weeny-cloud'} inbox`)
   cache.shown=Object.fromEntries(Object.entries(cache.shown).filter(([,t])=>at-t<30*86400000))
   save(cachePath,cache)
  }catch{} // Older control, offline network, corrupt/readonly profile: the command still works.
  finally {if(locked)try{rmSync(lock,{recursive:true,force:true})}catch{}}
 }
 async function command(argv,output=console.log) {
  const json=argv.includes('--json'),args=argv.filter(a=>a!=='--json'),action=args[0]??'list',id=args[1]
  if(args.length>2||!['list','read','ack'].includes(action)||(action==='list'&&id)||(action!=='list'&&!id))throw new Error('Usage: inbox [read ID|ack ID] [--json]')
  const data=action==='list'?await request():action==='read'?await request('/'+encodeURIComponent(id)):await event(id,'ack','explicit')
  output(json?JSON.stringify(data):action==='ack'?'Acknowledged.':action==='read'?`${data.message.summary}\n${data.message.body}\n${data.message.action??''}${data.message.stale?'\nThis observation is stale; check current health before acting.':''}`:
   data.messages.filter(m=>m.active&&!m.acknowledged_at).map(m=>`${m.id} [${m.severity}${m.stale?', stale':''}] ${m.summary}`).join('\n')||'No unacknowledged messages.')
  return data
 }
 return {automatic,command}
}
