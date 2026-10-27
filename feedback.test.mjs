import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { runFeedback, showFeedbackInvitation } from './feedback.mjs'

const command = 'weeny feedback'
test('preview and help never send or require authentication', async () => {
  let sent = 0
  const output = []
  const opts = { command, send: async () => { sent++ }, print: line => output.push(line) }
  await runFeedback([], opts)
  await runFeedback(['worked well'], opts)
  await runFeedback(['--help', '--confirm'], opts)
  assert.equal(sent, 0)
  assert.match(output[1], /nothing sent/)
  assert.match(output[1], /worked well/)
})
test('sends only the explicit draft and confirmation; flags work in either order', async () => {
  for (const args of [['a draft', '--confirm'], ['--confirm', 'a draft']]) {
    const payloads = []
    await runFeedback(args, { command, send: async p => payloads.push(p), print: () => {} })
    assert.deepEqual(payloads, [{ message: 'a draft', confirmed: true }])
  }
})
test('accepts file and stdin drafts, including split UTF-8 characters', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'weeny-feedback-'))
  try {
    const path = join(dir, 'draft.md')
    writeFileSync(path, ' clear instructions 😀\n')
    for (const args of [['--file', path], ['-'], ['--file', '-']]) {
      let output = ''
      const data = Buffer.from('clear instructions 😀')
      await runFeedback(args, { command, send: async () => assert.fail('preview sent'),
        print: line => { output = line }, stdin: Readable.from([data.subarray(0, 21), data.subarray(21)]) })
      assert.match(output, /clear instructions 😀/)
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
test('rejects ambiguous or invalid input without sending', async () => {
  for (const args of [['--confirm'], ['--file'], ['one', 'two'], ['--unknown'], [''], ['x'.repeat(8001)],
    ['draft', '--file', 'other'], ['--file', 'missing.md']]) {
    await assert.rejects(runFeedback(args, { command, send: async () => assert.fail('invalid draft sent'), print: () => {} }))
  }
})
test('failed delivery is an error, never a success message', async () => {
  const output = []
  await assert.rejects(runFeedback(['draft', '--confirm'], { command,
    send: async () => { throw new Error('provider failed') }, print: line => output.push(line) }), /provider failed/)
  assert.deepEqual(output, [])
})
test('invitation is noninteractive and appears only when the server grants the claim', async () => {
  const output = []
  const identity = { apiBase: 'https://example.test', token: 'test-token' }
  for (const show of [true, false]) {
    await showFeedbackInvitation(identity, { print: line => output.push(line), fetcher: async (url, opts) => {
      assert.equal(url, 'https://example.test/api/machine/feedback-invitation')
      assert.equal(opts.method, 'POST')
      return { ok: true, json: async () => ({ show }) }
    } })
  }
  assert.equal(output.length, 1)
  assert.match(output[0], /Show the draft to the user and ask permission/)
})
test('old control planes, network errors and missing identities do not fail a deploy', async () => {
  for (const fetcher of [async () => { throw new Error('offline') }, async () => ({ ok: false })])
    await showFeedbackInvitation({ apiBase: 'https://example.test', token: 'test' }, { fetcher, print: () => assert.fail('unexpected invitation') })
  await showFeedbackInvitation(null)
})
