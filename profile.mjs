import { mkdirSync, writeFileSync, openSync, closeSync, unlinkSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

export function profileAccessError(error, path) {
  if (!['EACCES', 'EPERM', 'EROFS', 'ENOTDIR', 'EEXIST'].includes(error.code)) return error
  return Object.assign(new Error(`Cannot access Weeny configuration at "${path}" (${error.code}).\n` +
    'Choose a private folder you can write to, set WEENY_CONFIG_DIR to that folder, and retry.\n' +
    'See: npx weeny-cloud help login', { cause: error }), { code: 'WEENY_PROFILE_ACCESS' })
}

export function profileDirectory(path) {
  try { mkdirSync(path, { recursive: true, mode: 0o700 }) }
  catch (error) { throw profileAccessError(error, path) }
}

export function writeProfile(path, text) {
  try { writeFileSync(path, text, { mode: 0o600 }) }
  catch (error) { throw profileAccessError(error, path) }
}

// Check before consuming a one-time login code, including an existing read-only folder.
export function checkProfileWritable(dir) {
  profileDirectory(dir)
  const probe = join(dir, `.write-check-${randomUUID()}`)
  let fd
  try { fd = openSync(probe, 'wx', 0o600) }
  catch (error) { throw profileAccessError(error, dir) }
  finally { if (fd !== undefined) { closeSync(fd); unlinkSync(probe) } }
  // Opening with r+ checks the existing file's ACL/read-only flag without truncation.
  const credentials = join(dir, 'credentials.json')
  try { fd = openSync(credentials, 'r+') }
  catch (error) { if (error.code !== 'ENOENT') throw profileAccessError(error, credentials); return }
  closeSync(fd)
}
