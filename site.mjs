import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'

const MAX_FILE_BYTES = 10 * 1024 ** 2
const MAX_SITE_BYTES = 50 * 1024 ** 2
const MAX_FILES = 2000
const changed = () => new Error('The publish directory changed during upload. Finish the build and retry.')
const sameEntry = (expected, found) => expected.dev === found.dev && expected.ino === found.ino

function checkDirectory(path, expected) {
  const current = lstatSync(path)
  if (!current.isDirectory() || !sameEntry(expected, current) || current.mtimeMs !== expected.mtimeMs ||
      current.ctimeMs !== expected.ctimeMs || realpathSync(path) !== path) throw changed()
}

function readSiteFile(path, expected) {
  if (realpathSync(path) !== path) throw changed()
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const initial = fstatSync(fd)
    if (!initial.isFile() || !sameEntry(expected, initial) || initial.size !== expected.size) throw changed()
    const data = Buffer.alloc(initial.size)
    let offset = 0
    while (offset < data.length) {
      const bytes = readSync(fd, data, offset, data.length - offset, offset)
      if (!bytes) throw changed()
      offset += bytes
    }
    const final = fstatSync(fd)
    if (final.size !== initial.size || final.mtimeMs !== initial.mtimeMs || final.ctimeMs !== initial.ctimeMs) throw changed()
    return data
  } finally { closeSync(fd) }
}

export function siteFiles(directory) {
  const source = resolve(directory)
  const original = lstatSync(source)
  if (!original.isDirectory()) throw new Error('--dir must point at a publish directory')
  const root = realpathSync(source)
  const files = []
  let total = 0
  function walk(folder, expected, prefix = '') {
    checkDirectory(folder, expected)
    for (const name of readdirSync(folder)) {
      if (name === 'node_modules' || name.startsWith('.') && name !== '.well-known') continue
      const path = prefix + name
      const local = join(folder, name)
      const entry = lstatSync(local)
      if (entry.isDirectory()) walk(local, entry, `${path}/`)
      else if (entry.isFile()) {
        if (entry.size > MAX_FILE_BYTES || total + entry.size > MAX_SITE_BYTES || files.length >= MAX_FILES)
          throw new Error('A release can contain up to 2000 files, 50 MiB total and 10 MiB per file')
        const body = readSiteFile(local, entry)
        total += body.length
        files.push({ path, data: body.toString('base64') })
      } else throw new Error(`Publish directories may only contain regular files and directories: ${path}`)
    }
    checkDirectory(folder, expected)
  }
  walk(root, original)
  if (!files.length) throw new Error('No files to publish. Point --dir at the finished site output.')
  return files
}
