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
      const { args, options } = parse(argv, ['id','reason'], ['confirm','direct-paid'])
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
      const { args, options } = parse(argv, ['monthly-usd', 'quote'], ['preview','confirm','force'])
      const want = args[0]
      const nonempty = value => typeof value === 'string' && value.trim().length > 0
      if (want === 'status' && args.length === 2) {
        const change = await call('/api/billing/plan-change/' + encodeURIComponent(args[1]))
        if (change?.id !== args[1] || !nonempty(change.status))
          throw new Error('Unable to confirm the plan change status. Try looking it up again.')
        return emit(change, options, `Plan change ${change.id}: ${change.status}${change.phase ? ' (' + change.phase + ')' : ''}${change.error ? '\n' + change.error : ''}`)
      }
      if (want === 'status' || args.length > 1) throw new Error('Usage: weeny-cloud tier [NAME] [--preview|--confirm --monthly-usd AMOUNT --quote QUOTE] [--force] [--json] or tier status ID [--json]')
      const bs = await call('/api/billing/status')
      const monthly = t => bs.pendingPlanChange?.tier === t.name ? bs.pendingPlanChange.monthlyUsd : bs.founding ? t.foundingUsd : t.listUsd
      const price = t => `$${monthly(t)}/mo`
      if (!want) return emit(bs, options, `Your plan: ${bs.tier}${bs.machineDiskGb == null ? '' : `; your server has ${bs.machineDiskGb} GiB disk`}\n${bs.tiers.map(t => `${t.name}: ${t.memGb} GB, ${t.vcpu} vCPU${t.diskGb == null ? '' : `, ${t.diskGb} GiB disk`}, ${price(t)} — ${t.blurb}`).join('\n')}\nPreview: weeny-cloud tier NAME --preview`)
      const target = bs.tiers.find(t => t.name === want && t.name !== 'free')
      if (!target) throw new Error('Choose an available paid plan from tier status. Review cancellation terms in the billing portal.')
      const getPreview = async () => {
        const preview = await call('/api/billing/tier', { method:'POST',body:{tier:want,preview:true} })
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
        if (preview.requiresCheckout) details.push('Checkout is required and will show the amount due before you pay.')
        else if (preview.immediateCents === 0) details.push('No immediate charge.')
        else if (preview.immediateCents > 0) details.push(`Due now: $${(preview.immediateCents / 100).toFixed(2)}.`)
        else if (preview.immediateCents < 0) details.push(`Prorated credit: $${(-preview.immediateCents / 100).toFixed(2)}.`)
        if (preview.available === false) details.push('No eligible host has room right now.')
        else if (preview.action === 'move') details.push(`Your server will move to another host. Allow about ${preview.downtimeMinutes} minutes of downtime.`)
        else if (preview.action === 'billing') details.push('Your apps can stay online during the switch.')
        else if (preview.action !== 'provision') details.push('Server reboots during resize.' + (preview.downtimeMinutes ? ` Allow about ${preview.downtimeMinutes} minutes.` : ''))
        if (preview.legacyAddressChanges) details.push('Older IP-based TCP/UDP endpoints will use a new IP address.')
        if (preview.warning) details.push(preview.warning)
        return details.join('\n')
      }
      if (options.preview) {
        const preview = await getPreview()
        const next = preview.quote && (!preview.unchanged || pendingChange) ? `\nAfter approval: weeny-cloud tier ${want} --confirm --monthly-usd ${preview.monthlyUsd} --quote ${preview.quote}` : ''
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
      const result = await call('/api/billing/tier', { method: 'POST', body: { tier: want, monthlyUsd, ...(quote ? { quote } : {}), ...(options.force ? { force: true } : {}) } })
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
