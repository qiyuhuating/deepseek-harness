/** Axiom keyset pagination over durable, session-owned Harness job summaries. */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { JobView } from '@deepseek-ai/dsh-jobs'

export class JobHistory {
  private readonly db: DatabaseSync
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(join(directory, 'jobs.sqlite'))
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS jobs(seq INTEGER PRIMARY KEY,id TEXT UNIQUE NOT NULL,owner TEXT NOT NULL,summary TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS jobs_owner_seq ON jobs(owner,seq)`)
  }
  save(owner: string, job: JobView): void {
    const { id, kind, label, status, startedAt, finishedAt } = job
    this.db
      .prepare(
        'INSERT INTO jobs(id,owner,summary) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET summary=excluded.summary',
      )
      .run(id, owner, JSON.stringify({ id, kind, label, status, startedAt, finishedAt }))
  }
  page(owner: string, cursor: string | undefined, limit: number): string {
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 200 ||
      (cursor !== undefined && (!/^[1-9]\d{0,18}$/.test(cursor) || BigInt(cursor) > 9223372036854775807n))
    )
      throw Error('Invalid task history page')
    const rows = this.db
      .prepare(
        `SELECT seq,CAST(seq AS TEXT) AS cursor,summary FROM jobs WHERE owner=? AND seq<=?
         UNION ALL SELECT seq,CAST(seq AS TEXT),summary FROM jobs WHERE owner='' AND ?<>'' AND seq<=?
         ORDER BY seq DESC LIMIT ?`,
      )
      .all(owner, cursor ?? '9223372036854775807', owner, cursor ?? '9223372036854775807', limit + 1)
    const nextCursor = rows.length > limit ? rows.pop()?.cursor : null
    return JSON.stringify({ jobs: rows.map((row) => JSON.parse(String(row.summary))), nextCursor })
  }
  close(): void {
    this.db.close()
  }
}
