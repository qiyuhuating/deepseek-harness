import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'

vi.mock(import('@earendil-works/pi-coding-agent'), async (original) => ({
  ...await original(), createAgentSession: vi.fn(),
}))

it('binds only the current Pi tools and combines cancellation per invocation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-tools-'))
  onTestFinished(() => rm(directory, { recursive: true, force: true }))
  vi.stubEnv('PI_CODING_AGENT_DIR', directory)
  vi.stubEnv('PI_OFFLINE', '1')
  onTestFinished(() => { vi.unstubAllEnvs() })
  const sdk = await import('@earendil-works/pi-coding-agent')
  const { runPiTurn } = await import('../src/pi-turn.ts')
  const stop = new Error('captured session options')
  const create = vi.mocked(sdk.createAgentSession).mockRejectedValue(stop)
  onTestFinished(() => { create.mockRestore() })
  await writeFile(join(directory, 'models.json'), JSON.stringify({
    providers: { local: { api: 'openai-completions', baseUrl: 'http://localhost', models: [{ id: 'test' }] } },
  }))
  const owner = {}
  const signals: AbortSignal[] = []
  async function capture(turn: AbortController, allowed: boolean) {
    await expect(runPiTurn({
      owner, directory, id: 'signals', provider: 'local', model: 'test', prompt: '',
      signal: turn.signal, text: vi.fn(),
      tools: allowed ? [{ name: 'read', description: 'read', parameters: { type: 'object', properties: {} } }] : [],
      execute: async (_id, _name, _args, signal) => { signals.push(signal); return 'ok' },
    })).rejects.toBe(stop)
    return create.mock.lastCall?.[0]
  }
  const oldTurn = new AbortController()
  const first = await capture(oldTurn, true)
  const call = new AbortController()
  const ctx = {} as import('@earendil-works/pi-coding-agent').ExtensionToolContext
  await first?.customTools?.[0]?.execute('one', {}, call.signal, undefined, ctx)
  call.abort('single call')
  expect(signals[0]?.reason).toBe('single call')
  expect(oldTurn.signal.aborted).toBe(false)
  const revoked = await capture(new AbortController(), false)
  expect(revoked?.tools).toEqual([])
  expect(revoked?.customTools).toEqual([])
  const nextTurn = new AbortController()
  const next = await capture(nextTurn, true)
  await next?.customTools?.[0]?.execute('two', {}, new AbortController().signal, undefined, ctx)
  oldTurn.abort()
  expect(signals[1]?.aborted).toBe(false)
  nextTurn.abort('current turn')
  expect(signals[1]?.reason).toBe('current turn')
})
