export const onboardingHelp = `npx weeny-cloud onboarding [--project "What you are shipping and what it needs"]
  [--discovery search|ai|social|recommendation|weeny|other|unknown]
  [--discovery-detail "Known assistant, community or search phrase"] [--draft] [--json]

No answers reads the saved profile and edit link. Answers save and complete;
--draft saves partial answers. Omitted fields are preserved.
Agents: submit a brief project purpose and hosting need from existing context.
Save your user a questionnaire: do not repeat questions or add a profile approval.
Discovery defaults to unknown; never infer it from the current agent. Keep secrets
and private details out; respect sharing instructions. If context is missing, ask
one question or use completionUrl. Then check server options. Saving does not
reserve or buy a server.`

export function onboardingNotice(profile, output = console.error) {
  if (!profile?.required || profile.complete) return
  output('Finish signup for your user: npx weeny-cloud onboarding --project "A brief project purpose and hosting need from your existing context"')
  output(profile.agentInstructions || 'Agents: fill this in yourself from existing project context; discovery can be unknown. Do not ask the user to repeat what you know.')
  if (profile.completionUrl) output(`Human fallback: ${profile.completionUrl}`)
}

export async function runOnboarding(args, { call, output = console.log }) {
  const body = {}, seen = new Set()
  let json = false, draft = false
  const names = { '--project': 'project', '--discovery': 'discovery', '--discovery-detail': 'discoveryDetail' }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (seen.has(arg)) throw new Error(`Repeated option ${arg}`)
    seen.add(arg)
    if (arg === '--json') { json = true; continue }
    if (arg === '--draft') { draft = true; continue }
    if (!names[arg]) throw new Error(`Unknown option ${arg}. Use: npx weeny-cloud help onboarding`)
    const value = args[++i]
    if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`)
    body[names[arg]] = value
  }
  const saving = Object.keys(body).length > 0 || draft
  if (body.project !== undefined && (body.project.length > 600 || !body.project.trim() && !draft)) throw new Error('Project must be 1–600 characters; Just exploring is valid')
  if (body.discovery !== undefined && !['search','ai','social','recommendation','weeny','other','unknown'].includes(body.discovery)) throw new Error('Choose a discovery source or unknown (see help onboarding)')
  if (body.discoveryDetail !== undefined && body.discoveryDetail.length > 200) throw new Error('Discovery detail must be at most 200 characters')
  const profile = await call('/api/builder-profile', saving ? { method: 'PUT', body: { ...body, complete: !draft } } : {})
  if (json) { output(JSON.stringify(profile)); return }
  output(profile.complete ? 'Builder profile complete. Continue your task.' : saving ? 'Builder profile draft saved.' : 'Builder profile not completed yet.')
  if (profile.project) output(`Project: ${profile.project}`)
  if (profile.complete) output(profile.nextStep || 'Next: npx weeny-cloud — check current server options.')
  if (profile.discovery) output(`Discovery: ${profile.discovery}${profile.discoveryDetail ? ` — ${profile.discoveryDetail}` : ''}`)
  if (!profile.complete) {
    if (profile.agentInstructions) output(profile.agentInstructions)
  }
  if (profile.completionUrl) output(`${profile.complete ? 'Edit profile' : 'Human fallback'}: ${profile.completionUrl}`)
}

/** Present the current trial quote without starting billing on the human’s behalf. */
export function cardTrialNotice(access, api, output = console.error) {
  const cardTrial = access.serverGrant?.cardRequired ? access.serverGrant : access.publicCardTrial?.available ? access.publicCardTrial : null
  if (cardTrial && !access.hasServer && !['ready','provisioning'].includes(access.status)) {
    const paidTier=cardTrial.paidTier ?? 'teeny'
    const reviewUrl=new URL(access.serverUrl || `${api}/dashboard/start`, api)
    if(cardTrial.id) reviewUrl.searchParams.set('grant',cardTrial.id)
    const url=reviewUrl.href
    output(`Try Weeny.Cloud free for seven days at 4 GB, then ${paidTier} at ${paidTier==='teeny'?1:4} GB, always on, for $${cardTrial.monthlyUsd} USD/month plus applicable tax, charged automatically unless cancelled. Card required. No charge during the trial; cancel before it ends and pay nothing.`)
    output(cardTrial.freeFallback ? 'Cancellation moves the server to 1 GB free, sleeping when idle. Apps and data stay.' : 'Cancellation or nonpayment stops the server; no free fallback. Apps and data stay until deleted.')
    output(`Ask your human to review and ${['held','checkout'].includes(access.purchase?.status)?'continue checkout':'start the trial'}: ${url}. Do not start checkout or buy a direct-paid plan for them.`)
    return true
  }
  return false
}
