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
import { feedbackHelp, runFeedback } from './feedback.mjs'
import { cliEnvironment, credentialsForOrigin, credentialsFromEnv } from './environment.mjs'

const SELF = fileURLToPath(import.meta.url)   // absolute path to this cli.mjs (for ProxyCommand)

const ENV = cliEnvironment()
const CI_CREDS = credentialsFromEnv(process.env, ENV)
const API = ENV.api
const DIR = ENV.dir
const SSH_DIR = ENV.sshDir
// CI never inherits earlier Host/Match/Include rules from a user profile.
const SSH_CONFIG = join(SSH_DIR, CI_CREDS ? 'ci-config' : 'config')
const SSH_FLAGS = ENV.production && !process.env.WEENY_CONFIG_DIR && !CI_CREDS ? [] : ['-F', SSH_CONFIG]
const shellQuote = v => `'${String(v).replace(/'/g, `'\\''`)}'`
const SSH_COMMAND = ['ssh', ...SSH_FLAGS].map(shellQuote).join(' ')
const CREDS = join(DIR, 'credentials.json')
if (!ENV.production) console.error(`STAGING: ${API} — isolated account and SSH profile`)

const die = (msg) => { console.error(`✗ ${msg}`); process.exit(1) }

function loadCreds() {
  if (CI_CREDS) return CI_CREDS
  let creds
  try { creds = JSON.parse(readFileSync(CREDS, 'utf8')) } catch { return null }
  return credentialsForOrigin(creds, ENV)
}

async function call(path, { method = 'GET', body, auth = true } = {}) {
  const headers = { 'Content-Type': 'application/json' }
  if (auth) {
    const creds = loadCreds()
    if (!creds?.token) die(`not signed in — run: npx weeny-cloud login`)
    headers.Authorization = `Bearer ${creds.token}`
  }
  const res = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined,
    ...(ENV.production ? {} : { redirect: 'error' }) })
  const json = await res.json().catch(() => ({}))
  if (res.status === 401 && auth) die('session expired or revoked — run: npx weeny-cloud login')
  if (res.status === 402) {
    console.error(`\n${json.statusMessage || json.message || 'Subscription required'}`)
    const url = json.data?.checkoutUrl
    if (url) console.error(`\nSort it out here:\n\n  ${url}\n\nThen run this command again.`)
    process.exit(1)
  }
  if (!res.ok) {
    if (method === 'POST' && path === '/api/machines' && (json.data?.offers || json.data?.code === 'waitlisted'))
      serverChoices({ ...json.data, status: 'waitlisted' }, json.data?.position)
    die(json.statusMessage || json.message || `${method} ${path} → ${res.status}`)
  }
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
function sshConfigPath(path) {
  if (/[\r\n\0]/.test(path)) throw new Error('SSH credential paths cannot contain line breaks or NUL')
  return '"' + path.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"'
}

function ensureSshConfig(m, keyPath) {
  const tunnel = m.reachable === 'tunnel'
  const alias = !ENV.production ? `weeny-staging-${m.id}` : tunnel ? `weeny-${m.id}` : m.ip
  const knownHosts = CI_CREDS?.knownHosts || join(DIR, 'known_hosts')
  const lines = [`Host ${alias}`, `  User root`]
  if (!ENV.production) lines.push(`  HostKeyAlias ${alias}`) // disposable VMs may reuse an IP; pin trust to machine identity
  if (keyPath) lines.push(`  IdentityFile ${sshConfigPath(keyPath)}`)
  lines.push(`  IdentitiesOnly yes`, `  StrictHostKeyChecking ${CI_CREDS ? 'yes' : 'accept-new'}`, `  UserKnownHostsFile ${sshConfigPath(knownHosts)}`)
  if (CI_CREDS) lines.push('  GlobalKnownHostsFile /dev/null', '  BatchMode yes')
  if (tunnel) {
    const relay = [process.execPath, SELF, '_relay', m.id]
    if (!ENV.production) relay.unshift('env', 'WEENY_ENV=staging', `WEENY_API=${API}`, `WEENY_CONFIG_DIR=${DIR}`)
    lines.push(`  ProxyCommand ${relay.map(shellQuote).join(' ')}`,
      `  ServerAliveInterval 30`)
  } else {
    lines.push(`  HostName ${m.ip}`)
  }
  const begin = `# >>> weeny ${alias}`, end = `# <<< weeny ${alias}`
  const block = `${begin}\n${lines.join('\n')}\n${end}\n`

  const cfg = SSH_CONFIG
  let existing = ''
  if (!CI_CREDS) try { existing = readFileSync(cfg, 'utf8') } catch {}
  // strip any prior weeny-managed block for this alias, then append the fresh one
  const stripped = existing.replace(new RegExp(`\\n?${begin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${end.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n?`, 'g'), '\n')
  mkdirSync(SSH_DIR, { recursive: true, mode: 0o700 })
  mkdirSync(DIR, { recursive: true, mode: 0o700 })
  writeFileSync(cfg, stripped.replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '') + (stripped.endsWith('\n') || !stripped ? '' : '\n') + block, { mode: 0o600 })
  return alias
}

function findPublicKey() {
  const sshDir = SSH_DIR
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
  if (CI_CREDS) {
    if (!existsSync(CI_CREDS.keyPath) || !existsSync(CI_CREDS.knownHosts)) die('CI SSH key or pinned known-hosts file is missing')
    return CI_CREDS.keyPath
  }
  const stored = loadCreds()?.keyPath
  if (stored && existsSync(stored) && (ENV.production || resolve(stored).startsWith(SSH_DIR + '/'))) return stored
  const weeny = join(SSH_DIR, 'weeny_ed25519')
  if (existsSync(weeny)) return weeny
  return null
}
// No key on this device? Login is the root of trust: generate one and register it with
// the account — the control plane pushes it to the server. A wiped laptop recovers with
// just `login` + `ssh`.
async function registerDeviceKey(explicitKey) {
  if (CI_CREDS) die('CI credentials cannot enroll devices; pre-enroll the deployment key from a signed-in local session')
  let keyPath = explicitKey ? resolve(explicitKey) : sshKeyPath()
  if (!keyPath) {
    console.log(`no SSH key on this device — generating ${join(SSH_DIR, 'weeny_ed25519')}`)
    mkdirSync(SSH_DIR, { recursive: true, mode: 0o700 })
    keyPath = join(SSH_DIR, 'weeny_ed25519')
    execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', 'weeny', '-f', keyPath])
  }
  const publicKey = readFileSync(`${keyPath}.pub`, 'utf8').trim()
  const { unsynced } = await call('/api/ssh-keys', { method: 'POST', body: { publicKey } })
  console.log(`→ registered this device's key with your weeny account`)
  if (unsynced?.length) console.log(`  (couldn't reach: ${unsynced.join(', ')} — it'll pick the key up when it's next running)`)
  const creds = loadCreds()
  if (creds && !explicitKey) writeFileSync(CREDS, JSON.stringify({ ...creds, keyPath }, null, 2), { mode: 0o600 })
  return keyPath
}

// Optional provenance for a push: what commit is being deployed. Never a dependency —
// no repo, detached head, missing git all yield null; a dirty tree deploys and says so.
function collectGitMetaLocal(dir) {
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
  try {
    return {
      sha: git('rev-parse', '--short', 'HEAD'),
      subject: git('log', '-1', '--format=%s'),
      branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
      dirty: git('status', '--porcelain').length > 0,
    }
  } catch { return null }
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
  if (m) return m
  const waking = machines.find(x => ['sleeping', 'resuming'].includes(x.status))
  if (!waking) die(machines.length ? `no running server (status: ${machines[0].status}) — check: npx weeny-cloud` : 'no server yet — run: npx weeny-cloud create')
  console.error('→ waking your server…')
  if (waking.status === 'sleeping') await call(`/api/machines/${waking.id}/resume`, { method: 'POST' })
  for (let attempt = 0; attempt < 60; attempt++) {
    await new Promise(r => setTimeout(r, 5000))
    const { machines } = await call('/api/machines')
    const current = machines.find(x => x.id === waking.id)
    if (current?.status === 'running') return current
    if (!current || !['sleeping', 'resuming'].includes(current.status))
      die(`server could not wake (status: ${current?.status ?? 'missing'}) — check: npx weeny-cloud`)
  }
  die('server is still waking after 5 minutes — check: npx weeny-cloud, then retry')
}

const accessObject = access => typeof access === 'string' ? { status: access } : access ?? {}
const idleMinutes = machine => Number(machine?.freeIdleMinutes) > 0 ? Number(machine.freeIdleMinutes) : 30
let paidChoiceShown = false
function paidChoice(access = {}, upgrade = false) {
  if (paidChoiceShown || access.paid) return
  paidChoiceShown = true
  const url = `${API}/dashboard/account#billing`
  if (upgrade) return console.error(`Paid upgrade for always-on hosting or more RAM. Ask your human to choose: ${url}`)
  const available = access.plans?.some(plan => plan.available)
  console.error(`${available ? 'Paid server available' : 'Paid plans (check availability)'}. Only the human should choose a paid plan (direct paid access charges immediately without a free trial): ${url}`)
}
function freeNotice(machine = {}) {
  console.error(`Free · 1 GB RAM · sleeps after ${idleMinutes(machine)} idle minutes; wakes on request. Tell your human about sleeping. Build larger apps locally or in CI, then push.`)
  paidChoice(machine, true)
}

// Availability is supplied by the same admission policy as create. Looking does not
// claim capacity, and the financial choice always stays with the human.
function serverChoices(raw, position) {
  const access = accessObject(raw)
  if (access.hasServer || ['ready', 'provisioning'].includes(access.status)) return
  if (!access.offers?.trial?.available && access.plans?.some(plan => plan.available)) paidChoice(access)
  if (access.offers?.trial?.available)
    console.error('Full-size trial available — npx weeny-cloud create. Seven days start when your server is ready.')
  if (access.offers?.free?.available)
    console.error(`Free 1 GB server available — npx weeny-cloud create --free. First tell your human it sleeps after ${idleMinutes(access)} idle minutes and wakes on request; build larger apps locally or in CI.`)
  if (access.paid && access.canCreate)
    console.error('Your paid server is available — npx weeny-cloud create uses your purchased plan.')
  if (access.status === 'waitlisted') {
    console.error(`Your account is ready.${position ? ` You're #${position} on the waitlist.` : ' You are waiting for a server.'} No trial time has started.`)
  } else if (!access.offers && access.status === 'unrequested') {
    console.error('No server yet — check availability with npx weeny-cloud create, or choose create --free for a free 1 GB server.')
  }
  if (access.offers || ['waitlisted', 'unrequested'].includes(access.status)) paidChoice(access)
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
  const current = machines.filter(m => !['failed', 'deleted'].includes(m.status))
  if (!current.length) {
    console.log('no server yet')
    const me = await call('/api/me')
    serverChoices(me.serverAccess, me.serverAccess?.position)
    return commandList()
  }
  const key = sshKeyPath()
  for (const m of current) {
    let sshCmd = ''
    if (m.status === 'running') {
      try { ensureSshConfig(m, key) } catch {}
      // tunnel machines (firecracker) have no routable IP — the way in is the CLI
      sshCmd = !ENV.production || m.reachable === 'tunnel' ? 'npx weeny-cloud ssh' : `ssh root@${m.ip}`
    }
    console.log(`server: ${m.status}  ${sshCmd}  ${m.error ? `(${m.error.slice(0, 60)})` : ''}`)
    if (m.tier === 'free') freeNotice(m)
  }
  console.log(`next: push code up (npx weeny-cloud push ./myapp) or go look around (npx weeny-cloud ssh)`)
  commandList()
}

function commandList() {
  console.log(`
  npx weeny-cloud login            sign in — weeny emails you a code
  npx weeny-cloud create [--free]  get a trial or free 1 GB server (~2 min)
  npx weeny-cloud push [folder]    deploy this folder to your server (re-push = new release)
  npx weeny-cloud ssh [command]    go to the server — that's where the power is
  npx weeny-cloud apps             every app you can reach — yours + shared with you
  npx weeny-cloud token <host>     bearer token to call a private app from a terminal/agent
  npx weeny-cloud keys             this account's device keys (list, --revoke, --register)
  npx weeny-cloud tier             see plans / change size (humans decide this one)
  npx weeny-cloud feedback         preview feedback for Theo (send only with --confirm)
  npx weeny-cloud skill            teach your coding agent all of this
  npx weeny-cloud help [command]   details + examples

on the server, apps are run with \`weeny\` — bare \`weeny\` there explains itself.`)
}

const commands = {
  async feedback() {
    try {
      await runFeedback(process.argv.slice(3), { command: 'npx weeny-cloud feedback',
        send: body => call('/api/feedback', { method: 'POST', body }) })
    } catch (e) { die(e.message) }
  },
  async login() {
    if (CI_CREDS) die('Unset WEENY_TOKEN before interactive login; CI uses the provided credentials')
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
    const v = await call('/api/auth/verify', { method: 'POST', body: { email, code, client: 'cli', label: flags.label || `cli@${process.env.USER || 'unknown'}` }, auth: false })
    if (v.status === 'waitlisted' && !v.token) {
      serverChoices({ status: 'waitlisted' }, v.position)
      return
    }
    mkdirSync(DIR, { recursive: true })
    writeFileSync(CREDS, JSON.stringify({ email: v.email, token: v.token, apiBase: API }, null, 2), { mode: 0o600 })
    console.log(`✓ signed in as ${v.email}`)
    serverChoices(v.serverAccess, v.position ?? v.serverAccess?.position)
  },

  async create() {
    if (CI_CREDS) die('CI deployment credentials use an existing server; provision it from a signed-in local session first')
    const free = 'free' in flags
    if (free) {
      const me = await call('/api/me')
      if (!me.serverAccess?.hasServer && !me.serverAccess?.paid) freeNotice(me.serverAccess)
    }
    let pub = findPublicKey()
    if (!pub) {
      mkdirSync(SSH_DIR, { recursive: true, mode: 0o700 })
      console.log(`no SSH key found — generating ${join(SSH_DIR, 'weeny_ed25519')}`)
      execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', 'weeny', '-f', join(SSH_DIR, 'weeny_ed25519')])
      pub = findPublicKey()
    }
    console.log(`using SSH key: ${pub.path}`)
    const m = await call('/api/machines', { method: 'POST', body: { sshPublicKey: pub.key, ...(free ? { offer: 'free' } : {}) } })
    if (m.unsynced?.length) die(`Device key saved, but its server could not be reached: ${m.unsynced.join(', ')}. Retry create before connecting.`)
    if (m.waitingForCapacity) {
      console.error(`Your request for ${m.name} is queued for ${m.capacityStatus === 'capacity_exhausted' ? 'server' : 'free'} capacity. Your account and approval are saved.${m.trialPending?' Your trial starts when the server is ready.':''}`)
      paidChoice()
      return
    }
    if (m.trialPending) paidChoice({}, true)
    if (['sleeping', 'resuming'].includes(m.status)) await runningMachine()
    console.log(['queued', 'provisioning'].includes(m.status)
      ? `→ setting up your server ${m.name} (takes ~2 minutes)…`
      : `→ using your existing server ${m.name}…`)
    let notePrinted = false
    for (;;) {
      await new Promise(r => setTimeout(r, 5000))
      const { machines } = await call('/api/machines')
      const mine = machines.find(x => x.id === m.id)
      if (!mine) die('server vanished?')
      if (mine.status === 'failed') die(`setup failed: ${mine.error}`)
      if (mine.note && !notePrinted) { notePrinted = true; console.log(`\n${mine.note}\n(you can ctrl-c — we'll email you, and bare \`npx weeny-cloud\` shows progress)`) }
      if (mine.status === 'running') {
        if (!free && mine.tier === 'free') freeNotice(mine)
        const keyPath = pub.path.replace(/\.pub$/, '')
        ensureSshConfig(mine, keyPath)   // writes the direct or tunnel ssh-config block
        const creds = loadCreds()
        if (creds) writeFileSync(CREDS, JSON.stringify({ ...creds, keyPath }, null, 2), { mode: 0o600 })
        // Firecracker boxes have no public IP — the way in is `npx weeny-cloud ssh` (rides the
        // VM's own tunnel). Direct machines get the classic ssh line.
        const wayIn = !ENV.production || mine.reachable === 'tunnel' ? `npx weeny-cloud ssh` : `ssh root@${mine.ip}`
        console.log(`
✓ your server is ready

  ${wayIn}

To put an app on it:
  1. build it locally, then deploy it:   npx weeny-cloud push ./myapp -- <start command>
  2. put it on the internet:             npx weeny-cloud ssh "weeny expose myapp <port>"   → https://myapp-xxxx.onweeny.com

A push is a deployment: it uploads, builds (pass --build "<cmd>" if the app needs one),
health-checks and goes live — or the previous release keeps serving.

Apps are operated ON the server with \`weeny\` — bare \`weeny\` there explains itself.
Deploying with a coding agent? Run this first so it knows how:  npx weeny-cloud skill
`)
        return
      }
      process.stdout.write('.')
    }
  },

  // Ship a local directory to the server as a new RELEASE: upload into a fresh staging
  // area, then the box builds, health-checks and activates it — or keeps the old release
  // serving. Push never mutates anything until the whole transaction succeeds.
  async push() {
    // push needs its own parser: values with spaces (--build "npm ci && npm run build")
    // and a `-- <start command>` tail are beyond the crude module-level flag scan.
    const argvAll = process.argv.slice(3)
    const dd = argvAll.indexOf('--')
    const head = dd >= 0 ? argvAll.slice(0, dd) : argvAll
    const startArgv = dd >= 0 ? argvAll.slice(dd + 1) : []
    const f = {}, pos = []
    const VALUED = new Set(['build', 'health', 'tag'])
    for (let i = 0; i < head.length; i++) {
      if (head[i].startsWith('--')) {
        const k = head[i].slice(2)
        if (VALUED.has(k)) {
          const v = head[i + 1]
          if (v === undefined || v.startsWith('--')) die(`--${k} needs a value in quotes`)
          f[k] = v; i++
        } else f[k] = true   // boolean flags: --all
      } else pos.push(head[i])
    }
    if ('no-restart' in f) die(`--no-restart is gone: push now deploys atomically — there is no upload-without-deploy`)

    const dir = resolve(pos[0] ?? '.')
    const app = pos[1] ?? basename(dir).toLowerCase()
    try { if (!statSync(dir).isDirectory()) die(`not a directory: ${dir}`) } catch { die(`no such directory: ${dir}`) }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(app) || app.length > 40) die(`app name '${app}' must be lowercase letters, digits, hyphens (max 40) — pass one: npx weeny-cloud push ${pos[0] ?? '.'} <name>`)

    const m = await runningMachine()
    const { host } = await sshTarget(m)   // writes/refreshes the ssh-config block (direct or tunnel)

    // Step 1: the box creates a unique empty staging dir for THIS push and tells us what
    // it already knows (current release, remembered commands) — so a doomed first push
    // fails here, before a single byte is uploaded.
    let begin
    try {
      const out = execFileSync('ssh', [...SSH_FLAGS, host, `weeny _deploy-begin ${app}`], { encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'] })
      begin = JSON.parse(out.trim().split('\n').pop())
    } catch {
      die(`this server doesn't speak the push protocol — update it (ssh in and re-run the installer), or deploy on the server: weeny deploy ${app} --from <dir> -- <command>`)
    }
    if (!begin.defaults?.start?.length && !startArgv.length) {
      // The trap here: the app name defaults to the FOLDER name. If someone re-pushes an
      // existing app from a folder named differently, this looks like a first push of a
      // brand-new app — and a blind retry with `-- <cmd>` would mint a duplicate. Say so.
      if (!pos[1]) die(`no app called '${app}' on your server yet — that name came from the folder.\n` +
        `  updating an existing app with a different name? pass it: npx weeny-cloud push ${pos[0] ?? '.'} <app-name>\n` +
        `  deploying '${app}' as a NEW app? add its start command: npx weeny-cloud push ${pos[0] ?? '.'} ${app} -- <command>`)
      die(`first push of '${app}' needs a start command — end the line with: -- <command> [args…]\n  e.g. npx weeny-cloud push ${pos[0] ?? '.'} ${app} -- npm start`)
    }
    const build = 'build' in f ? f.build : begin.defaults?.build
    const memMb = Number(m.memMb) || (['free', 'teeny'].includes(m.tier) ? 1024 : 0)
    const buildAdvice = memMb > 0 && memMb <= 1024 && !!build
    if (buildAdvice)
      console.error('1 GB RAM: larger builds may run out of memory. Prefer local/CI builds, then push prebuilt output; see /recipes/teeny.txt.')

    // Ship SOURCE only. Always skip node_modules (must be built on the Linux server — Mac-built
    // native binaries won't run there) and .git. Also respect .gitignore (build outputs like
    // .next/dist, caches, .env) unless --all. We print what we skip — never silent.
    const all = 'all' in f
    const useGitignore = !all && existsSync(join(dir, '.gitignore'))
    console.log(`→ pushing ${dir} → a new release of '${app}' on ${m.name}`)
    console.log(`  · never shipped: node_modules, .git (deps install on the server, inside the release)`)
    if (useGitignore) console.log(`  · respecting .gitignore (build output, caches, .env stay local) — pass --all to override`)
    if (useGitignore && existsSync(join(dir, '.env'))) {
      try { if (/^\s*\.env/m.test(readFileSync(join(dir, '.gitignore'), 'utf8')))
        console.log(`  · note: .env is gitignored → not shipped. Set secrets with 'weeny env ${app} KEY=value' (or --all to include it).`) } catch {}
    }
    if (begin.defaults?.start?.length && !startArgv.length) console.log(`  · reusing remembered commands${begin.defaults.build ? ` (build: ${begin.defaults.build})` : ''}`)

    // Step 2: upload into the empty staging dir. No --delete needed — the destination is
    // pristine, so this push can't inherit stale files OR delete anything server-side.
    // --copy-dest sources unchanged files from the live release as server-local COPIES
    // (new inodes, so releases stay independent) — rsync's delta without the hardlinks.
    const filters = ['--exclude', '.git', '--exclude', 'node_modules', ...(useGitignore ? ['--filter', ':- .gitignore'] : [])]
    const copyDest = begin.baseReleaseId ? ['--copy-dest', `/apps/${app}/current`] : []
    try {
      execFileSync('rsync', ['-az', ...filters, ...copyDest, '-e', SSH_COMMAND, `${dir}/`, `${host}:${begin.incomingDir}/`], { stdio: 'inherit' })
    } catch {
      // no rsync — tar over ssh into the same staging dir (host + incomingDir are safe
      // server-generated tokens). Same empty-destination semantics; no delta.
      const tarExcl = `--exclude .git --exclude node_modules${useGitignore ? ` --exclude-from=${shellQuote(join(dir, '.gitignore'))}` : ''}`
      execSync(`tar -C ${shellQuote(dir)} ${tarExcl} -czf - . | ${SSH_COMMAND} ${shellQuote(host)} 'tar -xzf - -C ${begin.incomingDir}'`, { stdio: 'inherit' })
    }
    console.log(`✓ uploaded`)

    // Step 3: finalize — the box runs the whole transaction (build → health gate →
    // activate, or restore the previous release) and streams it back here.
    const shq = (v) => `'` + String(v).replace(/'/g, `'\\''`) + `'`
    const git = collectGitMetaLocal(dir)
    const parts = ['weeny', '_deploy-finalize', app, '--id', begin.deploymentId]
    if ('build' in f) parts.push('--build', shq(f.build))
    if ('health' in f) parts.push('--health', shq(f.health))
    if ('tag' in f) parts.push('--tag', shq(f.tag))
    if (git) parts.push('--git-b64', Buffer.from(JSON.stringify(git)).toString('base64'))
    if (startArgv.length) parts.push('--', ...startArgv.map(shq))
    try { execFileSync('ssh', [...SSH_FLAGS, host, (buildAdvice ? 'WEENY_BUILD_ADVICE_SHOWN=1 ' : '') + parts.join(' ')], { stdio: 'inherit' }) }
    catch (e) {
      if (e.status === 3) console.error(`  retry: npx weeny-cloud push ${pos[0] ?? '.'} ${app}`)
      process.exit(e.status ?? 1)
    }
  },

  // Run a command on the server (or open a shell). Works for tunnel + direct machines alike.
  async ssh() {
    const m = await runningMachine()
    const { host } = await sshTarget(m)
    const rest = process.argv.slice(3)
    try { execFileSync('ssh', [...SSH_FLAGS, ...(rest.length ? [] : ['-t']), host, ...rest], { stdio: 'inherit' }) }
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
    if ('register' in flags) return registerDeviceKey(flags['key-file'])
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
      die(`changing plan changes what your human pays — this one's theirs. Ask them to run:\n  npx weeny-cloud tier ${want}\nor upgrade in the browser: weeny.cloud/dashboard/billing`)
    console.log(`${bs.tier} → ${want}: ${target.vcpu} vcpu · ${target.memGb}gb at ${price(target)}, prorated from today.`)
    console.log(`your server reboots into its new size (~a minute; apps come back automatically).`)
    const yn = await ask('sound good? (yes/no): ')
    if (!/^y(es)?$/i.test(yn)) return console.log('no worries — nothing changed')
    const r = await call('/api/billing/tier', { method: 'POST', body: { tier: want } })
    if (r.checkoutUrl) return console.log(`\nfinish up here (takes a card):\n\n  ${r.checkoutUrl}\n\nyour server resizes as soon as payment lands.`)
    console.log(`✓ you're on ${want}${r.resizing ? ' — server resizing now (back in ~a minute)' : ''}`)
  },

  // Everything you can reach: your apps + apps shared with you (weeny allow).
  async apps() {
    const r = await call('/api/apps/reachable')
    const owned = r.owned ?? [], shared = r.shared ?? []
    const pad = (s, n) => String(s ?? '').padEnd(n)
    const urlOf = (a) => a.url ?? '(not exposed)'
    const w1 = Math.max(4, ...[...owned, ...shared].map(a => a.name.length))
    const w2 = Math.max(12, ...[...owned, ...shared].map(a => urlOf(a).length))

    console.log('your apps')
    if (!owned.length) console.log('  none yet — npx weeny-cloud push ./myapp deploys one')
    for (const a of owned)
      console.log(`  ${pad(a.name, w1)}  ${pad(urlOf(a), w2)}  ${pad(a.status, 8)}  on ${a.machine}${a.private ? '  🔒' : ''}`)

    console.log('\nshared with you')
    if (!shared.length) console.log('  none yet — apps someone `weeny allow`s you into appear here')
    for (const a of shared) {
      const via = a.basis === 'direct' ? '' : `  via ${a.basis.replace(/^domain:/, '')}`
      console.log(`  ${pad(a.name, w1)}  ${pad(urlOf(a), w2)}  by ${a.owner}${via}  🔒`)
      if (a.blurb) console.log(`  ${' '.repeat(w1)}  ${a.blurb}`)
    }
    if ([...owned, ...shared].some(a => a.private))
      console.log(`\n🔒 private — mint a 12h bearer to call it from a terminal/agent: npx weeny-cloud token <host>`)
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
    const dir = ENV.production ? join(homedir(), '.claude', 'skills', 'weeny') : join(DIR, 'skills', 'weeny')
    mkdirSync(dir, { recursive: true })
    const res = await fetch(API + '/weeny-skill.md', ENV.production ? {} : { redirect: 'error' })
    if (!res.ok) die('could not fetch the skill')
    let skill = await res.text()
    if (!ENV.production) {
      const invoke = ['env', 'WEENY_ENV=staging', `WEENY_API=${API}`, `WEENY_CONFIG_DIR=${DIR}`, process.execPath, SELF].map(shellQuote).join(' ')
      skill = skill.replaceAll('npx weeny-cloud', invoke)
        .replaceAll('https://weeny.cloud', API)
    }
    writeFileSync(join(dir, 'SKILL.md'), skill)
    if (!ENV.production) return console.log(`✓ staged skill → ${dir}/SKILL.md\nAsk your test agent to read this file. Your production agent skills were not changed.`)
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
  feedback: feedbackHelp('npx weeny-cloud feedback'),
  login: `npx weeny-cloud login [--email x@y.com] [--code 123456]

Create an account and sign in (free server access may be waitlisted) with your email — weeny sends a 6-digit code.
Non-interactive (for agents): pass --email first, then re-run with --email + --code.
The code lands in the human's inbox — unless you already have access to their emails,
stop and ask them to provide the code.
Signed out? Delete ~/.weeny/credentials.json.`,
  create: `npx weeny-cloud create [--free]

Provision your server (~2 min): a real Linux box — root, SSH, systemd. Uses your SSH
key (generates ~/.ssh/weeny_ed25519 if you have none). Default requests a full-size
7-day trial if available; the clock starts when the server is ready. --free requests
a 1 GB free server immediately, subject to separate free capacity. Tell your human
that it sleeps after inactivity and wakes on request; build larger apps locally or
in CI. Existing paid accounts keep their purchased plan. Paid choices are the human's.
Paid option: ask your human to choose at ${API}/dashboard/account#billing.
One server per account for now. Delete/suspend/rebuild live in the dashboard.`,
  push: `npx weeny-cloud push [folder] [app-name] [--build "<cmd>"] [--health "<cmd>"] [--tag "<text>"] [--all] [-- <start command>]

Deploy a local folder to your server as a new release (name defaults to the folder's).
First push needs the start command: end the line with \`-- <command>\`; a build step is
your call too (\`--build "npm ci && npm run build"\`). After that, bare
\`npx weeny-cloud push ./myapp\` re-deploys with the remembered commands — but keep
passing the app name whenever it differs from the folder's (the name is inferred from
the folder otherwise).

Each push uploads into a fresh staging area (delta transfer against the live release),
builds INSIDE the new release, health-checks it, and only then switches over — a failed
build or a failing app leaves the previous release serving. Skips .git and node_modules;
respects .gitignore (--all to override). Rollback: weeny rollback <app> on the server.`,
  ssh: `npx weeny-cloud ssh [command]

Open a shell on your server — or run one command and return. Uses the right key and IP
so it always works. Your apps live in /apps, their data in /data.
Sleeping free servers wake automatically for push or ssh; suspended servers do not.
No SSH key on this device (new laptop, wiped machine)? No problem — as long as you're
signed in, ssh generates and registers a fresh device key automatically.`,
  apps: `npx weeny-cloud apps

Every app you can reach: yours (with machine and URL) and the private apps other
people have shared with you (weeny allow <app> <your-email> on their server) — each
with its owner, how you're allowed in (directly or via your email domain), and what
it does (from the app's own llms.txt). Private apps take a 12h bearer:
npx weeny-cloud token <host>. Every listed app documents itself at GET /llms.txt.`,
  token: `npx weeny-cloud token <app-url-or-host>

Call a private app (weeny expose --private) from a terminal or agent. Already signed
in on this machine? This is the whole flow — it prints a 12-hour bearer token:
curl -H "Authorization: Bearer <token>" https://<host>/. The app sees your email in
the X-Weeny-User header. Not signed in? npx weeny-cloud login first (a private app's
401 also carries a login_url for tools that can open a browser). Not allowed? Ask the
owner: weeny allow <app> <your-email>. Any weeny app explains how to connect at
GET /__weeny and, when it ships a manifest, documents its API at GET /llms.txt.`,
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
const SERVER_WORDS = new Set(['deploy', 'start', 'stop', 'restart', 'releases', 'rollback', 'deployments', 'inspect', 'expose', 'unexpose', 'remove', 'env', 'domain', 'allow', 'revoke', 'health'])
const OLD_TO_NEW = { run: 'deploy', rm: 'remove', list: '', ls: '', access: 'allow', guide: 'help' }
const LINUX_HINT = { logs: 'journalctl -u weeny-APP -f' }
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
