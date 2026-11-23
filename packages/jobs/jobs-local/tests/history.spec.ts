import { tmpdir } from 'node:os'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { JobView } from '@deepseek-ai/dsh-jobs'
import { JobHistory } from '../src/history.ts'

it('pages shared and owned jobs across new insertions, status updates and a restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-jobs-'))
  let history = new JobHistory(dir)
  try {
    const save = (owner: string, id: string, status = 'running') =>
      history.save(owner, {
        id,
        label: id,
        kind: 'bash',
        startedAt: 1,
        status,
      } as JobView)
    save('a', 'old')
    save('', 'shared')
    save('b', 'hidden')
    save('a', 'latest')
    const first = JSON.parse(history.page('a', undefined, 2))
    expect(first.jobs.map((j: { id: string }) => j.id)).toEqual([
      'latest',
      'shared',
    ])
    save('a', 'new')
    save('a', 'old', 'completed')
    history.close()
    history = new JobHistory(dir)
    expect(history.has('old')).toBe(true)
    expect(history.has('missing')).toBe(false)
    expect(() => save('b', 'old')).toThrow('Job id belongs to another owner')
    const last = JSON.parse(history.page('a', first.nextCursor, 2))
    expect(last.jobs).toMatchObject([{ id: 'old', status: 'completed' }])
    expect(last.nextCursor).toBeNull()
    expect(JSON.parse(history.page('', undefined, 2)).jobs).toMatchObject([
      { id: 'shared' },
    ])
    expect(() => history.page('a', '-1', 50)).toThrow(
      'Invalid task history page',
    )
  } finally {
    history.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
