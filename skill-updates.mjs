import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { trySkillLock, releaseSkillLock } from './skill-lock.mjs'

const DAY = 24 * 60 * 60 * 1000
const CURRENT_VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version
const LATEST_CLI_URL = 'https://registry.npmjs.org/weeny-cloud/latest'
const hash = text => createHash('sha256').update(text).digest('hex')
const quote = value => `'${String(value).replace(/'/g, `'\\''`)}'`
const readJson = path => { try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return {} } }

function atomicWrite(path, text, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.${randomUUID()}.tmp`
  try { writeFileSync(tmp, text, { mode }); renameSync(tmp, path) }
  finally { rmSync(tmp, { force: true }) }
}
const save = (path, state) => atomicWrite(path, JSON.stringify(state, null, 2))

export function skillPath(env, home = homedir()) {
  return env.production ? join(home, '.claude', 'skills', 'weeny', 'SKILL.md')
    : join(env.dir, 'skills', 'weeny', 'SKILL.md')
}

export function skillCommand(env, cliPath) {
  return env.production ? 'npx weeny-cloud@latest'
    : ['env', 'WEENY_ENV=staging', `WEENY_API=${env.api}`, `WEENY_CONFIG_DIR=${env.dir}`, process.execPath, cliPath].map(quote).join(' ')
}

export function renderSkill(source, env, cliPath) {
  return env.production ? source : source.replaceAll('npx weeny-cloud', skillCommand(env, cliPath))
    .replaceAll('https://weeny.cloud', env.api)
}

async function fetchPublicText(url, fetchImpl, timeoutMs, maxBytes) {
  // Public metadata only: no credentials, redirects or unbounded response bodies.
  const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok || !response.body) throw new Error('could not fetch update metadata')
  const reader = response.body.getReader(), chunks = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.length
      if (length > maxBytes) throw new Error('update response is too large')
      chunks.push(value)
    }
  } finally { await reader.cancel().catch(() => {}) }
  return Buffer.concat(chunks).toString('utf8')
}

async function fetchSkill(env, fetchImpl, timeoutMs) {
  const source = await fetchPublicText(`${env.api}/weeny-skill.md`, fetchImpl, timeoutMs, 256 * 1024)
  const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1]
  if (!frontmatter || !/^name:\s*weeny\s*$/m.test(frontmatter)) throw new Error('invalid weeny skill response')
  return source
}

// npm's latest stable version is compared numerically, never lexicographically.
// Invalid/prerelease metadata cannot produce a command or an upgrade notice.
function versionParts(version) {
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) return null
  const parts = version.split('.').map(Number)
  return parts.every(Number.isSafeInteger) ? parts : null
}
function newerVersion(latest, current) {
  const next = versionParts(latest), installed = versionParts(current)
  if (!next || !installed) return false
  for (let i = 0; i < 3; i++) {
    if (next[i] !== installed[i]) return next[i] > installed[i]
  }
  return false
}
async function fetchCliVersion(fetchImpl) {
  const metadata = JSON.parse(await fetchPublicText(LATEST_CLI_URL, fetchImpl, 3000, 64 * 1024))
  if (metadata.name !== 'weeny-cloud' || !versionParts(metadata.version)) throw new Error('invalid CLI version metadata')
  return metadata.version
}

function options(env, cliPath, home) {
  return { ...env, skill: skillPath(env, home), cache: join(env.dir, 'skill-update.json'),
    renderer: env.production ? 'production' : cliPath }
}
function readState(opts) {
  const state = readJson(opts.cache)
  return state?.api === opts.api && state.renderer === opts.renderer ? state : {}
}

async function lockForInstall(opts) {
  const deadline = Date.now() + 5000
  while (true) {
    const lock = trySkillLock(opts.dir)
    if (lock) return lock
    if (Date.now() >= deadline) throw Object.assign(new Error('another skill operation is still running; retry the skill command'), { code: 'EBUSY' })
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

export async function installSkill(env, cliPath, { home, fetchImpl = fetch, now = Date.now() } = {}) {
  const opts = options(env, cliPath, home)
  const source = await fetchSkill(env, fetchImpl, 10000)
  const skill = renderSkill(source, env, cliPath), installedHash = hash(skill), sourceHash = hash(source)
  let lock
  try {
    try { lock = await lockForInstall(opts) }
    catch (error) { if (!['EACCES', 'EPERM', 'EROFS'].includes(error.code)) throw error }
    atomicWrite(opts.skill, skill, 0o644)
    // Cache commits share the check's lock. An unwritable cache never prevents installation.
    if (lock) try { save(opts.cache, { cli: readState(opts).cli, api: opts.api, renderer: opts.renderer, installedAt: now, installedHash, sourceHash,
      latestHash: installedHash, latestSourceHash: sourceHash, checkedAt: now, notifiedAt: 0 }) } catch {}
  } finally { releaseSkillLock(lock) }
  return opts.skill
}

export async function maybeCheckUpdates(env, cliPath, { home, now = Date.now(), notify = console.error, fetchImpl = fetch, currentVersion = CURRENT_VERSION } = {}) {
  const opts = options(env, cliPath, home)
  const installedSkill = () => { try { return readFileSync(opts.skill) } catch { return null } }
  const due = timestamp => !Number.isFinite(timestamp) || now < timestamp || now - timestamp >= DAY
  const checkGuide = !!installedSkill()
  // Unpublished staging candidates must not be redirected to a production npm CLI.
  const checkCli = env.production && !!versionParts(currentVersion)
  if (!checkGuide && !checkCli) return
  let lock
  try {
    lock = trySkillLock(opts.dir, { now })
    if (!lock) return
    // Both nudges share the same lock, cache and daily failed-attempt backoff.
    let state = readState(opts)
    let cli = state.cli && typeof state.cli === 'object' && !Array.isArray(state.cli) ? state.cli : {}
    const guideDue = checkGuide && due(state.checkedAt), cliDue = checkCli && due(cli.checkedAt)
    if (guideDue || cliDue) {
      const checkId = randomUUID()
      state = { ...state, api: opts.api, renderer: opts.renderer, checkId,
        ...(guideDue ? { checkedAt: now } : {}),
        cli: { ...cli, ...(cliDue ? { checkedAt: now } : {}) } }
      save(opts.cache, state)
      // Fetch together so two optional checks still have a single three-second wait.
      const [guide, latest] = await Promise.all([
        guideDue ? fetchSkill(env, fetchImpl, 3000).catch(() => null) : null,
        cliDue ? fetchCliVersion(fetchImpl).catch(() => null) : null,
      ])
      state = readState(opts)
      if (state.checkId !== checkId) return
      if (guide) state = { ...state, latestHash: hash(renderSkill(guide, env, cliPath)), latestSourceHash: hash(guide) }
      if (latest) state = { ...state, cli: { ...state.cli, latestVersion: latest } }
      if (guide || latest) save(opts.cache, state)
    }
    // Legacy installs have no metadata: compare their actual bytes with the guide.
    const installed = checkGuide && installedSkill()
    const differs = installed && state.latestHash && hash(installed) !== state.latestHash
      && (!state.sourceHash || state.sourceHash !== state.latestSourceHash)
    if (differs && (!state.notifiedAt || due(state.notifiedAt))) {
      state.notifiedAt = now
      save(opts.cache, state)
      notify(`Weeny guide update available — run ${skillCommand(env, cliPath)} skill, then re-read ${opts.skill}. This updates the guide, not the server CLI.`)
    }
    cli = state.cli ?? {}
    if (checkCli && newerVersion(cli.latestVersion, currentVersion) && (!cli.notifiedAt || due(cli.notifiedAt))) {
      state.cli = { ...cli, notifiedAt: now }
      save(opts.cache, state)
      notify(`Weeny CLI update available: ${currentVersion} → ${cli.latestVersion}. Use npx weeny-cloud@latest <command> for subsequent commands.`)
    }
  } catch {} // Offline checks, read-only profiles and corrupt caches never block work.
  finally { releaseSkillLock(lock) }
}
