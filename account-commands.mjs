export const accountValueOptions = {
  expose: ['health-path', 'backend'],
  server: ['id', 'server', 'quote'],
  widget: ['id', 'position', 'branding'],
  billing: ['id', 'reason'],
  tier: ['monthly-usd', 'quote', 'server'],
}

export function parseOptions(argv, valued = [], boolean = [], repeated = []) {
  const options = {}, args = []
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i]
    if (!word.startsWith('-')) { args.push(word); continue }
    const key = word.slice(2)
    if (!word.startsWith('--') || !['json', ...boolean, ...valued, ...repeated].includes(key))
      throw new Error(`Unknown option ${word}`)
    if (valued.includes(key) || repeated.includes(key)) {
      if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw new Error(`--${key} needs a value`)
      const value = argv[++i]
      if (['server','id'].includes(key) && !value.trim()) throw new Error(`--${key} needs a name or ID`)
      if (repeated.includes(key)) (options[key] ??= []).push(value)
      else options[key] = value
    } else {
      options[key] = true
    }
  }
  return { args, options }
}

export function selectMachine(all, server, { idOnly = false } = {}) {
  if (server !== undefined) {
    if (!server.trim()) throw new Error('--server needs a name or ID')
    const matches = all.filter(m => m.id === server || (!idOnly && m.name === server))
    if (matches.length === 1) return matches[0]
    if (matches.length > 1) throw new Error(`Ambiguous server: ${server}. Check weeny-cloud server status for server IDs and names.`)
    throw new Error(`No such server: ${server}`)
  }
  const current = all.filter(m => !['failed','deleted'].includes(m.status))
  if (current.length === 1) return current[0]
  if (!current.length) throw new Error('No server yet. Run npx weeny-cloud create.')
  throw new Error(`Pass --server with one of: ${current.map(m => m.name).join(', ')}`)
}

export function accountCommands({ call, loadCreds, clearCredentials, ask, interactive, fromEnv,
  output = console.log, progress = console.error, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const parse = parseOptions
  const emit = (value, options, text) => output(options.json ? JSON.stringify(value) : text)
  const machines = async () => (await call('/api/machines')).machines
  const select = (available, options) => selectMachine(available, options.id ?? options.server, { idOnly: options.id !== undefined })
  const waitForServer = async (id, expected) => {
    const until = Date.now() + 10 * 60_000
    for (;;) {
      const current = (await machines()).find(x => x.id === id)
      const status = current?.status ?? 'deleted'
      if (status === expected) return { id, status }
      if (['failed','deleted'].includes(status)) throw new Error(`Server operation failed: ${current?.error || status}`)
      if (Date.now() >= until) throw new Error(`Server is still ${status}; inspect server status before retrying the action`)
      await sleep(5000)
    }
  }
  const publicMachine = ({ id, name, status, tier, diskMb, note, error, apps, health, alerts, host, sharedHost, billing }) => ({
    id, name, status, tier, diskMb, note, error, apps, health, alerts, host, sharedHost, billing,
  })
  const routeSummary = route => [
    `${route.hostname}: ${route.state}`,
    `Requested: ${route.requested.join(', ') || 'none'}`,
    `New traffic: ${route.serving === null ? 'unknown' : route.serving.join(', ') || 'none'}`,
    `Draining: ${route.draining.join(', ') || 'none'}`,
    ...(route.safeToRestart?.length ? [`Safe to restart for this URL: ${route.safeToRestart.join(', ')}`] : []),
    ...(route.error ? [route.error] : []),
  ].join('\n')
  const routeStatus = id => call(`/api/https-routes/operations/${encodeURIComponent(id)}`)
  const failedRoute = route => ['failed', 'superseded'].includes(route.state)
  const completedRoute = route => route.state === 'complete' || failedRoute(route)
  const readRoute = (route, options) => {
    emit(route, options, routeSummary(route))
    return route.state === 'complete' ? undefined : 1
  }
  const setRoute = async (path, route, options, command) => {
    let operation = await call(path, { method: 'PUT', body: {
      revision: route.revision, backends: options.clear ? [] : options.backend, healthPath: options['health-path'],
    } })
    const statusCommand = `npx weeny-cloud ${command} status ${operation.id}`
    if (options['no-wait']) {
      emit(operation, options, `${operation.state}. Check with ${statusCommand}`)
      return failedRoute(operation) ? 1 : undefined
    }
    progress(`Operation ${operation.id}. Check with ${statusCommand}`)
    const until = Date.now() + 5 * 60_000
    let printed
    while (!completedRoute(operation) && Date.now() < until) {
      const line = routeSummary(operation)
      if (printed !== line) { progress(line); printed = line }
      await sleep(1000)
      operation = await routeStatus(operation.id)
    }
    if (!completedRoute(operation)) progress(`Still running. Continue with ${statusCommand}`)
    return readRoute(operation, options)
  }
  return {
    async expose(argv) {
      const { args, options } = parse(argv, accountValueOptions.expose, ['no-wait','clear'], ['backend'])
      if (args[0] === 'status' && args.length === 2 && !options.backend && !options.clear && !options['health-path'] && !options['no-wait']) {
        const route = await routeStatus(args[1])
        emit(route,options,routeSummary(route))
        return failedRoute(route) ? 1 : undefined
      }
      if (args.length !== 1 || args[0] === 'status' || (options.clear && options.backend) ||
          (!options.backend && !options.clear && (options['health-path'] || options['no-wait'])))
        throw new Error('Usage: weeny-cloud expose HOST [--backend SERVER:PORT ...] [--health-path PATH] [--no-wait] [--json]')
      const path = '/api/https-routes/' + encodeURIComponent(args[0])
      const route = await call(path)
      if (!options.backend && !options.clear) return emit(route, options, routeSummary(route))
      return setRoute(path, route, options, 'expose')
    },
    async route(argv) {
      const action = argv[0]
      const { args, options } = parse(argv.slice(1), ['health-path'], ['private','public','no-wait'], ['backend','allow','domain'])
      if (action === 'list' && !args.length && !Object.keys(options).some(key => key !== 'json')) {
        const result = await call('/api/https-routes')
        return emit(result,options,result.routes.map(route => `https://${route.hostname}  (${route.name})`).join('\n') || 'No HTTPS routes')
      }
      const name = args[0]
      const invalid = () => { throw new Error('Usage: weeny-cloud route create|list|inspect|set-backends|clear|access|status|delete. See weeny-cloud help route.') }
      if (!name || args.length !== 1) invalid()
      const routePath = () => {
        let selector = name
        if (name.includes('://')) {
          const url = new URL(name)
          if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) invalid()
          selector = url.hostname
        }
        return '/api/https-routes/' + encodeURIComponent(selector)
      }
      if (action === 'access' && !options.backend && !options['no-wait'] && !options['health-path'] &&
          Boolean(options.private) !== Boolean(options.public) && (!options.public || !options.allow && !options.domain)) {
        const result = await call(routePath() + '/access', { method: 'PUT', body: {
          mode: options.private ? 'private' : 'public', allow: options.allow ?? [], domains: options.domain ?? [],
        } })
        return emit(result,options,`${name}: ${result.mode}`)
      }
      if (options.public || options.allow || options.domain) invalid()
      if (action === 'create' && !options.backend && !options['no-wait']) {
        const route = await call('/api/https-routes', { method: 'POST', body: {
          name, private: options.private, healthPath: options['health-path'],
        } })
        return emit(route,options,`${route.url} · ${route.state}`)
      }
      if (options.private) invalid()
      const path = routePath()
      if (action === 'set-backends' && options.backend || action === 'clear' && !options.backend) {
        options.clear = action === 'clear'
        return setRoute(path, await call(path), options, 'route')
      }
      if (options.backend || options['no-wait'] || options['health-path']) invalid()
      if (action === 'inspect') {
        const route = await call(path)
        return emit(route,options,routeSummary(route))
      }
      if (action === 'status') {
        const op = await routeStatus(name)
        emit(op,options,routeSummary(op))
        return failedRoute(op) ? 1 : undefined
      }
      if (action === 'delete') {
        const route = await call(path,{ method: 'DELETE' })
        return emit(route,options,`Deleted ${route.hostname}`)
      }
      invalid()
    },
    async server(argv) {
      const { args, options } = parse(argv, accountValueOptions.server, ['confirm','wait'])
      const action = args[0] ?? 'status'
      if (!['status','suspend','resume','rebuild','delete','retire','cancel-renewal'].includes(action) || args.length > 1)
        throw new Error('See weeny-cloud server --help for server controls.')
      if (options.server && options.id) throw new Error('Pass either --server or --id.')
      if (action === 'status') {
        const available = await machines()
        const all = (options.server || options.id ? [select(available, options)] : available).map(publicMachine)
        return emit({ machines: all }, options, all.map(m => `${m.id}  ${m.name}  ${m.status}  ${m.tier}${m.diskMb == null ? '' : `  ${m.diskMb / 1024} GiB disk`}${m.host ? `  host ${m.host}${m.sharedHost ? ' (shared)' : ''}` : ''}`).join('\n') || 'No server yet')
      }
      if (['retire','cancel-renewal'].includes(action)) {
        if (options.confirm && !options.quote) throw new Error('Pass the approved --quote from the preview with --confirm.')
        const selector = options.confirm && options.server !== undefined ? options.server : select(await machines(), options).id
        const endpoint = `/api/machines/${encodeURIComponent(selector)}/${action}`
        let approved = options.quote
        if (!options.confirm) {
          const quote = await call(endpoint)
          if (!quote.id) return emit(quote, options, quote.summary)
          const confirmed = interactive && !options.json &&
            /^y(es)?$/i.test(await ask(`${quote.summary}\nConfirm? (yes/no): `))
          if (!confirmed) return emit(quote, options, `${quote.summary}\nAfter approval: weeny-cloud server ${action} --server ${selector} --quote ${quote.id} --confirm`)
          approved = quote.id
        }
        const result = await call(endpoint, { method: 'POST', body: { quote: approved } })
        if (action === 'retire' && options.wait) {
          if (!result.machineId) throw new Error('Control could not confirm the retiring server. Check server status before retrying.')
          const { status } = await waitForServer(result.machineId,'deleted')
          return emit({...result,machineStatus:status},options,`${result.name}: deleted. The unused-time credit was applied to the account.`)
        }
        return emit(result, options, result.summary)
      }
      if (action !== 'resume' && !options.confirm) throw new Error(
        `${action === 'delete' ? 'Delete destroys this server and all its data.' : action === 'rebuild' ? 'Rebuild restores the latest snapshot; changes since it can be lost.' : 'Suspend takes every app offline until resumed.'} Get the human’s approval, then repeat with --confirm.`)
      const m = select(await machines(), options)
      let result = { id: m.id, ...await call(`/api/machines/${m.id}${action === 'delete' ? '' : '/' + action}`, { method: action === 'delete' ? 'DELETE' : 'POST' }) }
      if (options.wait) {
        const expected = { suspend: 'suspended', resume: 'running', rebuild: 'running', delete: 'deleted' }[action]
        result = await waitForServer(m.id,expected)
      }
      emit(result, options, `${m.name}: ${result.status}${options.wait ? '' : ' — check: weeny-cloud server status'}`)
    },
    async widget(argv) {
      const { args, options } = parse(argv, accountValueOptions.widget)
      if (args.length !== 1) throw new Error('Usage: weeny-cloud widget APP [--position bottom] [--branding on|off] [--json]')
      if (options.branding !== undefined && !['on','off'].includes(options.branding)) throw new Error('--branding must be on or off')
      const m = select(await machines(), options), app = m.apps?.find(a => a.name === args[0])
      if (!app) throw new Error('No such app on this server')
      const path = `/api/apps/${app.id}/widget`
      let policy = await call(path)
      if (options.branding !== undefined || options.position !== undefined) {
        await call(path, { method: 'PUT', body: { ...policy.settings,
          ...(options.position !== undefined ? { position: options.position } : {}),
          ...(options.branding !== undefined ? { branding: options.branding === 'on' } : {}) } })
        policy = await call(path)
      }
      emit(policy, options, `${app.name}: position ${policy.settings.position}; built with weeny badge ${policy.settings.branding ? 'on' : 'off'}${policy.free ? ' (required on free)' : ' (optional on paid/trial)'}`)
    },
    async billing(argv) {
      const { args, options } = parse(argv, accountValueOptions.billing, ['confirm','direct-paid'])
      const action = args[0] ?? 'status'
      if (options.id && action!=='cancel-checkout') throw new Error('--id is only used with billing cancel-checkout')
      if (options.reason !== undefined && action !== 'end-trial') throw new Error('--reason is only used with billing end-trial')
      if (action === 'status' && args.length <= 1) {
        const status = await call('/api/billing/status')
        return emit(status, options, JSON.stringify(status, null, 2))
      }
      if (action === 'portal' && args.length === 1) {
        const result = await call('/api/billing/portal', { method: 'POST' })
        return emit(result, options, result.url)
      }
      if (action === 'end-trial' && args.length === 1) {
        let reason = options.reason?.trim()
        if (reason !== undefined && (!reason || reason.length > 600))
          throw new Error('--reason must be 1–600 characters when provided. Omit it to end the trial without feedback.')
        if (!options.confirm) {
          if (!interactive || options.json)
            throw new Error('Ending the trial changes server access immediately. Ask for an optional reason and get the human’s approval, then repeat with --confirm.')
          const billing = await call('/api/billing/status')
          if (billing.status !== 'trialing') throw new Error('There is no active card trial to end. Check billing status.')
          if (reason === undefined) {
            reason = (await ask('Why are you leaving? (optional, Enter to skip) ')).trim()
            while (reason.length > 600)
              reason = (await ask('Use up to 600 characters, or press Enter to skip. ')).trim()
          }
          const impact = billing.noFreeFallback
            ? 'Your server will stop immediately and you won’t be charged. Apps and data stay on disk.'
            : 'Automatic billing will stop and your server will move to the free 1 GB plan immediately. Apps and data stay on disk.'
          if (!/^y(es)?$/i.test(await ask(`${impact} End trial now? [y/N] `))) return output('Trial kept active.')
        }
        const result = await call('/api/billing/end-trial', { method: 'POST', ...(reason ? { body: { reason } } : {}) })
        if (!reason) return emit(result, options, 'Trial ended.')
        const feedbackRecorded = result.feedbackRecorded === true
        return emit({ ...result, feedbackRecorded }, options,
          feedbackRecorded ? 'Trial ended. Cancellation feedback recorded.' : 'Trial ended. Cancellation feedback was not recorded.')
      }
      if (action === 'cancel-checkout' && args.length === 1) {
        let purchaseId=options.id
        if (!purchaseId) {
          const { serverAccess }=await call('/api/me')
          if (!serverAccess || typeof serverAccess!=='object')
            throw new Error('Checkout status is unavailable. Retry with --id PURCHASE_ID, or check your dashboard.')
          const purchase=serverAccess?.purchase
          if (purchase && ['paid','provisioning','delivered','refunding'].includes(purchase.status))
            throw new Error('This purchase has already completed or is being processed. Check billing status; use billing portal to manage an existing subscription.')
          if (!purchase || !['held','checkout'].includes(purchase.status))
            return emit({ok:true,cancelled:false},options,'No unpaid checkout is open. No changes made.')
          purchaseId=purchase.id
        }
        const result=await call('/api/billing/cancel-checkout',{method:'POST',body:{purchaseId}})
        return emit({...result,purchaseId,cancelled:true},options,
          'Unpaid checkout cancelled. Your waitlist place and existing server are preserved. Free requests still depend on capacity. Retry: npx weeny-cloud create')
      }
      if (action === 'checkout' && args.length === 2 && ['teeny','weeny','meany'].includes(args[1])) {
        if (!options.confirm) throw new Error('The human must choose this paid tier before checkout. Repeat with --confirm after their approval; the returned link does not pay.')
        const result = await call('/api/billing/checkout', { method: 'POST', body: { tier: args[1], ...(options['direct-paid'] ? { purpose: 'direct_paid' } : {}) } })
        return emit(result, options, `Human payment required: ${result.url}`)
      }
      throw new Error('Usage: weeny-cloud billing [status|portal|end-trial [--confirm] [--reason TEXT]|cancel-checkout [--id PURCHASE_ID]|checkout TIER --confirm [--direct-paid]] [--json]')
    },
    async tier(argv) {
      const { args, options } = parse(argv, accountValueOptions.tier, ['preview','confirm','force'])
      const want = args[0]
      const nonempty = value => typeof value === 'string' && value.trim().length > 0
      if (want === 'status' && args.length === 2) {
        const change = await call('/api/billing/plan-change/' + encodeURIComponent(args[1]))
        if (change?.id !== args[1] || !nonempty(change.status))
          throw new Error('Unable to confirm the plan change status. Try looking it up again.')
        return emit(change, options, `Plan change ${change.id}: ${change.status}${change.phase ? ' (' + change.phase + ')' : ''}${change.error ? '\n' + change.error : ''}`)
      }
      if (want === 'status' || args.length > 1) throw new Error('Usage: weeny-cloud tier [NAME] [--preview|--confirm --monthly-usd AMOUNT --quote QUOTE] [--force] [--json] or tier status ID [--json]')
      const accountBilling = options.server === undefined ? await call('/api/billing/status') : undefined
      const currentServers = accountBilling?.servers?.filter(m => !['failed','deleted'].includes(m.machineStatus))
      if (currentServers?.length > 1)
        throw new Error(`Pass --server with one of: ${currentServers.map(m => m.name).join(', ')}`)
      const soleServer = accountBilling?.consolidated === true && currentServers?.length === 1 ? currentServers[0] : undefined
      const selector = options.server ?? soleServer?.id
      const unknownServer = 'Control could not confirm the selected server. Check server status before changing its plan.'
      if (soleServer && !nonempty(selector)) throw new Error(unknownServer)
      const machineTierPath = server => `/api/machines/${encodeURIComponent(server)}/tier`
      const scoped = selector !== undefined
      const bs = scoped ? await call(machineTierPath(selector)) : accountBilling
      if (scoped && (!nonempty(bs?.machineId) || (soleServer && bs.machineId !== soleServer.id))) throw new Error(unknownServer)
      const tierPath = scoped ? machineTierPath(bs.machineId) : '/api/billing/tier'
      const monthly = t => bs.pendingPlanChange?.tier === t.name ? bs.pendingPlanChange.monthlyUsd : bs.founding ? t.foundingUsd : t.listUsd
      const price = t => `$${monthly(t)}/mo`
      if (!want) return emit(bs, options, `Your plan: ${bs.tier}${bs.machineDiskGb == null ? '' : `; your server has ${bs.machineDiskGb} GiB disk`}\n${bs.tiers.map(t => `${t.name}: ${t.memGb} GB, ${t.vcpu} vCPU${t.diskGb == null ? '' : `, ${t.diskGb} GiB disk`}, ${price(t)} — ${t.blurb}`).join('\n')}\nPreview: weeny-cloud tier NAME --preview`)
      const target = bs.tiers.find(t => t.name === want && t.name !== 'free')
      if (!target) throw new Error('Choose an available paid plan from tier status. Review cancellation terms in the billing portal.')
      const getPreview = async () => {
        const preview = await call(tierPath, { method:'POST',body:{tier:want,preview:true} })
        if (preview?.preview !== true ||
            ((Object.hasOwn(preview, 'quote') || Object.hasOwn(preview, 'action')) &&
              !nonempty(preview.quote)))
          throw new Error('Control returned an invalid plan preview. Try --preview again.')
        return preview
      }
      const pendingChange = bs.pendingPlanChange?.tier === want
      const alreadySelected = `${want} is already selected.`
      const summary = preview => {
        if (preview.unchanged) return alreadySelected + (pendingChange ? ' A plan change is pending.' : '')
        const details = [`${bs.tier} → ${want}: $${preview.monthlyUsd ?? monthly(target)}/mo`]
        if (preview.targetDiskMb != null) details.push(`Resulting disk: ${preview.targetDiskMb / 1024} GiB`)
        if (preview.effectiveAt) details.push(`Paid plan starts ${new Date(preview.effectiveAt).toISOString()}`)
        if (preview.renewalResumesAt) details.push(`Renewal resumes on ${preview.renewalResumesAt.slice(0,10)}.`)
        if (preview.requiresCheckout) details.push('Checkout is required and will show the amount due before you pay.')
        if (preview.immediateCents === 0 && !preview.requiresCheckout) details.push('No immediate charge.')
        else if (preview.immediateCents > 0) details.push(`Due now: $${(preview.immediateCents / 100).toFixed(2)}.`)
        else if (preview.immediateCents < 0) details.push(`Prorated credit: $${(-preview.immediateCents / 100).toFixed(2)}.`)
        const seconds = preview.downtimeSeconds ?? (preview.downtimeMinutes ?? 0) * 60
        const minutes = seconds / 60
        const downtime = seconds < 60 ? `${seconds} seconds` : `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`
        const estimate = seconds > 0 ? ` Expect about ${downtime} of downtime.` : ''
        if (preview.available === false) details.push('No eligible host has room right now.')
        else if (preview.action === 'move') details.push('Your server will move to another host.' + estimate)
        else if (preview.action === 'billing') details.push('Your apps can stay online during the switch.')
        else if (preview.action !== 'provision') details.push('Server reboots during resize.' + estimate)
        if (preview.legacyAddressChanges) details.push('Older IP-based TCP/UDP endpoints will use a new IP address.')
        if (preview.warning) details.push(preview.warning)
        return details.join('\n')
      }
      if (options.preview) {
        const preview = await getPreview()
        const next = preview.quote && (!preview.unchanged || pendingChange) ? `\nAfter approval: weeny-cloud tier ${want}${scoped ? ' --server ' + bs.machineId : ''} --confirm --monthly-usd ${preview.monthlyUsd} --quote ${preview.quote}` : ''
        return emit({ ...preview, plan: target, monthlyUsd: preview.monthlyUsd ?? monthly(target) }, options, summary(preview) + next)
      }
      const approved = options['monthly-usd'] === undefined ? undefined : Number(options['monthly-usd'])
      if (approved !== undefined && (!Number.isFinite(approved) || approved <= 0)) throw new Error('--monthly-usd must be a positive USD monthly amount from the approved preview')
      if (options.confirm && approved === undefined) throw new Error('Pass --monthly-usd from the human-approved preview with --confirm; preview again if the approved amount is unknown.')
      if (approved !== undefined && approved !== monthly(target)) throw new Error(`The monthly price changed from the approved $${approved} to $${monthly(target)}. Preview again and get renewed approval; no plan change was submitted.`)
      let quote = options.quote
      let monthlyUsd = approved ?? monthly(target)
      if (!options.confirm && (options.json || !interactive))
        throw new Error(`Changing plan changes what the human pays. Ask them to choose, then use tier ${want} --confirm --monthly-usd AMOUNT --quote QUOTE from the approved preview; use --preview first.`)
      if (!options.confirm || !quote) {
        const preview = await getPreview()
        if (preview.unchanged && !pendingChange)
          return emit({ ok: true, tier: want, unchanged: true }, options, alreadySelected)
        if (options.confirm) {
          if (preview.quote) throw new Error('Pass --quote from the human-approved preview with --confirm. Run --preview again if needed.')
        } else {
          if (preview.available === false && !preview.unchanged) throw new Error(summary(preview))
          monthlyUsd = preview.monthlyUsd ?? monthlyUsd
          quote = preview.quote
          const yes = await ask(`${summary(preview)}\n${options.force ? 'Force bypasses the memory warning. ' : ''}Confirm? (yes/no): `)
          if (!/^y(es)?$/i.test(yes)) return output('Nothing changed')
        }
      }
      const result = await call(tierPath, { method: 'POST', body: { tier: want, monthlyUsd, ...(quote ? { quote } : {}), ...(options.force ? { force: true } : {}) } })
      const hasCheckout = nonempty(result?.checkoutUrl)
      if (!hasCheckout && typeof result?.ok !== 'boolean')
        throw new Error('The plan change outcome is unknown. Check weeny-cloud billing status before retrying.')
      emit(result, options, hasCheckout ? `Human payment required: ${result.checkoutUrl}` : result.unchanged ? alreadySelected :
        `${want}${result.ok === false ? ' — plan change could not complete' : result.resizing ? ' — plan change in progress' : ''}${result.operationId ? `\nStatus: weeny-cloud tier status ${result.operationId}` : ''}`)
      if (result.ok === false) return 1
    },
    async logout(argv) {
      const { args, options } = parse(argv, [], ['local'])
      if (args.length) throw new Error('Usage: weeny-cloud logout [--local] [--json]')
      if (options.local && fromEnv) throw new Error('Unset WEENY_TOKEN to sign out locally; logout --local cannot remove an environment token')
      if (!options.local && loadCreds()?.token) await call('/api/auth/logout', { method: 'POST' })
      if (!fromEnv) clearCredentials()
      emit({ signedOut: true, revoked: !options.local, environmentToken: !!fromEnv }, options,
        options.local ? 'Local credentials removed; the server token remains valid.' : `Signed out; this token is revoked.${fromEnv ? ' Unset WEENY_TOKEN in your environment.' : ''}`)
    },
  }
}
