/** Model history lives in Pi; the Harness transcript is its UI projection. */
import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
} from '@earendil-works/pi-coding-agent'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'

export async function runPiTurn(options: {
  directory: string
  id: string
  provider: string
  model: string
  prompt: string
  signal: AbortSignal
  text(delta: string): void
  tools: ToolSchema[]
  execute(id: string, name: string, args: unknown): Promise<string>
}): Promise<void> {
  const privateDir = join(options.directory, createHash('sha256').update(options.id).digest('hex'))
  await mkdir(privateDir, { recursive: true, mode: 0o700 })
  const loader = new DefaultResourceLoader({
    cwd: privateDir,
    agentDir: getAgentDir(),
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noPromptTemplates: true,
    noContextFiles: true,
  })
  await loader.reload()
  const runtime = await ModelRuntime.create({ signal: options.signal })
  const model = runtime.getModel(options.provider, options.model)
  if (!model) throw Error('Pi model unavailable: ' + options.provider + '/' + options.model)
  // Use distinct names: a removed Harness tool can never resolve to a Pi builtin.
  const customTools = options.tools.map(({ name, description, parameters }) => ({
    name: 'harness_' + name,
    label: name,
    description,
    parameters,
    execute: async (id: string, args: unknown) => ({
      content: [{ type: 'text' as const, text: await options.execute(id, name, args) }],
      details: undefined,
    }),
  }))
  const { session } = await createAgentSession({
    cwd: privateDir,
    modelRuntime: runtime,
    model,
    resourceLoader: loader,
    sessionManager: SessionManager.continueRecent(privateDir, privateDir),
    tools: customTools.map((t) => t.name),
    customTools,
  })
  const abort = () => {
    void session.abort()
  }
  const off = session.subscribe((event) => {
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta')
      options.text(event.assistantMessageEvent.delta)
  })
  try {
    options.signal.addEventListener('abort', abort, { once: true })
    options.signal.throwIfAborted()
    await session.prompt(options.prompt)
    options.signal.throwIfAborted()
    const last = session.messages.at(-1)
    if (last?.role !== 'assistant' || last.stopReason === 'error' || last.stopReason === 'aborted')
      throw Error(
        last?.role === 'assistant'
          ? (last.errorMessage ?? last.stopReason)
          : 'Pi turn ended without an assistant response',
      )
  } finally {
    options.signal.removeEventListener('abort', abort)
    off()
    session.dispose()
  }
}
