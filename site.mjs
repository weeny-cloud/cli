import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const MAX_FILE_BYTES = 10 * 1024 ** 2
const MAX_SITE_BYTES = 50 * 1024 ** 2
const MAX_FILES = 2000

export function siteFiles(directory) {
  const root = resolve(directory)
  if (!lstatSync(root).isDirectory()) throw new Error('--dir must point at a publish directory')
  const files = []
  let total = 0
  function walk(folder, prefix = '') {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.') && entry.name !== '.well-known') continue
      const path = prefix + entry.name
      const local = join(folder, entry.name)
      if (entry.isDirectory()) walk(local, `${path}/`)
      else if (entry.isFile()) {
        const size = lstatSync(local).size
        if (size > MAX_FILE_BYTES || total + size > MAX_SITE_BYTES || files.length >= MAX_FILES)
          throw new Error('A release can contain up to 2000 files, 50 MiB total and 10 MiB per file')
        const body = readFileSync(local)
        total += body.length
        if (body.length > MAX_FILE_BYTES || total > MAX_SITE_BYTES) throw new Error('The publish directory changed during upload. Check its size and retry.')
        files.push({ path, data: body.toString('base64') })
      } else throw new Error(`Publish directories may only contain regular files and directories: ${path}`)
    }
  }
  walk(root)
  if (!files.length) throw new Error('No files to publish. Point --dir at the finished site output.')
  return files
}
