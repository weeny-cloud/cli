import { getProxyForUrl } from 'proxy-from-env'

function proxySetting(protocol) {
  return protocol === 'https:'
    ? process.env.https_proxy || process.env.HTTPS_PROXY
    : process.env.http_proxy || process.env.HTTP_PROXY
}

function proxyFor(url) {
  const destination = new URL(url)
  // Use the same HTTPS proxy and exclusions for the API and the secure SSH relay.
  if (destination.protocol === 'wss:') destination.protocol = 'https:'
  if (destination.protocol === 'https:' && !proxySetting('https:')) {
    // Match Node's HTTP_PROXY fallback without changing the NO_PROXY port match.
    const port = destination.port || '443'
    destination.protocol = 'http:'
    destination.port = port
  }
  if (!proxySetting(destination.protocol)) return null
  const selected = getProxyForUrl(destination)
  if (!selected) return null
  try {
    const proxy = new URL(selected)
    if (proxy.protocol === 'http:' || proxy.protocol === 'https:') return proxy
  } catch {}
  throw new Error('Invalid proxy configuration. Use an http:// or https:// proxy URL in HTTPS_PROXY or HTTP_PROXY.')
}

function proxyOptions(proxy) {
  const username = decodeURIComponent(proxy.username)
  const password = decodeURIComponent(proxy.password)
  const uri = new URL(proxy.href)
  uri.username = ''
  uri.password = ''
  const authorization = username || password
    ? 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64')
    : undefined
  return { uri: uri.href, authorization }
}

let transport
async function fetchTransport() {
  if (transport) return transport
  let undici
  try { undici = await import('undici') } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error
    return null
  }
  if (transport) return transport
  const { Agent, ProxyAgent, fetch: request } = undici
  // Resolve each origin separately, including origins reached by redirects.
  const direct = new Agent()
  const proxies = new Map()
  const dispatcher = {
    dispatch(options, handler) {
      const proxy = proxyFor(options.origin)
      if (!proxy) return direct.dispatch(options, handler)
      if (!proxies.has(proxy.href)) {
        const { uri, authorization } = proxyOptions(proxy)
        proxies.set(proxy.href, new ProxyAgent({ uri, token: authorization }))
      }
      return proxies.get(proxy.href).dispatch(options, handler)
    },
  }
  transport = { request, dispatcher }
  return transport
}

export async function proxyFetch(url, options) {
  if (!proxySetting('https:') && !proxySetting('http:')) return fetch(url, options)
  const proxy = proxyFor(url)
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (major === 18 && minor < 17) {
    if (proxy) throw new Error('Using a proxy for Weeny API calls requires Node.js 18.17 or later.')
    return fetch(url, options)
  }
  const fetchWithProxy = await fetchTransport()
  if (!fetchWithProxy) {
    if (!proxy) return fetch(url, options)
    throw new Error('Proxying Weeny API calls requires the optional undici dependency. Reinstall weeny-cloud with optional dependencies.')
  }
  try {
    return await fetchWithProxy.request(url, { ...options, dispatcher: fetchWithProxy.dispatcher })
  } catch (error) {
    if (!proxy || options?.signal?.aborted) throw error
    const hostname = new URL(url).hostname
    throw new Error(`Could not reach ${hostname} through the configured proxy. Check your proxy settings.`)
  }
}

export async function webSocketProxyAgent(url) {
  const proxy = proxyFor(url)
  if (!proxy) return undefined
  const { HttpsProxyAgent } = await import('https-proxy-agent')
  const { uri, authorization } = proxyOptions(proxy)
  return new HttpsProxyAgent(uri, { headers: authorization ? { 'Proxy-Authorization': authorization } : undefined })
}
