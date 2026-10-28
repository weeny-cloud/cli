import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'

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
  if (!production && (dir === base || dir === join(home, '.ssh') || dir === home)) throw new Error('Staging needs its own configuration directory')
  return { api, dir, production, sshDir: production ? join(home, '.ssh') : join(dir, 'ssh') }
}

export function credentialsForOrigin(creds, environment) {
  if (!creds) return null
  if (creds.apiBase === environment.api || (!creds.apiBase && environment.production)) return creds
  throw new Error('Saved credentials belong to another API. Use a separate WEENY_CONFIG_DIR and log in again.')
}
