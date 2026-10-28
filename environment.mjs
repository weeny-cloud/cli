import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'

export function cliEnvironment(env = process.env, home = homedir()) {
  const url = new URL(env.WEENY_API || 'https://weeny.cloud')
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('WEENY_API must be an origin, without credentials or a path')
  const api = url.origin
  const production = api === 'https://weeny.cloud'
  const local = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (!production && !local && (url.protocol !== 'https:' || !url.hostname.startsWith('staging.')))
    throw new Error('Non-production WEENY_API must use HTTPS on a staging hostname (or local HTTP for tests)')
  if (env.WEENY_ENV === 'staging' && production) throw new Error('Staging refuses the production API')
  if (env.WEENY_ENV && !['staging', 'production'].includes(env.WEENY_ENV)) throw new Error('WEENY_ENV must be staging or production')
  if (env.WEENY_ENV === 'production' && !production) throw new Error('Production mode refuses a staging API')
  const base = join(home, '.weeny')
  const dir = env.WEENY_CONFIG_DIR ? resolve(env.WEENY_CONFIG_DIR) : production ? base
    : join(base, 'environments', createHash('sha256').update(api).digest('hex').slice(0, 16))
  const canonical = p => existsSync(p) ? realpathSync(p) : p
  if (!production && [base, home, '/', join(home, '.ssh'), join(home, '.claude'), join(home, '.codex')].some(p => canonical(dir) === canonical(p)))
    throw new Error('Staging needs its own configuration directory')
  return { api, dir, production, sshDir: production && !env.WEENY_CONFIG_DIR ? join(home, '.ssh') : join(dir, 'ssh') }
}

export function credentialsForOrigin(creds, environment) {
  if (!creds) return null
  if (creds.apiBase === environment.api || (!creds.apiBase && environment.production)) return creds
  throw new Error('Saved credentials belong to another API. Use a separate WEENY_CONFIG_DIR and log in again.')
}

// Explicit, noninteractive deployment credentials. Never persist the token or
// enroll a new SSH device from a CI run; prepare/revoke that key separately.
export function credentialsFromEnv(env, environment) {
  if (!env.WEENY_TOKEN) return null
  if (!/^weeny_[A-Za-z0-9_-]{20,}$/.test(env.WEENY_TOKEN)) throw new Error('Invalid WEENY_TOKEN')
  if (!env.WEENY_SSH_KEY_FILE || !env.WEENY_KNOWN_HOSTS_FILE)
    throw new Error('WEENY_TOKEN requires a pre-enrolled WEENY_SSH_KEY_FILE and pinned WEENY_KNOWN_HOSTS_FILE')
  return { token: env.WEENY_TOKEN, apiBase: environment.api, keyPath: resolve(env.WEENY_SSH_KEY_FILE),
    knownHosts: resolve(env.WEENY_KNOWN_HOSTS_FILE) }
}
