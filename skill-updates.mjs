import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, renameSync, rmSync, rmdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const DAY = 24 * 60 * 60 * 1000
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

async function fetchSkill(env, fetchImpl, timeoutMs) {
  // No credentials or redirects: the guide is public and stays on the selected origin.
  const response = await fetchImpl(`${env.api}/weeny-skill.md`, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok || !response.body) throw new Error('could not fetch the skill')
  const reader = response.body.getReader(), chunks = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.length
      if (length > 256 * 1024) throw new Error('skill response is too large')
      chunks.push(value)
    }
  } finally { await reader.cancel().catch(() => {}) }
  const source = Buffer.concat(chunks).toString('utf8')
  const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1]
  if (!frontmatter || !/^name:\s*weeny\s*$/m.test(frontmatter)) throw new Error('invalid weeny skill response')
  return source
}

function options(env, cliPath, home) {
  return { ...env, cliPath, skill: skillPath(env, home), cache: join(env.dir, 'skill-update.json'),
    lock: join(env.dir, 'skill-update.lock'), renderer: env.production ? 'production' : cliPath }
}
function readState(opts) {
  const state = readJson(opts.cache)
  return state?.api === opts.api && state.renderer === opts.renderer ? state : {}
}

export async function installSkill(env, cliPath, { home, fetchImpl = fetch, now = Date.now() } = {}) {
  const opts = options(env, cliPath, home)
  const source = await fetchSkill(env, fetchImpl, 10000)
  const skill = renderSkill(source, env, cliPath), installedHash = hash(skill), sourceHash = hash(source)
  atomicWrite(opts.skill, skill, 0o644)
  // The guide is usable even if the optional update cache is unwritable.
  try { save(opts.cache, { api: opts.api, renderer: opts.renderer, installedAt: now, installedHash, sourceHash,
    latestHash: installedHash, latestSourceHash: sourceHash, checkedAt: now, notifiedAt: 0 }) } catch {}
  return opts.skill
}

export async function maybeCheckSkillUpdate(env, cliPath, { home, now = Date.now(), notify = console.error, fetchImpl = fetch } = {}) {
  const opts = options(env, cliPath, home)
  let locked = false
  try {
    // Missing skills do not need a check or a profile directory.
    readFileSync(opts.skill)
    mkdirSync(env.dir, { recursive: true, mode: 0o700 })
    try { mkdirSync(opts.lock) }
    catch (error) {
      if (error.code !== 'EEXIST' || now - statSync(opts.lock).mtimeMs < 60000) return
      rmdirSync(opts.lock); mkdirSync(opts.lock)
    }
    locked = true
    // Read under the lock so concurrent commands cannot duplicate requests or notices.
    let state = readState(opts)
    if (!Number.isFinite(state.checkedAt) || now < state.checkedAt || now - state.checkedAt >= DAY) {
      // Claim the daily attempt before fetching, including failed/offline attempts.
      const checkId = randomUUID()
      state = { ...state, api: opts.api, renderer: opts.renderer, checkedAt: now, checkId }
      save(opts.cache, state)
      let source
      try { source = await fetchSkill(env, fetchImpl, 3000) } catch {}
      state = readState(opts)
      // An explicit refresh may have completed while this older request was in flight.
      if (state.checkId !== checkId) return
      if (source) {
        state = { ...state, latestHash: hash(renderSkill(source, env, cliPath)), latestSourceHash: hash(source) }
        save(opts.cache, state)
      }
    }
    // Legacy installs have no metadata: compare their actual bytes with the fetched guide.
    const installedHash = hash(readFileSync(opts.skill))
    const differs = state.latestHash && installedHash !== state.latestHash
      && (!state.sourceHash || state.sourceHash !== state.latestSourceHash)
    const notifiedAt = Number.isFinite(state.notifiedAt) && state.notifiedAt <= now ? state.notifiedAt : 0
    if (differs && (!notifiedAt || now - notifiedAt >= DAY)) {
      state.notifiedAt = now
      save(opts.cache, state)
      notify(`Weeny guide update available — run ${skillCommand(env, cliPath)} skill, then re-read ${opts.skill}. This updates the guide, not the server CLI.`)
    }
  } catch {} // Missing skills, read-only profiles and corrupt caches stay quiet.
  finally { if (locked) { try { rmdirSync(opts.lock) } catch {} } }
}
