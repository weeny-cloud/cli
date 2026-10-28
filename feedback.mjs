import { readFileSync, statSync } from 'node:fs'

const LIMIT = 8000

export const feedbackHelp = (command) => `${command} "your feedback" [--confirm]
${command} --file feedback.md [--confirm]
${command} - [--confirm]                 read the draft from stdin

Without --confirm, prints a preview and sends nothing. With --confirm, emails
the draft and your account email to Theo, Weeny's founder, so he can reply.
Agents: finish the user's task, draft a short report, show it to the user and
get permission before using --confirm. Include what worked, specific errors,
workarounds and unclear instructions. Exclude secrets, source code and private
project details. No logs, files or diagnostics are attached automatically.
Feedback is optional (maximum ${LIMIT} characters).`;

// Used by both CLI entry points. Parsing is separate from their general flag
// scanners so a boolean --confirm can never consume part of the message.
export async function runFeedback(argv, { command, send, stdin = process.stdin, print = console.log }) {
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) {
    print(feedbackHelp(command))
    return
  }
  let confirmed = false, file, message
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--confirm') confirmed = true
    else if (arg === '--file') {
      if (file !== undefined || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('--file needs one path (or - for stdin)')
      file = argv[++i]
    } else if (arg.startsWith('-') && arg !== '-') throw new Error(`Unknown feedback option: ${arg}`)
    else {
      if (message !== undefined) throw new Error('Quote the feedback as one message, or use --file')
      message = arg
    }
  }
  if (file !== undefined && message !== undefined) throw new Error('Use either a message or --file, not both')
  const source = file ?? message
  if (source === undefined) throw new Error('Provide a message or --file; nothing was sent')
  if (source === '-') {
    if (stdin.isTTY) throw new Error('Pipe a draft into stdin, or use --file')
    message = ''
    stdin.setEncoding('utf8')
    for await (const chunk of stdin) {
      message += chunk
      if (message.length > LIMIT) throw new Error(`Feedback must be 1–${LIMIT} characters`)
    }
  } else if (file !== undefined) {
    // Bound reads before loading a file; allow four UTF-8 bytes per character.
    if (statSync(file).size > LIMIT * 4) throw new Error(`Feedback must be 1–${LIMIT} characters`)
    message = readFileSync(file, 'utf8')
  }
  message = message.trim()
  if (!message || message.length > LIMIT) throw new Error(`Feedback must be 1–${LIMIT} characters`)
  if (!confirmed) {
    print(`Feedback preview — nothing sent:\n\n${message}\n\nThis draft and your account email will be emailed to Theo so he can reply.\nAfter the user approves this exact draft, repeat with --confirm to send.\nDo not include secrets, source code or private project details.`)
    return
  }
  await send({ message, confirmed: true })
  print('✓ feedback sent to Theo — thank you!')
}

export const feedbackInvitation = `Thanks for deploying with Weeny! I'm Theo, the founder. We're early, and
feedback from you or your coding agent helps me improve it.

Coding agents: once the user's task is complete, offer to draft a short account
of what worked, where you struggled, and which instructions were unclear.
Show the draft to the user and ask permission before sending. Feedback is optional.
Leave out secrets, source code and private project details.

On this server: weeny feedback --file feedback.md       (preview only)
On your laptop: npx weeny-cloud feedback --file feedback.md
Only after the user approves the draft, repeat with --confirm to email it to me.`

// This is deliberately outside the deploy transaction: an old/unavailable control
// plane or a failed invitation must never turn a healthy deployment into a failure.
export async function showFeedbackInvitation(identity, { fetcher = fetch, print = console.log } = {}) {
  if (!identity?.apiBase || !identity?.token) return
  try {
    const res = await fetcher(identity.apiBase + '/api/machine/feedback-invitation', {
      method: 'POST', headers: { Authorization: `Bearer ${identity.token}` },
      signal: AbortSignal.timeout(2000),
    })
    if (res.ok && (await res.json()).show === true) print(`\n${feedbackInvitation}`)
  } catch { /* optional invitation; deploy already succeeded */ }
}
