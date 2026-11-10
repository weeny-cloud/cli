import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync, renameSync, readdirSync, readFileSync, statSync, unlinkSync, rmdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const OWNER = /^owner-[a-f0-9-]{36}\.json$/

function processAlive(pid) {
  try { process.kill(pid, 0); return true }
  catch (error) { return error.code !== 'ESRCH' }
}

// Publish an already populated directory atomically. A replacement lock is never
// empty, so cleanup of an older owner cannot remove it with rmdir.
export function trySkillLock(dir, { now = Date.now(), name = 'skill-update.lock' } = {}) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, name), token = randomUUID()
  const candidate = `${path}.${token}.tmp`, owner = `owner-${token}.json`
  let published = false
  try {
    mkdirSync(candidate, { mode: 0o700 })
    writeFileSync(join(candidate, owner), JSON.stringify({ pid: process.pid }), { mode: 0o600 })
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        renameSync(candidate, path)
        published = true
        return { path, owner }
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code)) throw error
      }
      let previous, metadata, modifiedAt
      try {
        const entries = readdirSync(path)
        if (entries.length !== 1 || !OWNER.test(entries[0])) return null
        previous = join(path, entries[0])
        modifiedAt = statSync(previous).mtimeMs
        try { metadata = JSON.parse(readFileSync(previous, 'utf8')) } catch (error) {
          if (error.code === 'ENOENT') continue
          if (!(error instanceof SyntaxError)) throw error
        }
      } catch (error) {
        if (error.code === 'ENOENT') continue // Released between collision and inspection.
        throw error
      }
      const pid = metadata?.pid
      if (Number.isSafeInteger(pid) && pid > 0) {
        if (processAlive(pid)) return null // Never evict a live owner based on age.
      } else if (now - modifiedAt < 60000) return null
      try { unlinkSync(previous) }
      catch (error) {
        if (error.code === 'ENOENT') continue
        // Windows can report a concurrent deletion as EPERM while the old file
        // is delete-pending. Yield without claiming ownership or touching a replacement.
        if (process.platform === 'win32' && error.code === 'EPERM') return null
        throw error
      }
      try { rmdirSync(path) }
      catch (error) {
        // Another contender may already have published its populated replacement.
        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error
      }
    }
    return null
  } finally { if (!published) rmSync(candidate, { recursive: true, force: true }) }
}

export function releaseSkillLock(lock) {
  if (!lock) return
  try { unlinkSync(join(lock.path, lock.owner)) }
  catch { return } // No longer our lock; never touch a replacement owner's record.
  try { rmdirSync(lock.path) } catch {} // A populated replacement is protected.
}
