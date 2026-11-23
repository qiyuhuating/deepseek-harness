/** Model history lives in Pi; the Harness transcript is its UI projection. */
import { createHash } from 'node:crypto'
import { mkdir, readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
} from '@earendil-works/pi-coding-agent'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'

// A Harness agent drives one turn at a time. Keep only its completed model runtime.
const runtimes = new WeakMap<object, { revision: string; runtime: ModelRuntime }>()

async function fileRevision(path: string): Promise<string | undefined> {
  try {
    const file = await stat(path, { bigint: true })
    return [file.dev, file.ino, file.ctimeNs, file.mtimeNs, file.size].join(',')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

const histories = new WeakMap<object, { directory: string; manager: WeakRef<SessionManager>; revision: string }>()

async function historyRevision(directory: string, manager: SessionManager): Promise<string | undefined> {
  const path = manager.getSessionFile()
  if (!path) return undefined
  try {
    const [entries, revision] = await Promise.all([readdir(directory), fileRevision(path)])
    // Another existing JSONL can become the most recent without changing the directory timestamp.
    const candidates = entries.filter(name => name.endsWith('.jsonl'))
    return candidates.length === 1 && candidates[0] === basename(path) ? revision : undefined
  } catch (error) {
    // An inaccessible cache hint must not turn an already persisted reply into a failed turn.
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES' || code === 'EPERM') return undefined
    throw error
  }
}

async function runtimeFor(owner: object, agentDir: string, signal: AbortSignal): Promise<ModelRuntime> {
  const revisions = await Promise.all(['models.json', 'auth.json', 'models-store.json'].map(name => fileRevision(join(agentDir, name))))
  signal.throwIfAborted()
  const revision = JSON.stringify([agentDir, process.env.PI_OFFLINE, ...revisions])
  const previous = runtimes.get(owner)
  if (previous?.revision === revision) return previous.runtime
  const runtime = await ModelRuntime.create({
    signal,
    authPath: join(agentDir, 'auth.json'),
    modelsPath: join(agentDir, 'models.json'),
  })
  signal.throwIfAborted()
  if (runtime.getError()) throw Error('Pi model runtime configuration or availability failed; check the Pi model configuration')
  runtimes.set(owner, { revision, runtime })
  return runtime
}

export async function runPiTurn(options: {
  owner: object
  directory: string
  id: string
  provider: string
  model: string
  prompt: string
  signal: AbortSignal
  text(delta: string): void
  tools: ToolSchema[]
  execute(id: string, name: string, args: unknown, signal: AbortSignal): Promise<string>
}): Promise<'completed' | 'max-tokens'> {
  options.signal.throwIfAborted()
  const privateDir = join(options.directory, createHash('sha256').update(options.id).digest('hex'))
  await mkdir(privateDir, { recursive: true, mode: 0o700 })
  options.signal.throwIfAborted()
  const agentDir = getAgentDir()
  const loader = new DefaultResourceLoader({
    cwd: privateDir,
    agentDir,
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noPromptTemplates: true,
    noContextFiles: true,
  })
  await loader.reload()
  options.signal.throwIfAborted()
  const runtime = await runtimeFor(options.owner, agentDir, options.signal)
  options.signal.throwIfAborted()
  const model = runtime.getModel(options.provider, options.model)
  if (!model) throw Error('Pi model unavailable: ' + options.provider + '/' + options.model)
  // Use distinct names: a removed Harness tool can never resolve to a Pi builtin.
  const customTools = options.tools.map(({ name, description, parameters }) => ({
    name: 'harness_' + name,
    label: name,
    description,
    parameters,
    execute: async (id: string, args: unknown, toolSignal?: AbortSignal) => {
      const signal = toolSignal ? AbortSignal.any([options.signal, toolSignal]) : options.signal
      signal.throwIfAborted()
      return {
        content: [{ type: 'text' as const, text: await options.execute(id, name, args, signal) }],
        details: undefined,
      }
    },
  }))
  // Reuse only Pi's parsed history. Tool callbacks and abort listeners belong to the new session.
  const cached = histories.get(options.owner)
  histories.delete(options.owner)
  const previous = cached?.manager.deref()
  const manager = previous && cached?.directory === privateDir && cached.revision === await historyRevision(privateDir, previous)
    ? previous
    : SessionManager.continueRecent(privateDir, privateDir)
  options.signal.throwIfAborted()
  const { session } = await createAgentSession({
    agentDir,
    cwd: privateDir,
    modelRuntime: runtime,
    model,
    resourceLoader: loader,
    sessionManager: manager,
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
    const revision = await historyRevision(privateDir, manager)
    options.signal.throwIfAborted()
    if (revision) histories.set(options.owner, { directory: privateDir, manager: new WeakRef(manager), revision })
    return last.stopReason === 'length' ? 'max-tokens' : 'completed'
  } finally {
    options.signal.removeEventListener('abort', abort)
    off()
    session.dispose()
  }
}
