// Log retention adapted from Axiom Agent (MIT); see LICENSE-Axiom.
import { spawn } from 'node:child_process'
import { closeSync, constants, mkdirSync, fstatSync, ftruncateSync, openSync, writeSync } from 'node:fs'

import { resolve, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../', import.meta.url))
const home = resolve(process.env.DSH_HOME || join(homedir(), '.dsh'))
const directory = resolve(process.env.DSH_PI_SESSION_DIR || join(home, 'pi'))
mkdirSync(directory, { recursive: true, mode: 0o700 })
const path = join(directory, 'runtime.log')
const limit = 8 * 1024 * 1024
const fd = openSync(path, constants.O_RDWR | constants.O_CREAT, 0o600)
function append(data) {
  try {
    const tail = data.subarray(-limit)
    let start = fstatSync(fd).size
    if (start + tail.length > limit) {
      ftruncateSync(fd, 0)
      start = 0
    }
    let offset = 0
    while (offset < tail.length) offset += writeSync(fd, tail, offset, tail.length - offset, start + offset)
  } catch (e) {
    if (e.code !== 'ENOSPC' && e.code !== 'EDQUOT') throw e
  }
}
const child = spawn(
  process.execPath,
  ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', 'web', ...process.argv.slice(2)],
  {
    cwd: root,
    env: { ...process.env, DSH_HOME: home, DSH_PI_SESSION_DIR: directory },
    stdio: ['inherit', 'pipe', 'pipe'],
    windowsHide: true,
  },
)
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal))
child.stdout.pipe(process.stdout)
child.stderr.pipe(process.stderr)
child.stdout.on('data', append)
child.stderr.on('data', append)
child.on('error', (error) => append(Buffer.from(error.message + '\n')))
child.on('close', (code) => {
  closeSync(fd)
  process.exitCode = code ?? 1
})
