import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { siteFiles } from './site.mjs'

const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url))

test('site deploy uploads a finished directory over the account API without selecting a server', () => {
  const root = mkdtempSync(join(tmpdir(), 'weeny-static-cli-'))
  try {
    const profile = join(root, 'profile'), site = join(root, 'build output'), preload = join(root, 'fixture.mjs')
    const api = 'http://127.0.0.1:3123'
    mkdirSync(profile)
    mkdirSync(join(site, 'assets'), { recursive: true })
    writeFileSync(join(site, 'index.html'), '<h1>notes</h1>')
    writeFileSync(join(site, 'assets', 'badge.png'), Buffer.from([0x00, 0xff]))
    writeFileSync(join(site, '.env'), 'PRIVATE=never-upload')
    writeFileSync(join(profile, 'credentials.json'), JSON.stringify({ token: 'test-token', apiBase: api }))
    writeFileSync(preload, `import assert from 'node:assert/strict'
      globalThis.fetch = async (url, options) => {
        assert.equal(url, '${api}/api/sites/notes/deploy')
        assert.equal(options.method, 'POST')
        assert.equal(options.headers.Authorization, 'Bearer test-token')
        const files = JSON.parse(options.body).files
        assert.equal(files.length, 2)
        assert.equal(files.find(file => file.path === 'index.html').data, 'PGgxPm5vdGVzPC9oMT4=')
        assert.equal(files.find(file => file.path === 'assets/badge.png').data, 'AP8=')
        return Response.json({ name:'notes', url:'https://notes-test.onweeny.com', releaseId:'one', publishing:false })
      }`)
    const env = { ...process.env, CI: '1', WEENY_ENV: 'staging', WEENY_API: api, WEENY_CONFIG_DIR: profile }
    delete env.WEENY_TOKEN; delete env.WEENY_SSH_KEY_FILE; delete env.WEENY_KNOWN_HOSTS_FILE
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, cli, 'site', 'deploy', 'notes', '--dir', site, '--json'],
      { env, encoding: 'utf8', timeout: 10_000 })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout).url, 'https://notes-test.onweeny.com')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a publish folder cannot silently follow a symlink into local files', () => {
  const root = mkdtempSync(join(tmpdir(), 'weeny-static-cli-link-'))
  try {
    const site = join(root, 'site'), secret = join(root, 'secret')
    mkdirSync(site)
    writeFileSync(secret, 'not part of the publish folder')
    symlinkSync(secret, join(site, 'asset.txt'))
    assert.throws(() => siteFiles(site), /only contain regular files and directories/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
