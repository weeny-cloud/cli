import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as http } from 'node:http'
import { createServer as https } from 'node:https'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'

const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url))
const pemPath = fileURLToPath(new URL('./test-fixtures/local-proxy.pem', import.meta.url))

test('CLI uses the configured proxy for Weeny API requests and SSH relay bytes', async t => {
  const profile = mkdtempSync(join(tmpdir(), 'weeny-proxy-network-'))
  t.after(() => rmSync(profile, { recursive: true, force: true }))
  const sockets = new Set()
  function track(socket) {
    sockets.add(socket)
    socket.on('error', () => socket.destroy())
    socket.on('close', () => sockets.delete(socket))
    return socket
  }
  t.after(() => { for (const socket of sockets) socket.destroy() })
  async function listen(server) {
    server.on('connection', track)
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    t.after(() => server.close())
    return server.address().port
  }

  // This public test certificate and key are only used on loopback.
  const pem = readFileSync(pemPath)
  const tls = { key: pem, cert: pem }
  const relay = https(tls)
  const relayPort = await listen(relay)
  const wss = new WebSocketServer({ server: relay })
  wss.on('connection', (ws, req) => {
    assert.equal(req.headers.authorization, 'fixture-relay-token')
    assert.equal(req.headers['proxy-authorization'], undefined)
    ws.on('message', (data, isBinary) => {
      ws.send(data, { binary: isBinary })
      ws.close()
    })
  })

  const apiPort = await listen(https(tls, (req, res) => {
    assert.equal(req.url, '/api/machines')
    assert.equal(req.headers.authorization, 'Bearer fixture-api-token')
    assert.equal(req.headers['proxy-authorization'], undefined)
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ machines: [{
      id: 'fixture', sshHostname: 'localhost:' + relayPort, tunnelSecret: 'fixture-relay-token',
    }] }))
  }))
  const api = 'https://staging.proxy.test:' + apiPort
  writeFileSync(join(profile, 'credentials.json'), JSON.stringify({ token: 'fixture-api-token', apiBase: api }))

  const apiTarget = 'staging.proxy.test:' + apiPort
  const relayTarget = 'localhost:' + relayPort
  const targets = new Map([[apiTarget, apiPort], [relayTarget, relayPort]])
  const requests = []
  const expectedAuth = 'Basic ' + Buffer.from('fixture-user:fixture-password').toString('base64')
  let rejectTarget
  function proxyConnect(req, local, head) {
    assert.equal(req.headers.authorization, undefined)
    assert.equal(req.headers['proxy-authorization'], expectedAuth)
    requests.push(req.url)
    if (req.url === rejectTarget || !targets.has(req.url)) {
      local.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=fixture\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
      return
    }
    const upstream = track(connect(targets.get(req.url), '127.0.0.1'))
    upstream.on('connect', () => {
      local.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) upstream.write(head)
      local.pipe(upstream).pipe(local)
    })
    local.on('close', () => upstream.destroy())
    upstream.on('close', () => local.destroy())
  }
  const proxyPort = await listen(http().on('connect', proxyConnect))
  const tlsProxyPort = await listen(https(tls).on('connect', proxyConnect))
  const proxyUrl = 'http://fixture-user:fixture-password@127.0.0.1:' + proxyPort
  async function run(proxyEnv) {
    requests.length = 0
    const child = spawn(process.execPath, [cli, '_relay', 'fixture'], {
      env: {
        PATH: process.env.PATH, CI: '1', WEENY_ENV: 'staging', WEENY_API: api, WEENY_CONFIG_DIR: profile,
        NODE_EXTRA_CA_CERTS: pemPath, NODE_USE_ENV_PROXY: '0', NODE_OPTIONS: '--dns-result-order=ipv4first', ...proxyEnv,
      },
      stdio: 'pipe',
      timeout: 8000,
    })
    let stdout = '', stderr = ''
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
    child.stdin.on('error', () => {}) // A proxy rejection can exit before stdin is consumed.
    child.stdin.write('SSH fixture bytes')
    const [status, signal] = await once(child, 'close')
    assert.equal(signal, null, stderr)
    assert.doesNotMatch(stderr, /fixture-user|fixture-password|fixture-api-token|fixture-relay-token/)
    return { status, stdout, stderr }
  }

  const connected = await run({ HTTPS_PROXY: proxyUrl })
  assert.equal(connected.status, 0, connected.stderr)
  assert.equal(connected.stdout, 'SSH fixture bytes')
  assert.deepEqual(requests, [apiTarget, relayTarget])

  const secureProxy = await run({ HTTPS_PROXY: 'https://fixture-user:fixture-password@localhost:' + tlsProxyPort })
  assert.equal(secureProxy.status, 0, secureProxy.stderr)
  assert.equal(secureProxy.stdout, 'SSH fixture bytes')
  assert.deepEqual(requests, [apiTarget, relayTarget])

  const excluded = await run({ https_proxy: proxyUrl, no_proxy: relayTarget })
  assert.equal(excluded.status, 0, excluded.stderr)
  assert.equal(excluded.stdout, 'SSH fixture bytes')
  assert.deepEqual(requests, [apiTarget])

  rejectTarget = relayTarget
  const relayRejected = await run({ HTTPS_PROXY: proxyUrl })
  assert.equal(relayRejected.status, 1, relayRejected.stderr)
  assert.equal(relayRejected.stdout, '')
  assert.match(relayRejected.stderr, /SSH proxy requires authentication \(HTTP 407\)/)
  assert.deepEqual(requests, [apiTarget, relayTarget])

  rejectTarget = apiTarget
  const apiRejected = await run({ HTTPS_PROXY: proxyUrl })
  assert.equal(apiRejected.status, 1, apiRejected.stderr)
  assert.match(apiRejected.stderr, /Could not reach staging\.proxy\.test through the configured proxy/)
  assert.deepEqual(requests, [apiTarget])
})
