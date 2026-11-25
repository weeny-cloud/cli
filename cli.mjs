#!/usr/bin/env node
// weeny-cloud — the weeny.cloud laptop CLI. Its whole job: get code and people TO
// your server. (Apps are operated ON the server with the `weeny` command — ssh in.)
// Agent-friendly by design: an agent can run every step except reading your inbox.
import { readFileSync, existsSync, readdirSync, statSync, rmSync } from 'node:fs'
import { execFileSync, execSync } from 'node:child_process'
import { createInterface } from 'node:readline/promises'
import { join, resolve, basename, relative, isAbsolute, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { feedbackHelp, runFeedback } from './feedback.mjs'
import { onboardingHelp, onboardingNotice, runOnboarding, serverGuidance } from './onboarding.mjs'
import { cliEnvironment, credentialsForOrigin, credentialsFromEnv } from './environment.mjs'
import { installSkill, maybeCheckUpdates } from './skill-updates.mjs'
import { resourceNoticesAllowed, maybeShowResourceNotices } from './resource-notices.mjs'
import { profileAccessError, profileDirectory, writeProfile, checkProfileWritable } from './profile.mjs'
import { proxyCommand } from './ssh-command.mjs'
import { accountCommands, accountValueOptions, parseOptions, selectMachine } from './account-commands.mjs'

const SELF = fileURLToPath(import.meta.url)   // absolute path to this cli.mjs (for ProxyCommand)

// Carry the selected API/profile as literal relay arguments, without a platform shell.
// Older generated configs with only a machine ID still use their inherited environment.
const relayApi = process.argv[2] === '_relay' && process.argv[4]
const ENV = cliEnvironment(relayApi ? { ...process.env, WEENY_API: relayApi,
  WEENY_CONFIG_DIR: process.argv[5], WEENY_ENV: relayApi === 'https://weeny.cloud' ? 'production' : 'staging' } : process.env)
const CI_CREDS = credentialsFromEnv(process.env, ENV)
const API = ENV.api
const DIR = ENV.dir
const SSH_DIR = ENV.sshDir
// CI never inherits earlier Host/Match/Include rules from a user profile.
const SSH_CONFIG = join(SSH_DIR, CI_CREDS ? 'ci-config' : 'config')
const SSH_FLAGS = ['-F', SSH_CONFIG]
const shellQuote = v => `'${String(v).replace(/'/g, `'\\''`)}'`
const SSH_COMMAND = ['ssh', ...SSH_FLAGS].map(shellQuote).join(' ')
const CREDS = join(DIR, 'credentials.json')
const ALIASES = { status: 'server', whoami: 'help' }
const VALUE_OPTIONS = {
  ...accountValueOptions,
  create: ['name', 'tier'],
  push: ['build', 'health', 'stop', 'startup-timeout', 'tag', 'server', 'port', 'origin-route'],
  login: ['email', 'code', 'label'],
  onboarding: ['project', 'discovery', 'discovery-detail'],
  keys: ['revoke'],
}
const cmd = process.argv[2]
const command = Object.hasOwn(ALIASES, cmd) ? ALIASES[cmd] : cmd
const argv = process.argv.slice(3)
const delimiter = argv.indexOf('--')
const optionsHead = argv.slice(0, delimiter === -1 ? argv.length : delimiter)
const sshArgsStart = argv[0] === '--server' ? 2 : 0
const valueFlags = Object.hasOwn(VALUE_OPTIONS, command) ? VALUE_OPTIONS[command].map(key => `--${key}`) : []
const wantsHelp = ['help','--help','-h'].includes(cmd) || (cmd === 'ssh'
  ? ['--help','-h'].includes(argv[sshArgsStart])
  : optionsHead.some((arg, index) => arg === '--help' || (arg === '-h' && !valueFlags.includes(optionsHead[index - 1]))))
const jsonOutput = cmd !== 'ssh' && optionsHead.includes('--json')
if (!ENV.production && !jsonOutput && !wantsHelp) console.error(`STAGING: ${API} — isolated account and SSH profile`)

const die = (msg, details = {}) => { console.error(jsonOutput ? JSON.stringify({ error: { message: msg, ...details } }) : `✗ ${msg}`); process.exit(1) }

function loadCreds() {
  if (CI_CREDS) return CI_CREDS
  let creds
  try { creds = JSON.parse(readFileSync(CREDS, 'utf8')) } catch (error) {
    const accessError = profileAccessError(error, CREDS)
    if (accessError !== error) throw accessError
    return null
  }
  return credentialsForOrigin(creds, ENV)
}

async function call(path, { method = 'GET', body, auth = true } = {}) {
  const headers = { 'Content-Type': 'application/json', 'X-Weeny-CLI-Features': 'multi-server-v1' }
  if (auth) {
    const creds = loadCreds()
    if (!creds?.token) die(`not signed in — run: npx weeny-cloud login`)
    headers.Authorization = `Bearer ${creds.token}`
  }
  const res = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined,
    ...(ENV.production ? {} : { redirect: 'error' }) })
  const json = await res.json().catch(() => ({}))
  if (res.status === 401 && auth) die('session expired or revoked — run: npx weeny-cloud login')
  if (res.status === 402 && !jsonOutput) {
    console.error(`\n${json.statusMessage || json.message || 'Subscription required'}`)
    const url = json.data?.checkoutUrl
    if (url) console.error(`\nSort it out here:\n\n  ${url}\n\nThen run this command again.`)
    process.exit(1)
  }
  if (!res.ok) {
    if (json.data?.code === 'builder_profile_required' && !jsonOutput) onboardingNotice(json.data.onboarding)
    if (!jsonOutput && method === 'POST' && path === '/api/machines' && (json.data?.guidance !== undefined || json.data?.offers || json.data?.code === 'waitlisted'))
      serverChoices({ ...json.data, status: 'waitlisted' }, json.data?.position)
    const cancelCheckoutCommand=method==='POST' && path==='/api/machines' && json.data?.code==='exists' && json.data?.checkoutUrl
      ? 'npx weeny-cloud billing cancel-checkout' : undefined
    if (cancelCheckoutCommand && !jsonOutput && typeof json.data?.guidance !== 'string') console.error(`Cancel the unpaid checkout and keep your waitlist place: ${cancelCheckoutCommand}`)
    const currentGuidance = typeof json.data?.guidance === 'string' && json.data.guidance.trim()
    const errorMessage = currentGuidance && !jsonOutput
      ? json.data.reason || `${method} ${path} → ${res.status}`
      : json.statusMessage || json.message || `${method} ${path} → ${res.status}`
    die(errorMessage, { status: res.status, data: json.data,
      ...(cancelCheckoutCommand ? {nextCommand:cancelCheckoutCommand} : {}) })
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
    const relay = [process.execPath, SELF, '_relay', m.id, API, DIR]
    lines.push(`  ProxyCommand ${proxyCommand(relay)}`,
      `  ServerAliveInterval 30`)
  } else {
    lines.push(`  HostName ${m.ip}`)
  }
  const begin = `# >>> weeny ${alias}`, end = `# <<< weeny ${alias}`
  const block = `${begin}\n${lines.join('\n')}\n${end}\n`

  const cfg = SSH_CONFIG
  let existing = ''
  if (!CI_CREDS) try { existing = readFileSync(cfg, 'utf8') } catch (error) {
    if (error.code !== 'ENOENT') throw profileAccessError(error, cfg)
  }
  // strip any prior weeny-managed block for this alias, then append the fresh one
  const stripped = existing.replace(new RegExp(`\\n?${begin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${end.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n?`, 'g'), '\n')
  profileDirectory(SSH_DIR)
  profileDirectory(DIR)
  writeProfile(cfg, stripped.replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '') + (stripped.endsWith('\n') || !stripped ? '' : '\n') + block)
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
  const localKey = stored && relative(SSH_DIR, resolve(stored))
  if (stored && existsSync(stored) && (ENV.production || (localKey && !isAbsolute(localKey) && localKey !== '..' && !localKey.startsWith('..' + sep)))) return stored
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
    profileDirectory(SSH_DIR)
    keyPath = join(SSH_DIR, 'weeny_ed25519')
    execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', 'weeny', '-f', keyPath])
  }
  const publicKey = readFileSync(`${keyPath}.pub`, 'utf8').trim()
  const { unsynced } = await call('/api/ssh-keys', { method: 'POST', body: { publicKey } })
  console.log(`→ registered this device's key with your weeny account`)
  if (unsynced?.length) console.log(`  (couldn't reach: ${unsynced.join(', ')} — it'll pick the key up when it's next running)`)
  const creds = loadCreds()
  if (creds && !explicitKey) writeProfile(CREDS, JSON.stringify({ ...creds, keyPath }, null, 2))
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

async function runningMachine(server) {
  const { machines } = await call('/api/machines')
  return wakeMachine(selectMachine(machines, server))
}

async function wakeMachine(waking) {
  if (waking.status === 'running') return waking
  if (!['sleeping', 'resuming'].includes(waking.status)) die(`${waking.name} (status: ${waking.status}) — check: npx weeny-cloud server status`)
  if (!jsonOutput) console.error('→ waking your server…')
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
function machineNotice(machine = {}) {
  if (!serverGuidance(machine.guidance) && machine.tier === 'free')
    console.error(`Review your server's current plan and terms: ${API}/dashboard/account#billing`)
}

// The server owns offer selection, wording and financial terms. Older servers
// get a neutral review link rather than a locally reconstructed offer.
function serverChoices(raw, position) {
  const access = accessObject(raw)
  if (serverGuidance(access.guidance)) return
  if (access.hasServer || ['ready', 'provisioning'].includes(access.status)) return
  console.error(`Review current server options with your human: ${access.serverUrl || API + '/dashboard/start'}`)
  if (position) console.error(`Your saved waitlist position is #${position}.`)
  if (['held','checkout'].includes(access.purchase?.status))
    console.error('To cancel an unpaid checkout: npx weeny-cloud billing cancel-checkout')
}

// Bare `weeny-cloud`: where you stand + what to type next. Replaces status/whoami.
async function orient() {
  const creds = loadCreds()
  if (!creds?.token) {
    console.log(`weeny.cloud — your agent’s Linux server. HTTPS, private sharing and backups included. Sign in to see current server options:`)
    return commandList()
  }
  const { machines } = await call('/api/machines')
  console.log(`signed in as ${creds.email}`)
  const current = machines.filter(m => !['failed', 'deleted'].includes(m.status))
  if (!current.length) {
    const me = await call('/api/me')
    if (me.onboarding?.required && !me.onboarding.complete) return onboardingNotice(me.onboarding)
    console.log('no server yet')
    serverChoices(me.serverAccess, me.serverAccess?.position)
    return commandList()
  }
  const key = sshKeyPath()
  for (const m of current) {
    let sshCmd = ''
    if (m.status === 'running') {
      try { ensureSshConfig(m, key) } catch {}
      // tunnel machines (firecracker) have no routable IP — the way in is the CLI
      sshCmd = !ENV.production || m.reachable === 'tunnel' ? 'npx weeny-cloud ssh' + (current.length > 1 ? ' --server ' + m.name : '') : `ssh root@${m.ip}`
    }
    console.log(`${current.length > 1 ? m.name : 'server'}: ${m.status}  ${sshCmd}  ${m.error ? `(${m.error.slice(0, 60)})` : ''}`)
    machineNotice(m)
  }
  console.log(current.length > 1 ? 'Pass --server NAME to push, ssh, or tier.' : 'next: push code up (npx weeny-cloud push ./myapp) or go look around (npx weeny-cloud ssh)')
  commandList()
}

function commandList() {
  console.log(`
  npx weeny-cloud login            sign in — weeny emails you a code
  npx weeny-cloud onboarding      complete signup from the project context your agent already has
  npx weeny-cloud create          request a server using the current offers
  npx weeny-cloud push [folder]    deploy this folder to your server (re-push = new release)
  npx weeny-cloud ssh [command]    go to the server — that's where the power is
  npx weeny-cloud apps             every app you can reach — yours + shared with you
  npx weeny-cloud token <host>     bearer token to call a private app from a terminal/agent
  npx weeny-cloud keys             this account's device keys (list, --revoke, --register)
  npx weeny-cloud server           status / resume / suspend / rebuild / delete
  npx weeny-cloud route            reserve and manage HTTPS routes
  npx weeny-cloud widget <app>     badge and starting position (also on the server)
  npx weeny-cloud tier             plans / preview / confirmed plan change
  npx weeny-cloud billing          status / end-trial / cancel-checkout / human billing links
  npx weeny-cloud logout           revoke this token and remove local credentials
  npx weeny-cloud feedback         preview feedback for Theo (send only with --confirm)
  npx weeny-cloud skill            teach your coding agent all of this
  npx weeny-cloud help [command]   details + examples

on the server, apps are run with \`weeny\` — bare \`weeny\` there explains itself.`)
}

const commands = {
  async onboarding() {
    try { await runOnboarding(process.argv.slice(3), { call }) }
    catch (e) { die(e.message) }
  },
  async feedback() {
    try {
      await runFeedback(process.argv.slice(3), { command: 'npx weeny-cloud feedback',
        send: body => call('/api/feedback', { method: 'POST', body }) })
    } catch (e) { die(e.message) }
  },
  async login() {
    if (CI_CREDS) die('Unset WEENY_TOKEN before interactive login; CI uses the provided credentials')
    checkProfileWritable(DIR)
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
    writeProfile(CREDS, JSON.stringify({ email: v.email, token: v.token, apiBase: API }, null, 2))
    console.log(`✓ signed in as ${v.email}`)
    if (v.onboarding?.required && !v.onboarding.complete) return onboardingNotice(v.onboarding)
    serverChoices(v.serverAccess, v.position ?? v.serverAccess?.position)
  },

  async create() {
    const { options, args } = parseOptions(argv, VALUE_OPTIONS.create, ['free'])
    const named = options.name !== undefined || options.tier !== undefined
    if (args.length || (named && (!options.name?.trim() || !options.tier?.trim() || options.free)))
      die('Usage: weeny-cloud create [--name NAME --tier teeny|weeny|meany] [--json]')
    if (CI_CREDS) die('CI deployment credentials use an existing server; provision it from a signed-in local session first')
    if (named) {
      const result = await call('/api/machines/named', { method: 'POST', body: { name: options.name, tier: options.tier } })
      if (jsonOutput) return console.log(JSON.stringify(result))
      if (result.checkoutUrl) {
        console.log(`${result.name}: $${result.monthlyUsd}/month. Due now: $${(result.immediateCents / 100).toFixed(2)}.\nPay: ${result.checkoutUrl}`)
        return
      }
      console.log(`${result.name}: ${result.status}. Check with npx weeny-cloud server status.`)
      return
    }
    // Legacy --free is a harmless alias; selection now belongs to the server.
    let pub = findPublicKey()
    if (!pub) {
      profileDirectory(SSH_DIR)
      if (!jsonOutput) console.log(`no SSH key found — generating ${join(SSH_DIR, 'weeny_ed25519')}`)
      execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', 'weeny', '-f', join(SSH_DIR, 'weeny_ed25519')])
      pub = findPublicKey()
    }
    if (!jsonOutput) console.log(`using SSH key: ${pub.path}`)
    const m = await call('/api/machines', { method: 'POST', body: { sshPublicKey: pub.key } })
    if (m.unsynced?.length) die(`Device key saved, but its server could not be reached: ${m.unsynced.join(', ')}. Retry create before connecting.`)
    if (m.waitingForCapacity) {
      if (jsonOutput) return console.log(JSON.stringify(m))
      console.error(m.note || 'Your server request is queued. Check its current status on the server page.')
      serverChoices(m.serverAccess ?? m)
      return
    }
    if (['sleeping', 'resuming'].includes(m.status)) await wakeMachine(m)
    if (!jsonOutput) console.log(['queued', 'provisioning'].includes(m.status)
      ? `→ setting up your server ${m.name} (takes ~2 minutes)…`
      : `→ using your existing server ${m.name}…`)
    let notePrinted = false
    for (;;) {
      await new Promise(r => setTimeout(r, 5000))
      const { machines } = await call('/api/machines')
      const mine = machines.find(x => x.id === m.id)
      if (!mine) die('server vanished?')
      if (mine.status === 'failed') die(`setup failed: ${mine.error}`)
      if (!jsonOutput && mine.note && !notePrinted) { notePrinted = true; console.log(`\n${mine.note}\n(you can ctrl-c — we'll email you, and bare \`npx weeny-cloud\` shows progress)`) }
      if (mine.status === 'running') {
        const keyPath = pub.path.replace(/\.pub$/, '')
        ensureSshConfig(mine, keyPath)   // writes the direct or tunnel ssh-config block
        const creds = loadCreds()
        if (creds) writeProfile(CREDS, JSON.stringify({ ...creds, keyPath }, null, 2))
        if (jsonOutput) {
          const { id, name, status, tier, diskMb, memMb } = mine
          return console.log(JSON.stringify({ id, name, status, tier, diskMb, memMb }))
        }
        machineNotice(mine)
        const target = machines.some(other => other.id !== mine.id && !['failed', 'deleted'].includes(other.status))
          ? ` --server ${mine.id}` : ''
        // Firecracker boxes have no public IP — the way in is `npx weeny-cloud ssh` (rides the
        // VM's own tunnel). Direct machines get the classic ssh line.
        const wayIn = !ENV.production || mine.reachable === 'tunnel' ? `npx weeny-cloud ssh${target}` : `ssh root@${mine.ip}`
        console.log(`
✓ your server is ready

  ${wayIn}

To put an app on it:
  1. build it locally, then deploy it:   npx weeny-cloud push ./myapp${target} -- <start command>
  2. put it on the internet:             npx weeny-cloud ssh${target} "weeny expose myapp <port>"   → https://myapp-xxxx.onweeny.com

A push builds a new release, then stops, switches, starts and checks the app.
A failed startup restores the previous release.

Apps are operated ON the server with \`weeny\` — bare \`weeny\` there explains itself.
Deploying with a coding agent? Run this first so it knows how:  npx weeny-cloud skill
`)
        return
      }
      if (!jsonOutput) process.stdout.write('.')
    }
  },

  // Ship a local directory to the server as a new RELEASE: upload into a fresh staging
  // area, then the box builds, health-checks and activates it — or keeps the old release
  // serving. Push never mutates anything until the whole transaction succeeds.
  async push() {
    const startArgv = delimiter >= 0 ? argv.slice(delimiter + 1) : []
    const { options: f, args: pos } = parseOptions(optionsHead, VALUE_OPTIONS.push, ['all','no-restart'])
    if ('no-restart' in f) die('--no-restart has been removed. push uploads and deploys the release.')
    if (pos.length > 2) die('Usage: weeny-cloud push [folder] [app-name] [--server SERVER] [-- <start command>]')

    const dir = resolve(pos[0] ?? '.')
    const app = pos[1] ?? basename(dir).toLowerCase()
    try { if (!statSync(dir).isDirectory()) die(`not a directory: ${dir}`) } catch { die(`no such directory: ${dir}`) }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(app) || app.length > 40) die(`app name '${app}' must be lowercase letters, digits, hyphens (max 40) — pass one: npx weeny-cloud push ${pos[0] ?? '.'} <name>`)

    const m = await runningMachine(f.server)
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
    if (f.port === 'auto' && !begin.capabilities?.autoPort)
      die('this server needs an updated Weeny CLI before --port auto can be used')
    if (('port' in f || 'origin-route' in f) && !begin.capabilities?.deploymentNetworking)
      die('this server needs an updated Weeny CLI before --port or --origin-route can be used')
    if (('stop' in f || 'startup-timeout' in f) && !begin.capabilities?.lifecycleCommands)
      die('this server needs an updated Weeny CLI before --stop or --startup-timeout can be used; update the server CLI, then retry')
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
    if ('stop' in f) parts.push('--stop', shq(f.stop))
    if ('startup-timeout' in f) parts.push('--startup-timeout', shq(f['startup-timeout']))
    for (const key of ['port', 'origin-route']) {
      if (key in f) parts.push('--' + key, shq(f[key]))
    }
    if ('tag' in f) parts.push('--tag', shq(f.tag))
    if (git) parts.push('--git-b64', Buffer.from(JSON.stringify(git)).toString('base64'))
    if (startArgv.length) parts.push('--', ...startArgv.map(shq))
    try { execFileSync('ssh', [...SSH_FLAGS, host, (buildAdvice ? 'WEENY_BUILD_ADVICE_SHOWN=1 ' : '') + parts.join(' ')], { stdio: 'inherit' }) }
    catch (e) {
      if (e.status === 3) console.error(`  retry: npx weeny-cloud push ${pos[0] ?? '.'} ${app}${f.server ? ' --server ' + f.server : ''}`)
      process.exit(e.status ?? 1)
    }
  },

  async app() {
    const { args, options } = parseOptions(argv, ['server'])
    if (args.length !== 2 || args[0] !== 'create' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(args[1]))
      die('usage: weeny-cloud app create APP [--server SERVER] [--json]')
    const { host } = await sshTarget(await runningMachine(options.server))
    const command = ['weeny', 'app', 'create', args[1], ...(options.json ? ['--json'] : [])]
    try { execFileSync('ssh', [...SSH_FLAGS, host, ...command], { stdio: 'inherit' }) }
    catch (error) { process.exitCode = error.status || 1 }
  },

  // Run a command on the server (or open a shell). Works for tunnel + direct machines alike.
  async ssh() {
    const rest = argv.slice(sshArgsStart)
    const server = sshArgsStart ? argv[1] : undefined
    if (sshArgsStart && (!server?.trim() || server.startsWith('-'))) die('--server needs a name or ID')
    const m = await runningMachine(server)
    const { host } = await sshTarget(m)
    const openShell = !rest.length || (rest.length === 1 && rest[0] === '--')
    try { execFileSync('ssh', [...SSH_FLAGS, ...(openShell ? ['-t'] : []), host, ...rest], { stdio: 'inherit' }) }
    catch (e) {
      if (e.code === 'ENOENT') die('OpenSSH client not found. On Windows, install the OpenSSH Client optional feature, then reopen your terminal.')
      if (e.status === 255) console.error(`SSH exited 255 using configuration "${SSH_CONFIG}". See: npx weeny-cloud help ssh`)
      process.exit(e.status ?? 1)
    }
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
    ws.on('unexpected-response', (_r, res) => bail(res.statusCode === 401 ? 'tunnel auth rejected' : `tunnel HTTP ${res.statusCode} — SSH session did not open; command did not run`))
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
    if ('json' in flags) return console.log(JSON.stringify({ keys }))
    if (!keys.length) return console.log('no keys registered — `npx weeny-cloud ssh` sets one up')
    for (const k of keys) console.log(`${k.id}  ${k.label ?? ''}  ${k.preview}  (${k.createdAt})`)
    console.log(`\nrevoke one: npx weeny-cloud keys --revoke <id>`)
  },

  // Everything you can reach: your apps + apps shared with you (weeny allow).
  async apps() {
    const r = await call('/api/apps/reachable')
    if ('json' in flags) return console.log(JSON.stringify(r))
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
    let path
    try { path = await installSkill(ENV, SELF) } catch (error) { die(error.message) }
    if (!ENV.production) return console.log(`✓ staged skill → ${path}\nAsk your test agent to read this file. Your production agent skills were not changed.`)
    console.log(`✓ installed the weeny skill → ${path}
Your Claude Code now knows how to deploy to weeny. Try: "deploy this app to weeny".`)
  },

  async help() {
    const topic = positionals[0]
    if (Object.hasOwn(HELP, topic)) return console.log(HELP[topic])
    if (topic) console.log(`no help for '${topic}' — the commands:`)
    commandList()
  },
}

const HELP = {
  onboarding: onboardingHelp,
  feedback: feedbackHelp('npx weeny-cloud feedback'),
  login: `npx weeny-cloud login [--email x@y.com] [--code 123456]

Sign in with your email — Weeny.Cloud sends a 6-digit code.
After signup, the server reports current availability and terms.
Non-interactive (for agents): pass --email first, then re-run with --email + --code.
The code lands in the human's inbox — unless you already have access to their emails,
stop and ask them to provide the code.
Configuration: ${CREDS}
If this folder is not writable (EPERM/EACCES), select a private writable profile and retry.
PowerShell: $env:WEENY_CONFIG_DIR = Join-Path $env:LOCALAPPDATA 'Weeny'
Use a separate folder for staging. Keep the same override in subsequent terminals.
This does not move an existing account; sign in again in the new profile.
Sign out and revoke this token: npx weeny-cloud logout
Offline only: logout --local removes the local copy without revoking it.`,
  create: `npx weeny-cloud create [--name NAME --tier teeny|weeny|meany] [--json]

Pass --name and --tier to buy a named server. Open the checkout link to
review and pay. Retry with the same name to find that purchase or server.

New builder signup needs a brief profile first. Agents can complete it from existing
project context: npx weeny-cloud onboarding --project "Project purpose and hosting need".
Unknown discovery is valid. See: npx weeny-cloud help onboarding

Provision your server (~2 min): a real Linux box — root, SSH, systemd. Uses your SSH
key (generates ~/.ssh/weeny_ed25519 if you have none). The server selects the
best eligible current offer, or saves a waitlist request. Check availability and
terms with bare npx weeny-cloud or at ${API}/dashboard/start.
Bare create uses the first-server offers. A card-required trial needs review in
the dashboard. List and pick servers with npx weeny-cloud server status.
Use server status, resume, suspend, rebuild or delete; disruptive actions need --confirm.`,
  push: `npx weeny-cloud push [folder] [app-name] [--server SERVER] [--build "<cmd>"] [--health "<cmd>"] [--stop "<cmd>"] [--startup-timeout <seconds>] [--port PORT|auto] [--origin-route ROUTE] [--tag "<text>"] [--all] [-- <start command>]

Deploy a local folder to your server as a new release (name defaults to the folder's).
First push needs the start command: end the line with \`-- <command>\`; a build step is
your call too (\`--build "npm ci && npm run build"\`). After that, bare
\`npx weeny-cloud push ./myapp\` re-deploys with the remembered commands — but keep
passing the app name whenever it differs from the folder's (the name is inferred from
the folder otherwise).

On a multi-server account, pass the destination name or ID with --server.
Each push builds in a fresh release while the current app serves. It then stops the
app, switches releases and starts the new process. A failed startup restores the
previous release. Use separate ports and weeny-cloud expose for a live traffic handoff.
The upload skips .git and node_modules;
respects .gitignore (--all to override). Rollback: weeny rollback <app> on the server.
--startup-timeout <seconds> sets the total server readiness deadline (default 30).
--stop "<cmd>" adds synchronous cleanup for external workloads; keep it idempotent.
Both settings are remembered per release. Use --stop none or --startup-timeout none
to reset them. Requires an updated server CLI; start commands stay in the foreground.`,
  ssh: `npx weeny-cloud ssh [--server SERVER] [ssh-options] [--] [command]

Open a shell on your server — or run one command and return. Uses the right key and IP
so it always works. Your apps live in /apps, their data in /data.
On a multi-server account, pass a name or ID with --server before the command.
Sleeping free servers wake automatically for push or ssh; suspended servers do not.
No SSH key on this device (new laptop, wiped machine)? No problem — as long as you're
signed in, ssh generates and registers a fresh device key automatically.

The CLI explicitly passes its generated configuration: ${SSH_CONFIG}
An alias like weeny-<id> is a local SSH-config entry, not a public DNS hostname.
If a plain ssh command cannot resolve it, use this CLI or pass -F with that config.
On Windows, Get-Command ssh -All shows competing Windows/Git installations.
Inspect the selected entry without connecting: ssh -G -F "${SSH_CONFIG}" <alias>
Do not delete your keys or disable host checking to fix config discovery.`,
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
push code, start apps, expose URLs, env vars, domains, private links.
Run again to refresh the guide, then re-read it in your agent. This does not update
the server CLI. Normal commands check for guide updates before running, at most
daily, with a three-second timeout. Offline checks do not fail the command.`,
}

Object.assign(HELP, {
  app: `weeny-cloud app create APP [--server SERVER] [--json]\nRegister an app before its first deploy.`,
  route: `weeny-cloud route list [--json]
weeny-cloud route create NAME [--private] [--health-path PATH] [--json]
weeny-cloud route inspect NAME [--json]
weeny-cloud route set-backends NAME --backend SERVER/APP [--backend SERVER/APP ...]
weeny-cloud route clear NAME
weeny-cloud route access NAME --public | --private [--allow EMAIL] [--domain DOMAIN]
weeny-cloud route status OPERATION_ID [--json]
weeny-cloud route delete NAME

Create reserves a URL without a backend. Pass --origin-route NAME on push to
configure the app before its build. Set the full backend list to send traffic.
Clear drains the backends and keeps the hostname. Delete releases the hostname.`,
  expose: `weeny-cloud expose HOST [--backend SERVER:PORT ... | --clear] [--health-path PATH] [--no-wait] [--json]
weeny-cloud expose status ID [--json]

Inspect an HTTPS URL you own. To change where it sends traffic, give the entire
backend list. From the developer machine or CI, use names from server status.
Backends can use different ports on the same server. Health checks default to /.
The command waits for removed backends to finish serving existing requests.
Use --no-wait --json to start a change and expose status to poll the operation.
Check safeToRestart before stopping a removed backend.

On a server, use weeny expose APP PORT to publish a local app.`,
  server: `weeny-cloud server status|resume|suspend|rebuild|delete|retire|cancel-renewal [--server SERVER] [--confirm] [--wait] [--json]
For retire or cancel-renewal, preview first and pass the approved --quote with --confirm.

Status does not wake a sleeping server. Resume wakes sleeping/suspended servers.
Suspend takes all apps offline. Rebuild restores the latest snapshot, potentially
losing newer changes. Delete destroys all data. These disruptive actions require
specific human approval and --confirm. Commands return immediately; --wait polls
for completion for up to ten minutes. Inspect status before retrying an action.`,
  widget: `weeny-cloud widget APP [--id SERVER_ID] [--position bottom] [--branding on|off] [--json]

Read or change appearance through the owner API, without waking the server.
Positions: top-left, top, top-right, right, bottom-right, bottom, bottom-left, left.
Free apps require the built with weeny badge; paid/trial apps can remove it.`,
  tier: `weeny-cloud tier [NAME] [--server SERVER] [--preview|--confirm --monthly-usd AMOUNT --quote QUOTE] [--force] [--json]
weeny-cloud tier status ID [--json]

Preview billing and downtime, then pass --monthly-usd and --quote from the
human-approved preview, or use interactive confirmation.
A changed price needs renewed approval. --force explicitly overrides a downgrade
memory warning. The human chooses spending. Checkout still requires payment.`,
  billing: `weeny-cloud billing [status|portal|end-trial [--confirm] [--reason TEXT]|cancel-checkout [--id PURCHASE_ID]|checkout TIER --confirm [--direct-paid]] [--json]

Return plans, a portal link for invoices/payment/cancellation, or a checkout link
for the human's chosen tier. --direct-paid buys a first paid server without a trial.
Preparing a link does not pay. Existing subscribers change size through tier.

end-trial asks for optional feedback, then confirms the immediate end of a
card-required trial. Press Enter to skip feedback. For agents and JSON mode,
ask the human first and pass --confirm after approval. Use --reason for their
reason or an issue you observed.

cancel-checkout cancels the open unpaid checkout and preserves your waitlist place
and existing server. No browser or extra confirmation flag is needed. --id selects
a particular purchase for retries; completed purchases are protected by the API.
No open checkout returns cancelled:false in JSON. This does not cancel a paid
subscription. Free requests still need capacity; retry npx weeny-cloud create.`,
  logout: `weeny-cloud logout [--local] [--json]

Revoke this account token, then remove its local credentials. Other sessions and
SSH keys stay active. --local works offline but leaves the token valid on the server.`,
})

const account = accountCommands({ call, loadCreds, ask, interactive: !!process.stdin.isTTY, fromEnv: !!CI_CREDS,
  clearCredentials: () => rmSync(CREDS, { force: true }) })
try {
// Never put notices or optional work in CI, the explicit installer, or SSH's byte relay.
if (!wantsHelp && !jsonOutput && !process.env.CI && !CI_CREDS && cmd !== 'skill' && !cmd?.startsWith('_')) await maybeCheckUpdates(ENV, SELF)
try {
  if (!wantsHelp && resourceNoticesAllowed(process.argv.slice(2))) await maybeShowResourceNotices(ENV, loadCreds())
} catch {} // Credential loading is optional here too; the command handles its own errors.
const SERVER_WORDS = new Set(['deploy', 'start', 'stop', 'restart', 'releases', 'rollback', 'deployments', 'inspect', 'expose', 'unexpose', 'remove', 'env', 'domain', 'allow', 'revoke', 'health'])
const OLD_TO_NEW = { run: 'deploy', rm: 'remove', list: '', ls: '', access: 'allow', guide: 'help' }
const LINUX_HINT = { logs: 'journalctl -u weeny-APP -f' }
if (wantsHelp) {
  if (['help','--help','-h'].includes(command)) await commands.help()
  else {
    if (!Object.hasOwn(HELP, command)) die(`No help for ${cmd}. Run weeny-cloud help.`)
    console.log(HELP[command])
  }
}
else if (!cmd) await orient()
else if (cmd === 'whoami') await orient().catch(() => commandList())
else if (Object.hasOwn(account, command)) {
  const outcome = await account[command](argv)
  if (outcome === 1) process.exitCode = 1
}
else if (Object.hasOwn(commands, command)) await commands[command]()
else if (SERVER_WORDS.has(cmd) || Object.hasOwn(OLD_TO_NEW, cmd) || Object.hasOwn(LINUX_HINT, cmd)) {
  const app = process.argv[3] && !process.argv[3].startsWith('-') ? process.argv[3] : '<app>'
  if (Object.hasOwn(LINUX_HINT, cmd)) {
    console.error(`${cmd} is bare Linux on your server — apps are systemd units named weeny-<app>:\n`)
    console.error(`  npx weeny-cloud ssh "${LINUX_HINT[cmd].replace('APP', app)}"\n`)
  } else {
    const word = Object.hasOwn(OLD_TO_NEW, cmd) ? OLD_TO_NEW[cmd] : cmd
    const line = ['weeny', word, ...process.argv.slice(3)].filter(Boolean).join(' ')
    console.error(`\`${['weeny', word].filter(Boolean).join(' ')}\` runs ON YOUR SERVER, not on your laptop. Go there:\n`)
    console.error(`  npx weeny-cloud ssh "${line}"\n`)
    console.error(`(bare \`weeny\` on the server explains all its commands)`)
  }
  process.exit(1)
}
else { console.error(`unknown command: ${cmd}\n`); commandList(); process.exit(1) }
} catch (error) {
  die(error.message ?? String(error))
}
