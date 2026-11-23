import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { JobView } from '@deepseek-ai/dsh-jobs'

/** Stores session-owned job summaries in insertion order. */
export class JobHistory {
  private readonly db: DatabaseSync
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(join(directory, 'jobs.sqlite'))
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS jobs(seq INTEGER PRIMARY KEY,id TEXT UNIQUE NOT NULL,owner TEXT NOT NULL,summary TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS jobs_owner_seq ON jobs(owner,seq)`)
  }
  /** Check whether the durable registry has reserved this id.
   * @param id - Candidate job id.
   * @returns Whether the id already exists.
   */
  has(id: string): boolean {
    return this.db.prepare('SELECT 1 FROM jobs WHERE id=?').get(id) !== undefined
  }
  /** Record the latest lifecycle state while preserving ownership and page order.
   * @param owner - Owning session id, or empty for a shared job.
   * @param job - Current lifecycle projection.
   */
  save(owner: string, job: JobView): void {
    const { id, kind, label, status, startedAt, finishedAt } = job
    const result = this.db
      .prepare(
        'INSERT INTO jobs(id,owner,summary) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET summary=excluded.summary WHERE jobs.owner=excluded.owner',
      )
      .run(id, owner, JSON.stringify({ id, kind, label, status, startedAt, finishedAt }))
    if (result.changes !== 1) throw new Error('Job id belongs to another owner')
  }
  /** Return one page of owned and shared summaries and its continuation cursor.
   * @param owner - Reading session id, or empty for shared jobs only.
   * @param cursor - Continuation from the preceding page.
   * @param limit - Maximum number of summaries to return.
   * @returns Serialized summaries and the next cursor.
   */
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
  /** Release the SQLite connection when the job registry stops. */
  close(): void {
    this.db.close()
  }
}
