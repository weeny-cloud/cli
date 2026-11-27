// Proxy-specific tests opt in with their own child environment.
for (const name of ['http_proxy', 'https_proxy', 'no_proxy', 'all_proxy', 'node_use_env_proxy']) {
  delete process.env[name]
  delete process.env[name.toUpperCase()]
}
