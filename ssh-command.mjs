// OpenSSH on Windows launches ProxyCommand with Windows argument rules; Unix
// single quotes and the `env` program cannot be used there.
export function proxyCommand(args, platform = process.platform) {
  return args.map(value => {
    const text = String(value)
    if (/[\r\n\0]/.test(text)) throw new Error('SSH relay arguments cannot contain line breaks or NUL')
    // OpenSSH expands percent tokens before launching the command.
    const escaped = text.replaceAll('%', '%%')
    if (platform !== 'win32') return `'${escaped.replace(/'/g, `'\\''`)}'`
    return '"' + escaped.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"'
  }).join(' ')
}
