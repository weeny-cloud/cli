#!/usr/bin/env node
// weeny-cloud — the weeny.cloud laptop CLI. Its whole job: get code and people TO
// your server. (Apps are operated ON the server with the `weeny` command — ssh in.)
// Agent-friendly by design: an agent can run every step except reading your inbox.
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs'
import { execFileSync, execSync } from 'node:child_process'
import { createInterface } from 'node:readline/promises'
import { homedir } from 'node:os'
import { join, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const SELF = fileURLToPath(import.meta.url)   // absolute path to this cli.mjs (for ProxyCommand)

const API = process.env.WEENY_API || 'https://app.weeny.cloud'
const DIR = join(homedir(), '.weeny')
const CREDS = join(DIR, 'credentials.json')

const die = (msg) => { console.error(`✗ ${msg}`); process.exit(1) }

function loadCreds() {
  try { return JSON.parse(readFileSync(CREDS, 'utf8')) } catch { return null }
}

async function call(path, { method = 'GET', body, auth = true } = {}) {
  const headers = { 'Content-Type': 'application/json' }
  if (auth) {
    const creds = loadCreds()
    if (!creds?.token) die(`not signed in — run: npx weeny-cloud login`)
    headers.Authorization = `Bearer ${creds.token}`
  }
  const res = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined })
  const json = await res.json().catch(() => ({}))
  if (res.status === 401 && auth) die('session expired or revoked — run: npx weeny-cloud login')
  if (res.status === 402) {
    console.error(`\n${json.statusMessage || json.message || 'Subscription required'}`)
    const url = json.data?.checkoutUrl
    if (url) console.error(`\nSort it out here:\n\n  ${url}\n\nThen run this command again.`)
    process.exit(1)
  }
  if (!res.ok) die(json.statusMessage || json.message || `${method} ${path} → ${res.status}`)
  return json
}

const ask = async (q) => {
  if (!process.stdin.isTTY) die(`no interactive terminal — pass flags instead (see: npx weeny-cloud help)`)
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = (await rl.question(q)).trim()
  rl.close()
  return answer
}

// crude flag parse: --email x --code y
const flags = {}
for (let i = 3; i < process.argv.length; i++)
  if (process.argv[i].startsWith('--')) flags[process.argv[i].slice(2)] = process.argv[i + 1]
const positionals = process.argv.slice(3).filter((a, i, all) => !a.startsWith('--') && all[i - 1]?.startsWith('--') !== true)

// Write (upsert) a ~/.ssh/config block so `ssh`/`rsync`/`scp`/`git` reach a machine by a
// stable alias with the right key — no `-i` juggling. Two shapes by reachability:
//   direct (hetzner, public IP)  → HostName <ip>
//   tunnel (firecracker, no IP)  → ProxyCommand pipes through the VM's own tunnel (ssh-shim)
// Marker-delimited and rewritten every call, so the ProxyCommand's node/cli path can't go
// stale across npx versions. Returns the alias to target.
function ensureSshConfig(m, keyPath) {
  const tunnel = m.reachable === 'tunnel'
  const alias = tunnel ? `weeny-${m.id}` : m.ip
  const knownHosts = join(homedir(), '.weeny', 'known_hosts')
  const lines = [`Host ${alias}`, `  User root`]
  if (keyPath) lines.push(`  IdentityFile ${keyPath}`)
  lines.push(`  StrictHostKeyChecking accept-new`, `  UserKnownHostsFile ${knownHosts}`)
  if (tunnel) {
    lines.push(`  ProxyCommand ${JSON.stringify(process.execPath)} ${JSON.stringify(SELF)} _relay ${m.id}`,
      `  ServerAliveInterval 30`)
  } else {
    lines.push(`  HostName ${m.ip}`)
  }
  const begin = `# >>> weeny ${alias}`, end = `# <<< weeny ${alias}`
  const block = `${begin}\n${lines.join('\n')}\n${end}\n`

  const cfg = join(homedir(), '.ssh', 'config')
  let existing = ''
  try { existing = readFileSync(cfg, 'utf8') } catch {}
  // strip any prior weeny-managed block for this alias, then append the fresh one
  const stripped = existing.replace(new RegExp(`\\n?${begin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${end.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n?`, 'g'), '\n')
  mkdirSync(join(homedir(), '.ssh'), { recursive: true })
  mkdirSync(join(homedir(), '.weeny'), { recursive: true })
  writeFileSync(cfg, stripped.replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '') + (stripped.endsWith('\n') || !stripped ? '' : '\n') + block, { mode: 0o600 })
  return alias
}

function findPublicKey() {
  const sshDir = join(homedir(), '.ssh')
  const preferred = ['id_ed25519.pub', 'weeny_ed25519.pub', 'id_rsa.pub']
  for (const f of preferred) if (existsSync(join(sshDir, f))) return { path: join(sshDir, f), key: readFileSync(join(sshDir, f), 'utf8').trim() }
  try {
    const any = readdirSync(sshDir).find(f => f.endsWith('.pub'))
    if (any) return { path: join(sshDir, any), key: readFileSync(join(sshDir, any), 'utf8').trim() }
  } catch {}
  return null
}

// The key create() enrolled on the server — stored in creds; sensible fallbacks for
// sessions that predate storing it.
function sshKeyPath() {
  const stored = loadCreds()?.keyPath
  if (stored && existsSync(stored)) return stored
  const weeny = join(homedir(), '.ssh', 'weeny_ed25519')
  if (existsSync(weeny)) return weeny
  return null
}
// No key on this device? Login is the root of trust: generate one and register it with
// the account — the control plane pushes it to the server. A wiped laptop recovers with
// just `login` + `ssh`.
async function registerDeviceKey() {
  let keyPath = sshKeyPath()
  if (!keyPath) {
    console.log('no SSH key on this device — generating ~/.ssh/weeny_ed25519')
    mkdirSync(join(homedir(), '.ssh'), { recursive: true })
    keyPath = join(homedir(), '.ssh', 'weeny_ed25519')
    execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', 'weeny', '-f', keyPath])
  }
  const publicKey = readFileSync(`${keyPath}.pub`, 'utf8').trim()
  const { unsynced } = await call('/api/ssh-keys', { method: 'POST', body: { publicKey } })
  console.log(`→ registered this device's key with your weeny account`)
  if (unsynced?.length) console.log(`  (couldn't reach: ${unsynced.join(', ')} — it'll pick the key up when it's next running)`)
  const creds = loadCreds()
  if (creds) writeFileSync(CREDS, JSON.stringify({ ...creds, keyPath }, null, 2), { mode: 0o600 })
  return keyPath
}

// Resolve a machine to the ssh target the shell should use: writes/refreshes its config
// block and returns { host: 'root@<alias>' } — works for both direct and tunnel machines.
const sshTarget = async (m) => {
  const key = sshKeyPath() ?? await registerDeviceKey()
  const alias = ensureSshConfig(m, key)
  return { host: `root@${alias}`, key, alias }
}

async function runningMachine() {
  const { machines } = await call('/api/machines')
  const m = machines.find(x => x.status === 'running')
  if (!m) die(machines.length ? `no running server (status: ${machines[0].status}) — check: npx weeny-cloud` : 'no server yet — run: npx weeny-cloud create')
  return m
}

// Bare `weeny-cloud`: where you stand + what to type next. Replaces status/whoami.
async function orient() {
  const creds = loadCreds()
  if (!creds?.token) {
    console.log(`weeny.cloud — a teeny weeny cloud for coding agents. You're not signed in — start with login:`)
    return commandList()
  }
  const { machines } = await call('/api/machines')
  console.log(`signed in as ${creds.email}`)
  if (!machines.length) {
    console.log(`no server yet — next: npx weeny-cloud create   (~2 min, starts your free trial)`)
    return commandList()
  }
  const key = sshKeyPath()
  for (const m of machines) {
    let sshCmd = ''
    if (m.status === 'running') {
      try { ensureSshConfig(m, key) } catch {}
      // tunnel machines (firecracker) have no routable IP — the way in is the CLI
      sshCmd = m.reachable === 'tunnel' ? 'npx weeny-cloud ssh' : `ssh root@${m.ip}`
    }
    console.log(`server: ${m.status}  ${sshCmd}  ${m.error ? `(${m.error.slice(0, 60)})` : ''}`)
  }
  console.log(`next: push code up (npx weeny-cloud push ./myapp) or go look around (npx weeny-cloud ssh)`)
  commandList()
}

function commandList() {
  console.log(`
  npx weeny-cloud login            sign in — weeny emails you a code
  npx weeny-cloud create           get your server (~2 min)
  npx weeny-cloud push [folder]    send this folder to your server (re-push = update)
  npx weeny-cloud ssh [command]    go to the server — that's where the power is
  npx weeny-cloud token <host>     bearer token to call a private app from a terminal/agent
  npx weeny-cloud keys             this account's device keys (list, --revoke, --register)
  npx weeny-cloud tier             see plans / change size (humans decide this one)
  npx weeny-cloud skill            teach your coding agent all of this
  npx weeny-cloud help [command]   details + examples

on the server, apps are run with \`weeny\` — bare \`weeny\` there explains itself.`)
}

const commands = {
  async login() {
    const email = flags.email || await ask('email: ')
    if (!flags.code) {
      await call('/api/auth/code', { method: 'POST', body: { email }, auth: false })
      console.log(`→ code sent to ${email}`)
      if (!process.stdin.isTTY) {
        console.log(`agents: unless you already have access to the user's emails — stop and ask them to provide the code`)
        console.log(`then finish with: npx weeny-cloud login --email ${email} --code <6-digit-code>`)
        return
      }
    }
    const code = flags.code || await ask('code: ')
    const v = await call('/api/auth/verify', { method: 'POST', body: { email, code, client: 'cli', label: `cli@${process.env.USER || 'unknown'}` }, auth: false })
    if (v.status === 'waitlisted') {
      console.log(`\nThanks for your interest in weeny. There's too much demand for our weeny servers to spin you up right now.`)
      console.log(`You're #${v.position ?? '?'} on the waitlist — we'll email ${email} as soon as we have capacity.`)
      return
    }
    mkdirSync(DIR, { recursive: true })
    writeFileSync(CREDS, JSON.stringify({ email: v.email, token: v.token }, null, 2), { mode: 0o600 })
    console.log(`✓ signed in as ${v.email}`)
  },

  async create() {
    let pub = findPublicKey()
    if (!pub) {
      console.log('no SSH key found — generating ~/.ssh/weeny_ed25519')
      execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', 'weeny', '-f', join(homedir(), '.ssh', 'weeny_ed25519')])
      pub = findPublicKey()
    }
    console.log(`using SSH key: ${pub.path}`)
    const m = await call('/api/machines', { method: 'POST', body: { sshPublicKey: pub.key } })
    console.log(`→ setting up your server ${m.name} (takes ~2 minutes)…`)
    let notePrinted = false
    for (;;) {
      await new Promise(r => setTimeout(r, 5000))
      const { machines } = await call('/api/machines')
      const mine = machines.find(x => x.id === m.id)
      if (!mine) die('server vanished?')
      if (mine.status === 'failed') die(`setup failed: ${mine.error}`)
      if (mine.note && !notePrinted) { notePrinted = true; console.log(`\n${mine.note}\n(you can ctrl-c — we'll email you, and bare \`npx weeny-cloud\` shows progress)`) }
      if (mine.status === 'running') {
        const keyPath = pub.path.replace(/\.pub$/, '')
        ensureSshConfig(mine, keyPath)   // writes the direct or tunnel ssh-config block
        const creds = loadCreds()
        if (creds) writeFileSync(CREDS, JSON.stringify({ ...creds, keyPath }, null, 2), { mode: 0o600 })
        // Firecracker boxes have no public IP — the way in is `npx weeny-cloud ssh` (rides the
        // VM's own tunnel). Direct machines get the classic ssh line.
        const wayIn = mine.reachable === 'tunnel' ? `npx weeny-cloud ssh` : `ssh root@${mine.ip}`
        console.log(`
✓ your server is ready

  ${wayIn}

To put an app on it:
  1. build it locally, then:   npx weeny-cloud push ./myapp
  2. start it on the server:   npx weeny-cloud ssh "cd /apps/myapp && weeny start myapp -- <start-command>"
  3. put it on the internet:   npx weeny-cloud ssh "weeny expose myapp <port>"   → https://myapp-xxxx.onweeny.com

Apps are operated ON the server with \`weeny\` — bare \`weeny\` there explains itself.
Deploying with a coding agent? Run this first so it knows how:  npx weeny-cloud skill
`)
        return
      }
      process.stdout.write('.')
    }
  },

  // Ship a local directory to the server: the build-locally → push → live loop.
  async push() {
    const dir = resolve(positionals[0] ?? '.')
    const app = positionals[1] ?? basename(dir).toLowerCase()
    try { if (!statSync(dir).isDirectory()) die(`not a directory: ${dir}`) } catch { die(`no such directory: ${dir}`) }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(app) || app.length > 40) die(`app name '${app}' must be lowercase letters, digits, hyphens (max 40) — pass one: npx weeny-cloud push ${positionals[0] ?? '.'} <name>`)

    const m = await runningMachine()
    const { host } = await sshTarget(m)   // writes/refreshes the ssh-config block (direct or tunnel)

    // Ship SOURCE only. Always skip node_modules (must be built on the Linux server — Mac-built
    // native binaries won't run there) and .git. Also respect .gitignore (build outputs like
    // .next/dist, caches, .env) unless --all. We print what we skip — never silent.
    const all = 'all' in flags
    const hasGitignore = existsSync(join(dir, '.gitignore'))
    const useGitignore = !all && hasGitignore
    console.log(`→ pushing ${dir} → /apps/${app}/ on ${m.name}`)
    console.log(`  · never shipped: node_modules, .git (deps install on the server)`)
    if (useGitignore) console.log(`  · respecting .gitignore (build output, caches, .env stay local) — pass --all to override`)
    if (useGitignore && existsSync(join(dir, '.env'))) {
      try { if (/^\s*\.env/m.test(readFileSync(join(dir, '.gitignore'), 'utf8')))
        console.log(`  · note: .env is gitignored → not shipped. Set secrets with 'weeny env ${app} KEY=value' (or --all to include it).`) } catch {}
    }
    const filters = ['--exclude', '.git', '--exclude', 'node_modules', ...(useGitignore ? ['--filter', ':- .gitignore'] : [])]
    try {
      execFileSync('rsync', ['-az', ...filters, '-e', 'ssh', `${dir}/`, `${host}:/apps/${app}/`], { stdio: 'inherit' })
    } catch {
      // no rsync — tar over ssh (host is a single bare alias token, safe to interpolate)
      const tarExcl = `--exclude .git --exclude node_modules${useGitignore ? ` --exclude-from=${JSON.stringify(join(dir, '.gitignore'))}` : ''}`
      execSync(`tar -C ${JSON.stringify(dir)} ${tarExcl} -czf - . | ssh ${host} 'mkdir -p /apps/${app} && tar -xzf - -C /apps/${app}'`, { stdio: 'inherit' })
    }
    console.log(`✓ pushed`)

    if (!('no-restart' in flags)) {
      // The box installs deps + rebuilds (if the app has a build step) + restarts, and reports
      // honestly — a restart alone doesn't rebuild a framework app.
      try { execFileSync('ssh', [host, `weeny _sync ${app}`], { stdio: 'inherit' }) }
      catch (e) { process.exit(e.status ?? 1) }
    }
  },

  // Run a command on the server (or open a shell). Works for tunnel + direct machines alike.
  async ssh() {
    const m = await runningMachine()
    const { host } = await sshTarget(m)
    const rest = process.argv.slice(3)
    try { execFileSync('ssh', [...(rest.length ? [] : ['-t']), host, ...rest], { stdio: 'inherit' }) }
    catch (e) { process.exit(e.status ?? 1) }
  },

  // Hidden: ssh ProxyCommand. Bridges ssh's stdio ↔ the VM's ssh-shim over a WebSocket that
  // rides the VM's own cloudflared tunnel. Bytes never touch the control plane.
  async _relay() {
    const id = positionals[0]
    let WebSocket
    try { ({ WebSocket } = await import('ws')) } catch { process.stderr.write('weeny: the ws module is missing — reinstall weeny-cloud\n'); process.exit(1) }
    const { machines } = await call('/api/machines')
    const m = machines.find(x => x.id === id)
    if (!m?.sshHostname || !m?.tunnelSecret) { process.stderr.write(`weeny: no tunnel for machine ${id}\n`); process.exit(1) }
    const ws = new WebSocket(`wss://${m.sshHostname}`, { headers: { Authorization: m.tunnelSecret } })
    ws.binaryType = 'nodebuffer'
    const bail = (msg, code = 1) => { if (msg) process.stderr.write(`weeny: ${msg}\n`); try { ws.terminate() } catch {}; process.exit(code) }
    ws.on('unexpected-response', (_r, res) => bail(res.statusCode === 401 ? 'tunnel auth rejected' : `tunnel HTTP ${res.statusCode} (re-establishing? retry in ~15s)`))
    ws.on('error', (e) => bail(e.message))
    ws.on('open', () => {
      process.stdin.on('data', (chunk) => {
        ws.send(chunk, { binary: true })
        if (ws.bufferedAmount > (1 << 20)) { process.stdin.pause(); const t = setInterval(() => { if (ws.bufferedAmount <= (1 << 18)) { clearInterval(t); process.stdin.resume() } }, 20) }
      })
      process.stdin.on('end', () => { try { ws.close() } catch {} })
    })
    ws.on('message', (data) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
      if (!process.stdout.write(buf)) { ws._socket?.pause?.(); process.stdout.once('drain', () => ws._socket?.resume?.()) }
    })
    ws.on('close', () => process.exit(0))
  },

  // Device keys: list, register this device, revoke another. Backed by the account —
  // any signed-in device can manage them.
  async keys() {
    if (flags.revoke) {
      const { keys, unsynced } = await call(`/api/ssh-keys/${flags.revoke}`, { method: 'DELETE' })
      console.log(`✓ revoked — removed from your server${unsynced?.length ? ` (couldn't reach: ${unsynced.join(', ')})` : ''}`)
      for (const k of keys) console.log(`  ${k.id}  ${k.label ?? ''}  ${k.preview}  (${k.createdAt})`)
      return
    }
    if ('register' in flags) return registerDeviceKey()
    const { keys } = await call('/api/ssh-keys')
    if (!keys.length) return console.log('no keys registered — `npx weeny-cloud ssh` sets one up')
    for (const k of keys) console.log(`${k.id}  ${k.label ?? ''}  ${k.preview}  (${k.createdAt})`)
    console.log(`\nrevoke one: npx weeny-cloud keys --revoke <id>`)
  },

  // Plans. Bare = show them. With a tier name = change it — which changes what the human
  // pays, so it's interactive-confirm only: agents get told to hand this to their human.
  async tier() {
    const bs = await call('/api/billing/status')
    const want = positionals[0]
    const price = (t) => bs.founding ? `$${t.foundingUsd}/mo (founding — normally $${t.listUsd})` : `$${t.listUsd}/mo`
    if (!want) {
      console.log(`your plan: ${bs.tier}${bs.machineTier && bs.machineTier !== bs.tier ? ` (server still ${bs.machineTier} — resize in progress)` : ''}\n`)
      for (const t of bs.tiers)
        console.log(`  ${t.name === bs.tier ? '●' : '○'} ${t.name.padEnd(6)} ${String(t.vcpu)} vcpu · ${t.memGb}gb — ${price(t)}\n           ${t.blurb}`)
      console.log(`\nchange: npx weeny-cloud tier <name>   (changing plan changes what you pay)`)
      return
    }
    const target = bs.tiers.find(t => t.name === want)
    if (!target) die(`no '${want}' plan — the plans: ${bs.tiers.map(t => t.name).join(', ')}`)
    if (want === bs.tier) return console.log(`you're already on ${want}`)
    if (!process.stdin.isTTY)
      die(`changing plan changes what your human pays — this one's theirs. Ask them to run:\n  npx weeny-cloud tier ${want}\nor upgrade in the browser: app.weeny.cloud/dashboard/billing`)
    console.log(`${bs.tier} → ${want}: ${target.vcpu} vcpu · ${target.memGb}gb at ${price(target)}, prorated from today.`)
    console.log(`your server reboots into its new size (~a minute; apps come back automatically).`)
    const yn = await ask('sound good? (yes/no): ')
    if (!/^y(es)?$/i.test(yn)) return console.log('no worries — nothing changed')
    const r = await call('/api/billing/tier', { method: 'POST', body: { tier: want } })
    if (r.checkoutUrl) return console.log(`\nfinish up here (takes a card):\n\n  ${r.checkoutUrl}\n\nyour server resizes as soon as payment lands.`)
    console.log(`✓ you're on ${want}${r.resizing ? ' — server resizing now (back in ~a minute)' : ''}`)
  },

  // A 12h bearer for a private app you're allowed to view — how agents get in.
  async token() {
    const arg = positionals[0] ?? die('usage: npx weeny-cloud token <app-url-or-host>')
    const host = arg.replace(/^https?:\/\//, '').split('/')[0].toLowerCase()
    const r = await call(`/api/apps/token?host=${encodeURIComponent(host)}`)
    if (!r.token) return console.log(r.message)
    console.log(r.token)   // stdout is just the token, so $(npx weeny-cloud token …) composes
    console.error(`\n# acts as ${r.email} until ${r.expiresAt} — use it like:`)
    console.error(`#   curl -H "Authorization: Bearer ${r.token}" https://${r.host}/`)
  },

  async skill() {
    const dir = join(homedir(), '.claude', 'skills', 'weeny')
    mkdirSync(dir, { recursive: true })
    const res = await fetch('https://app.weeny.cloud/weeny-skill.md')
    if (!res.ok) die('could not fetch the skill')
    writeFileSync(join(dir, 'SKILL.md'), await res.text())
    console.log(`✓ installed the weeny skill → ${dir}/SKILL.md
Your Claude Code now knows how to deploy to weeny. Try: "deploy this app to weeny".`)
  },

  async help() {
    const topic = positionals[0]
    if (topic && HELP[topic]) return console.log(HELP[topic])
    if (topic) console.log(`no help for '${topic}' — the commands:`)
    await orient().catch(() => commandList())
  },
}

const HELP = {
  login: `npx weeny-cloud login [--email x@y.com] [--code 123456]

Sign in (or claim a waitlist spot) with your email — weeny sends a 6-digit code.
Non-interactive (for agents): pass --email first, then re-run with --email + --code.
The code lands in the human's inbox — unless you already have access to their emails,
stop and ask them to provide the code.
Signed out? Delete ~/.weeny/credentials.json.`,
  create: `npx weeny-cloud create

Provision your server (~2 min): a real Linux box — root, SSH, systemd. Uses your SSH
key (generates ~/.ssh/weeny_ed25519 if you have none) and starts the 7-day free trial.
One server per account for now. Delete/suspend/rebuild live in the dashboard.`,
  push: `npx weeny-cloud push [folder] [app-name] [--no-restart]

Send a local folder to /apps/<app-name> on your server (name defaults to the folder's).
Skips .git and node_modules — run npm install on the server. Re-push after every local
edit: it restarts the app so changes go live.`,
  ssh: `npx weeny-cloud ssh [command]

Open a shell on your server — or run one command and return. Uses the right key and IP
so it always works. Your apps live in /apps, their data in /data/apps.
No SSH key on this device (new laptop, wiped machine)? No problem — as long as you're
signed in, ssh generates and registers a fresh device key automatically.`,
  token: `npx weeny-cloud token <app-url-or-host>

A private app someone shared with you (weeny expose --private + weeny allow)? This
prints a 12-hour bearer token so you (or your agent) can call it from a terminal:
curl -H "Authorization: Bearer <token>" https://<host>/. The app sees your email in
the X-Weeny-User header. Not allowed? Ask the owner: weeny allow <app> <your-email>.
Any weeny app explains how to connect at GET /__weeny.`,
  keys: `npx weeny-cloud keys [--revoke <id>] [--register]

Your account's device SSH keys (each signed-in laptop/agent registers its own).
Bare = list. --revoke <id> removes a key from your account and your server.
--register enrols this device's key now (ssh does this automatically when needed).`,
  skill: `npx weeny-cloud skill

Install the weeny skill into ~/.claude/skills so Claude Code knows the whole flow:
push code, start apps, expose URLs, env vars, domains, private links.`,
  tier: `npx weeny-cloud tier [teeny|weeny|meany]

The plans. Bare = see them (specs, prices, which one you're on). With a name = change
plan: prorated from today, and your server reboots into its new size in about a minute.
Agents: changing plan changes what your human pays — that decision is theirs. If the
server is tight on memory (\`weeny health\` on the box), tell them and point them here.`,
}

const cmd = process.argv[2]
const SERVER_WORDS = new Set(['start', 'expose', 'unexpose', 'remove', 'env', 'domain', 'allow', 'revoke', 'health'])
const OLD_TO_NEW = { run: 'start', rm: 'remove', list: '', ls: '', access: 'allow', guide: 'help' }
const LINUX_HINT = { logs: 'journalctl -u weeny-APP -f', stop: 'systemctl stop weeny-APP', restart: 'systemctl restart weeny-APP' }
const ALIASES = { status: 'help', whoami: 'help' } // old names → orientation

if (!cmd) await orient()
else if (cmd === '--help' || cmd === '-h') await commands.help()
else if (commands[ALIASES[cmd] ?? cmd]) await commands[ALIASES[cmd] ?? cmd]()
else if (SERVER_WORDS.has(cmd) || cmd in OLD_TO_NEW || cmd in LINUX_HINT) {
  const app = process.argv[3] && !process.argv[3].startsWith('-') ? process.argv[3] : '<app>'
  if (cmd in LINUX_HINT) {
    console.error(`${cmd} is bare Linux on your server — apps are systemd units named weeny-<app>:\n`)
    console.error(`  npx weeny-cloud ssh "${LINUX_HINT[cmd].replace('APP', app)}"\n`)
  } else {
    const word = cmd in OLD_TO_NEW ? OLD_TO_NEW[cmd] : cmd
    const line = ['weeny', word, ...process.argv.slice(3)].filter(Boolean).join(' ')
    console.error(`\`${['weeny', word].filter(Boolean).join(' ')}\` runs ON YOUR SERVER, not on your laptop. Go there:\n`)
    console.error(`  npx weeny-cloud ssh "${line}"\n`)
    console.error(`(bare \`weeny\` on the server explains all its commands)`)
  }
  process.exit(1)
}
else { console.error(`unknown command: ${cmd}\n`); commandList(); process.exit(1) }
