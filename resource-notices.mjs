// Optional account health notices. No message queue or acknowledgement protocol.
import { readFileSync, writeFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
const read = path => { try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return {} } }
export function resourceNoticesAllowed(argv, env = process.env) {
  const cmd = argv[0] ?? ''
  return !env.CI && !env.WEENY_TOKEN && !argv.includes('--json') && !cmd.startsWith('_') &&
    !['ssh', 'exec', 'keys', 'token', 'login', 'logout', 'help', '--help', '-h', 'skill', 'feedback'].includes(cmd)
}
export async function maybeShowResourceNotices(environment, credentials, { now = Date.now(), fetchImpl = fetch, notify = console.error } = {}) {
  if (!credentials?.token) return
  const id = createHash('sha256').update(environment.api + '\0' + credentials.token).digest('hex').slice(0, 20)
  const path = join(environment.dir, `resource-notices-${id}.json`), lock = path + '.lock'
  const save = state => {
    const tmp = path + '.' + randomUUID()
    try { writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 }); renameSync(tmp, path) }
    finally { rmSync(tmp, { force: true }) }
  }
  let locked = false
  try {
    mkdirSync(environment.dir, { recursive: true, mode: 0o700 })
    try { mkdirSync(lock); locked = true } catch {
      try { if (now - statSync(lock).mtimeMs > 30_000) { rmSync(lock, { recursive: true, force: true }); mkdirSync(lock); locked = true } } catch {}
      if (!locked) return
    }
    const state = read(path)
    if (Number.isFinite(state.checkedAt) && now >= state.checkedAt && now - state.checkedAt < 60_000) return
    save({ ...state, checkedAt: now }) // Offline/old control also backs off.
    const response = await fetchImpl(environment.api + '/api/resource-alerts', {
      headers: { Authorization: `Bearer ${credentials.token}` }, redirect: 'error', signal: AbortSignal.timeout(1000),
    })
    if (!response.ok) return
    const data = await response.json(), shown = state.shown ?? {}, nextShown = {}
    if (!Array.isArray(data.alerts)) return
    let count = 0
    for (const alert of data.alerts.slice(0, 30)) {
      if (typeof alert.id !== 'string' || typeof alert.summary !== 'string' || typeof alert.advice !== 'string') continue
      const key = JSON.stringify([alert.id, alert.severity, alert.recommendation])
      const last = shown[key]
      nextShown[key] = last
      if (count >= 2 || Number.isFinite(last) && now >= last && now - last < 3600_000) continue
      const clean = text => String(text ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 2000)
      notify(`[Weeny resource alert] ${clean(alert.machineName)}: ${clean(alert.summary)}\n${clean(alert.advice)} ${clean(alert.alternative)}`)
      nextShown[key] = now
      count++
    }
    save({ checkedAt: now, shown: nextShown })
  } catch {} // Never turn a healthy operation into a failure or contaminate stdout.
  finally { if (locked) try { rmSync(lock, { recursive: true, force: true }) } catch {} }
}
