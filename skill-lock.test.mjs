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

for (const name of ['skill-update.lock', 'resource-notices-fixture.json.lock']) test(`two processes recovering the same abandoned ${name} leave exactly one owner`, { timeout: 15000 }, async t => {
  const dir = fixture(t), path = abandoned(dir, name), barrier = join(dir, 'recover'), worker = join(dir, 'contender.mjs')
  writeFileSync(worker, `import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
const original = fs.unlinkSync;
fs.unlinkSync = (path, ...args) => {
  if(path === ${JSON.stringify(join(path, staleOwner))}) {
    process.send({type:'observed'});
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
  function launch() {
    const child = spawn(process.execPath, [worker], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
    t.after(() => child.kill())
    let observed, result, stderr = ''
    const sawOldOwner = new Promise(resolve => { observed = resolve })
    const outcome = new Promise(resolve => { result = resolve })
    child.stderr.on('data', data => { stderr += data })
    child.on('message', message => {
      if (message.type === 'observed') observed()
      if (message.type === 'result') result(message.owner)
    })
    const exited = new Promise(resolve => child.on('exit', code => resolve({ code, stderr })))
    return { child, sawOldOwner, outcome, exited }
  }
  const a = launch(), b = launch()
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
