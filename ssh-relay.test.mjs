import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

async function runRelay({ keepInputOpen }) {
  const profile = mkdtempSync(join(tmpdir(), 'weeny-ssh-relay-'))
  try {
    const api = 'http://127.0.0.1:3123'
    const preload = join(profile, 'preload.mjs')
    const loader = join(profile, 'loader.mjs')
    const websocket = join(profile, 'websocket.mjs')
    writeFileSync(join(profile, 'credentials.json'), JSON.stringify({ token: 'fixture-token', apiBase: api }))
    writeFileSync(websocket, `
import { EventEmitter } from 'node:events'
export class WebSocket extends EventEmitter {
  constructor() {
    super()
    setImmediate(() => {
      this.emit('open')
      if (!${keepInputOpen}) this.finish()
    })
  }
  send() {
    this.bufferedAmount = 2 * 1024 * 1024
    setImmediate(() => this.finish())
  }
  finish() {
    this.emit('message', Buffer.from('ssh command output\\n'))
    this.emit('close')
  }
  close() {}
}
`)
    writeFileSync(loader, `
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'ws') {
    return { url: new URL('./websocket.mjs', import.meta.url).href, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
`)
    writeFileSync(preload, `
import assert from 'node:assert/strict'
import { register } from 'node:module'
register('./loader.mjs', import.meta.url)
globalThis.fetch = async url => {
  assert.equal(url, ${JSON.stringify(api + '/api/machines')})
  return Response.json({ machines: [{ id: 'fixture', sshHostname: 'fixture.example', tunnelSecret: 'fixture' }] })
}
// Model an OS pipe that accepts a write asynchronously.
const write = process.stdout.write.bind(process.stdout)
process.stdout.write = chunk => {
  setImmediate(() => write(chunk))
  return false
}
`)
    const env = { ...process.env, WEENY_ENV: 'staging', WEENY_API: api, WEENY_CONFIG_DIR: profile }
    delete env.WEENY_TOKEN
    delete env.WEENY_SSH_KEY_FILE
    delete env.WEENY_KNOWN_HOSTS_FILE
    const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url))
    const child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, cli, '_relay', 'fixture'], {
      env, stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000,
    })
    let stdout = '', stderr = ''
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
    child.stdin.on('error', error => { stderr += error.message })
    if (keepInputOpen) child.stdin.write('outbound SSH data')
    else child.stdin.end()
    const [status, signal] = await once(child, 'close')
    assert.equal(stdout, 'ssh command output\n')
    assert.equal(signal, null, `Relay terminated by ${signal}\n${stderr}`)
    assert.equal(status, 0, stderr)
  } finally {
    rmSync(profile, { recursive: true, force: true })
  }
}

test('the SSH relay flushes queued output after the WebSocket closes', async () => {
  await runRelay({ keepInputOpen: false })
})

test('the SSH relay flushes output and exits with stdin still open under backpressure', async () => {
  await runRelay({ keepInputOpen: true })
})
