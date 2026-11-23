import { once } from 'node:events'
import { mkdtemp, readdir, readFile, rename, rm, utimes, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { runPiTurn } from '../src/pi-turn.ts'

it('follows Pi history selection after deletion, restore and session switches', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-history-'))
  onTestFinished(() => rm(directory, { recursive: true, force: true }))
  vi.stubEnv('PI_CODING_AGENT_DIR', directory)
  vi.stubEnv('PI_OFFLINE', '1')
  onTestFinished(() => { vi.unstubAllEnvs() })
  let messages = ''
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const part of req) body += part
    messages = JSON.stringify(JSON.parse(body).messages)
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const chunk = { id: 'test', object: 'chat.completion.chunk', created: 1, model: 'test',
      choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }
    res.end('data: ' + JSON.stringify(chunk) + '\n\ndata: [DONE]\n\n')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  onTestFinished(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }))
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw Error('Missing local Pi endpoint')
  await writeFile(join(directory, 'models.json'), JSON.stringify({ providers: {
    local: { api: 'openai-completions', apiKey: 'test', baseUrl: 'http://127.0.0.1:' + addr.port, models: [{ id: 'test' }] },
  } }))
  const owner = {}
  const data = join(directory, 'data')
  const turn = (prompt: string, id = 'main', agent = owner) => runPiTurn({ owner: agent, directory: data, id, provider: 'local', model: 'test',
    prompt, signal: new AbortController().signal, tools: [], execute: vi.fn(), text: vi.fn() })
  await turn('history-marker')
  await turn('before deletion')
  expect(messages).toContain('history-marker')
  const [id] = await readdir(data)
  const files = await readdir(join(data, id))
  const file = files.find(name => name.endsWith('.jsonl'))
  if (!file) throw Error('Missing Pi history')
  const active = join(data, id, file)
  const restored = join(data, id, 'restored.jsonl')
  await writeFile(restored, (await readFile(active, 'utf8')).replace('history-marker', 'restored-marker'))
  await utimes(restored, 1, 1)
  await turn('warm original')
  expect(messages).toContain('history-marker')
  const newest = new Date(Date.now() + 10000)
  await utimes(restored, newest, newest)
  await turn('continue latest')
  expect(messages).toContain('restored-marker')
  expect(messages).not.toContain('history-marker')
  await turn('private other marker', 'other')
  expect(messages).not.toContain('restored-marker')
  await turn('back in main')
  expect(messages).not.toContain('private other marker')
  expect(messages).toContain('restored-marker')
  await turn('reopened', 'main', {})
  expect(messages).toContain('back in main')
  await rm(active)
  await turn('single file hot')
  const replacement = (await readFile(restored, 'utf8')).replace('restored-marker', 'replaced-marker')
  await writeFile(restored + '.tmp', replacement)
  await rename(restored + '.tmp', restored)
  await turn('after replacement')
  expect(messages).toContain('replaced-marker')
  expect(messages).not.toContain('restored-marker')
  await rm(restored)
  await turn('after deletion')
  expect(messages).toContain('after deletion')
  expect(messages).not.toContain('replaced-marker')
  expect(messages).not.toContain('restored-marker')
  expect(messages).not.toContain('history-marker')
})
