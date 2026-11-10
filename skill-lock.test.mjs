import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, utimesSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { trySkillLock, releaseSkillLock } from './skill-lock.mjs'

const locks = new URL('./skill-lock.mjs', import.meta.url).href
const updates = new URL('./skill-updates.mjs', import.meta.url).href
const staleOwner = 'owner-00000000-0000-4000-8000-000000000000.json'
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'weeny-skill-lock-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
function abandoned(dir, name = 'skill-update.lock') {
  const path = join(dir, name)
  mkdirSync(path)
  writeFileSync(join(path, staleOwner), '{"pid":0}')
  utimesSync(join(path, staleOwner), new Date(0), new Date(0))
  return path
}

test('an old timestamp never evicts a live owner', t => {
  const dir = fixture(t), lock = trySkillLock(dir)
  utimesSync(join(lock.path, lock.owner), new Date(0), new Date(0))
  assert.equal(trySkillLock(dir), null)
  assert.deepEqual(readdirSync(lock.path), [lock.owner])
  releaseSkillLock(lock)
  assert.equal(existsSync(lock.path), false)
})

test('a former owner cannot release a replacement lock', t => {
  const dir = fixture(t), old = trySkillLock(dir)
  // Model an abandoned owner while retaining its old release handle.
  writeFileSync(join(old.path, old.owner), '{"pid":0}')
  utimesSync(join(old.path, old.owner), new Date(0), new Date(0))
  const replacement = trySkillLock(dir)
  assert.ok(replacement); assert.notEqual(old.owner, replacement.owner)
  releaseSkillLock(old)
  assert.deepEqual(readdirSync(replacement.path), [replacement.owner])
  assert.equal(trySkillLock(dir), null)
  releaseSkillLock(replacement)
  assert.equal(existsSync(replacement.path), false)
})

test('explicit refresh retries when a colliding lock disappears during inspection', t => {
  const dir = fixture(t), path = abandoned(dir), worker = join(dir, 'disappearing.mjs')
  writeFileSync(worker, `import fs from 'node:fs';
import assert from 'node:assert/strict';
import {syncBuiltinESMExports} from 'node:module';
const original = fs.readdirSync; let disappeared = false;
fs.readdirSync = (path, ...args) => {
  if (path === ${JSON.stringify(path)} && !disappeared) {
    disappeared = true; fs.rmSync(path, {recursive:true});
  }
  return original(path, ...args);
};
syncBuiltinESMExports();
const {installSkill} = await import(${JSON.stringify(updates)});
await installSkill({production:false,api:'http://127.0.0.1:3123',dir:${JSON.stringify(dir)}}, '/fixture/cli.mjs', {
  fetchImpl:async()=>new Response('---\\nname: weeny\\ndescription: Test\\n---\\nGuide\\n')
});
assert.equal(disappeared,true);
`)
  execFileSync(process.execPath, [worker], { encoding: 'utf8', timeout: 5000 })
  assert.match(readFileSync(join(dir, 'skills', 'weeny', 'SKILL.md'), 'utf8'), /Guide/)
  assert.equal(existsSync(path), false)
  assert.ok(JSON.parse(readFileSync(join(dir, 'skill-update.json'))).installedHash)
})

test('Windows delete-pending cleanup yields without touching a replacement owner', t => {
  const dir = fixture(t), path = abandoned(dir), worker = join(dir, 'delete-pending.mjs')
  writeFileSync(worker, `import fs from 'node:fs';
import assert from 'node:assert/strict';
import {syncBuiltinESMExports} from 'node:module';
const {trySkillLock,releaseSkillLock}=await import(${JSON.stringify(locks)});
Object.defineProperty(process,'platform',{value:'win32'});
const original=fs.unlinkSync;let replacement;
fs.unlinkSync=(file,...args)=>{
  if(file===${JSON.stringify(join(path, staleOwner))}) {
    original(file,...args);fs.rmdirSync(${JSON.stringify(path)});
    replacement=trySkillLock(${JSON.stringify(dir)});
    assert.ok(replacement);
    throw Object.assign(new Error('stale file is being deleted by another contender'),{code:'EPERM'});
  }
  return original(file,...args);
};
syncBuiltinESMExports();
assert.equal(trySkillLock(${JSON.stringify(dir)}),null);
assert.deepEqual(fs.readdirSync(${JSON.stringify(path)}),[replacement.owner]);
assert.equal(trySkillLock(${JSON.stringify(dir)}),null);
releaseSkillLock(replacement);
assert.deepEqual(fs.readdirSync(${JSON.stringify(dir)}),['delete-pending.mjs']);
`)
  execFileSync(process.execPath, [worker], { encoding: 'utf8', timeout: 5000 })
})

test('stale cleanup still reports unrelated permission and filesystem errors', t => {
  const dir = fixture(t), path = abandoned(dir), worker = join(dir, 'permission-errors.mjs')
  writeFileSync(worker, `import fs from 'node:fs';
import assert from 'node:assert/strict';
import {syncBuiltinESMExports} from 'node:module';
const {trySkillLock}=await import(${JSON.stringify(locks)});
const original=fs.unlinkSync;
for(const [platform,code] of [['win32','EACCES'],['win32','EROFS'],['linux','EPERM']]) {
  Object.defineProperty(process,'platform',{value:platform});
  fs.unlinkSync=(file,...args)=>{
    if(file===${JSON.stringify(join(path, staleOwner))}) throw Object.assign(new Error('fixture permission denied'),{code});
    return original(file,...args);
  };
  syncBuiltinESMExports();
  assert.throws(()=>trySkillLock(${JSON.stringify(dir)}),error=>error.code===code);
  assert.deepEqual(fs.readdirSync(${JSON.stringify(path)}),[${JSON.stringify(staleOwner)}]);
}
assert.deepEqual(fs.readdirSync(${JSON.stringify(dir)}).sort(),['permission-errors.mjs','skill-update.lock']);
`)
  execFileSync(process.execPath, [worker], { encoding: 'utf8', timeout: 5000 })
})

for (const name of ['skill-update.lock', 'resource-notices-fixture.json.lock']) test(`two processes recovering the same abandoned ${name} leave exactly one owner`, { timeout: 15000 }, async t => {
  const dir = fixture(t), path = abandoned(dir, name), barrier = join(dir, 'recover'), worker = join(dir, 'contender.mjs')
  writeFileSync(worker, `import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
const original = fs.unlinkSync;
fs.unlinkSync = (path, ...args) => {
  if(path === ${JSON.stringify(join(path, staleOwner))}) {
    // The lock API is synchronous. Publish readiness synchronously too: IPC may
    // need the event loop to flush, which the barrier below deliberately blocks.
    fs.writeFileSync(process.argv[2],'observed');
    const deadline=Date.now()+5000;
    while(!fs.existsSync(${JSON.stringify(barrier)})) {
      if(Date.now()>deadline) throw Error('recovery barrier timed out');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
    }
  }
  return original(path,...args);
};
syncBuiltinESMExports();
const {trySkillLock,releaseSkillLock}=await import(${JSON.stringify(locks)});
const lock=trySkillLock(${JSON.stringify(dir)},{name:${JSON.stringify(name)}});
if(lock) {
  process.on('message',()=>{releaseSkillLock(lock);process.disconnect()});
  process.send({type:'result',owner:lock.owner});
} else process.send({type:'result',owner:null},()=>process.disconnect());
`)
  function launch(label) {
    const observedPath = join(dir, `${label}.observed`)
    const child = spawn(process.execPath, [worker, observedPath], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
    t.after(() => child.kill())
    let result, rejectResult, failure, gotResult = false, stderr = ''
    const outcome = new Promise((resolve, reject) => { result = resolve; rejectResult = reject })
    // A worker can fail before the parent finishes waiting for both observations.
    outcome.catch(() => {})
    child.stderr.on('data', data => { stderr += data })
    child.on('error', error => { failure = error; rejectResult(error) })
    child.on('message', message => {
      if (message.type === 'result') { gotResult = true; result(message.owner) }
    })
    const exited = new Promise(resolve => child.on('close', (code, signal) => {
      if (code !== 0 || !gotResult) {
        failure = new Error(`contender ${label} exited before completing (code ${code}, signal ${signal}): ${stderr}`)
        rejectResult(failure)
      }
      resolve({ code, stderr })
    }))
    const sawOldOwner = (async () => {
      while (!existsSync(observedPath)) {
        if (failure) throw failure
        if (t.signal.aborted) throw t.signal.reason
        await new Promise(resolve => setTimeout(resolve, 10))
      }
    })()
    return { child, sawOldOwner, outcome, exited }
  }
  const a = launch('a'), b = launch('b')
  await Promise.all([a.sawOldOwner, b.sawOldOwner])
  writeFileSync(barrier, 'go') // Both contenders have already inspected the same owner.
  const owners = await Promise.all([a.outcome, b.outcome])
  assert.equal(owners.filter(Boolean).length, 1)
  assert.deepEqual(readdirSync(path), [owners.find(Boolean)])
  assert.equal(trySkillLock(dir, { name }), null)
  const winner = owners[0] ? a : b
  winner.child.send('release')
  for (const exit of await Promise.all([a.exited, b.exited])) assert.equal(exit.code, 0, exit.stderr)
  assert.equal(existsSync(path), false)
})

test('named notice locks stay independent and a former owner cannot release a replacement', t => {
  const dir = fixture(t), name = 'resource-notices-fixture.json.lock'
  const skill = trySkillLock(dir), old = trySkillLock(dir, { name })
  assert.ok(old)
  assert.notEqual(skill.path, old.path)
  writeFileSync(join(old.path, old.owner), '{"pid":0}')
  utimesSync(join(old.path, old.owner), new Date(0), new Date(0))
  const replacement = trySkillLock(dir, { name })
  assert.ok(replacement)
  releaseSkillLock(old)
  assert.deepEqual(readdirSync(replacement.path), [replacement.owner])
  assert.equal(trySkillLock(dir, { name }), null)
  assert.equal(trySkillLock(dir), null)
  releaseSkillLock(replacement)
  releaseSkillLock(skill)
})
