// Account controls live here; app deployment still belongs to the on-server CLI.
// Both use documented owner APIs, with explicit confirmation for disruptive actions.
export function accountCommands({ call, loadCreds, clearCredentials, ask, interactive, fromEnv, output = console.log }) {
  const parse = (argv, valued = [], boolean = []) => {
    const options = {}, args = []
    for (let i = 0; i < argv.length; i++) {
      const word = argv[i]
      if (!word.startsWith('--')) { args.push(word); continue }
      const key = word.slice(2)
      if (!['json',...boolean,...valued].includes(key)) throw new Error(`Unknown option --${key}`)
      if (valued.includes(key)) {
        if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`--${key} needs a value`)
        options[key] = argv[++i]
      } else options[key] = true
    }
    return { args, options }
  }
  const emit = (value, options, text) => output(options.json ? JSON.stringify(value) : text)
  const machines = async () => (await call('/api/machines')).machines
  const select = async id => {
    const all = await machines()
    const m = id ? all.find(m => m.id === id) : all.length === 1 ? all[0] : null
    if (!m) throw new Error(id ? 'No such server' : 'Specify --id from: npx weeny-cloud server status --json')
    return m
  }
  const publicMachine = ({ id, name, status, tier, diskMb, note, error, apps, health, alerts }) => ({ id, name, status, tier, diskMb, note, error, apps, health, alerts })
  return {
    async server(argv) {
      const { args, options } = parse(argv, ['id'], ['confirm','wait'])
      const action = args[0] ?? 'status'
      if (!['status','suspend','resume','rebuild','delete'].includes(action) || args.length > 1)
        throw new Error('Usage: weeny-cloud server status|suspend|resume|rebuild|delete [--id ID] [--confirm] [--wait] [--json]')
      if (action === 'status') {
        const all = (await machines()).filter(m => !options.id || m.id === options.id).map(publicMachine)
        if (options.id && !all.length) throw new Error('No such server')
        return emit({ machines: all }, options, all.map(m => `${m.id}  ${m.name}  ${m.status}  ${m.tier}${m.diskMb == null ? '' : `  ${m.diskMb / 1024} GiB disk`}`).join('\n') || 'No server yet')
      }
      if (action !== 'resume' && !options.confirm) throw new Error(
        `${action === 'delete' ? 'Delete destroys this server and all its data.' : action === 'rebuild' ? 'Rebuild restores the latest snapshot; changes since it can be lost.' : 'Suspend takes every app offline until resumed.'} Get the human’s approval, then repeat with --confirm.`)
      const m = await select(options.id)
      let result = { id: m.id, ...await call(`/api/machines/${m.id}${action === 'delete' ? '' : '/' + action}`, { method: action === 'delete' ? 'DELETE' : 'POST' }) }
      if (options.wait) {
        const expected = { suspend: 'suspended', resume: 'running', rebuild: 'running', delete: 'deleted' }[action]
        const until = Date.now() + 10 * 60_000
        for (;;) {
          const current = (await machines()).find(x => x.id === m.id)
          const status = current?.status ?? 'deleted'
          result = { id: m.id, status }
          if (status === expected) break
          if (status === 'failed' || (status === 'deleted' && action !== 'delete')) throw new Error(`Server operation failed: ${current?.error || status}`)
          if (Date.now() >= until) throw new Error(`Server is still ${status}; inspect server status before retrying the action`)
          await new Promise(r => setTimeout(r, 5000))
        }
      }
      emit(result, options, `${m.name}: ${result.status}${options.wait ? '' : ' — check: weeny-cloud server status'}`)
    },
    async widget(argv) {
      const { args, options } = parse(argv, ['id','position','branding'])
      if (args.length !== 1) throw new Error('Usage: weeny-cloud widget APP [--position bottom] [--branding on|off] [--json]')
      if (options.branding !== undefined && !['on','off'].includes(options.branding)) throw new Error('--branding must be on or off')
      const m = await select(options.id), app = m.apps?.find(a => a.name === args[0])
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
      const { args, options } = parse(argv, ['id'], ['confirm','direct-paid'])
      const action = args[0] ?? 'status'
      if (options.id && action!=='cancel-checkout') throw new Error('--id is only used with billing cancel-checkout')
      if (action === 'status' && args.length <= 1) {
        const status = await call('/api/billing/status')
        return emit(status, options, JSON.stringify(status, null, 2))
      }
      if (action === 'portal' && args.length === 1) {
        const result = await call('/api/billing/portal', { method: 'POST' })
        return emit(result, options, result.url)
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
      throw new Error('Usage: weeny-cloud billing [status|portal|cancel-checkout [--id PURCHASE_ID]|checkout TIER --confirm [--direct-paid]] [--json]')
    },
    async tier(argv) {
      const { args, options } = parse(argv, [], ['preview','confirm','force'])
      const bs = await call('/api/billing/status'), want = args[0]
      if (args.length > 1) throw new Error('Usage: weeny-cloud tier [NAME] [--preview|--confirm] [--force] [--json]')
      const price = t => `$${bs.founding ? t.foundingUsd : t.listUsd}/mo`
      if (!want) return emit(bs, options, `Your plan: ${bs.tier}${bs.machineDiskGb == null ? '' : `; your server has ${bs.machineDiskGb} GiB disk`}\n${bs.tiers.map(t => `${t.name}: ${t.memGb} GB, ${t.vcpu} vCPU${t.diskGb == null ? '' : `, ${t.diskGb} GiB disk`}, ${price(t)} — ${t.blurb}`).join('\n')}\nPreview: weeny-cloud tier NAME --preview`)
      const target = bs.tiers.find(t => t.name === want && t.name !== 'free')
      if (!target) throw new Error('Choose teeny, weeny or meany. To return to free, cancel through billing portal.')
      if (options.preview) {
        const preview = await call('/api/billing/tier', { method: 'POST', body: { tier: want, preview: true } })
        return emit({ ...preview, plan: target, monthlyUsd: bs.founding ? target.foundingUsd : target.listUsd }, options,
          `${bs.tier} → ${want}: ${price(target)}${preview.targetDiskMb == null ? '' : `; resulting disk ${preview.targetDiskMb / 1024} GiB`}; server reboots during resize. No change made.${preview.warning ? '\n' + preview.warning : ''}`)
      }
      if (!options.confirm) {
        if (options.json || !interactive) throw new Error(`Changing plan changes what the human pays. Ask them to choose, then use tier ${want} --confirm; use --preview first.`)
        const yes = await ask(`${bs.tier} → ${want}: ${price(target)}, prorated; server reboots. ${options.force ? 'Force bypasses the memory warning. ' : ''}Confirm? (yes/no): `)
        if (!/^y(es)?$/i.test(yes)) return output('Nothing changed')
      }
      const result = await call('/api/billing/tier', { method: 'POST', body: { tier: want, ...(options.force ? { force: true } : {}) } })
      emit(result, options, result.checkoutUrl ? `Human payment required: ${result.checkoutUrl}` : `${want}${result.resizing ? ' — resizing' : ''}`)
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
