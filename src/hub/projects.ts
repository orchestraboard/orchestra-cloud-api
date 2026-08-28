import { randomUUID } from 'node:crypto'
import { ConflictError } from './errors.js'
import { withTransaction, type HubSql, type HubSqlPool } from './sql.js'
import { boundedString, optionalBoundedString } from './validate.js'

/**
 * Projects and boards — the thing every other org-scoped write needs to already exist.
 *
 * Until this module, nothing under src/hub/ ever inserted into `projects` or `boards`:
 * every op that writes takes a `board_id` and `requireOrgEntity` (scope.ts) refuses one
 * that isn't already in the org, so a customer who paid and signed in had no board to
 * point a daemon at and no way to make one. Tests never caught it because they seed
 * boards with raw SQL (test/support/hub-sql.ts). Two callers close that gap: the
 * authenticated route in server.ts, and `ensureDefaultProject` from the Clerk
 * `organization.created` webhook, so an org has a board from the moment it exists.
 */

export interface HubProject {
  id: string
  org_id: string
  name: string
  repo_fingerprint: string | null
  created_at: string
}

export interface HubBoardRow {
  id: string
  org_id: string
  project_id: string
  name: string
  created_at: string
}

/** What a board looks like in the listing route — the project's name is joined in so a
 * client can label it without a second round trip. */
export interface HubBoardListing extends HubBoardRow {
  project_name: string
}

export interface CreateProjectInput {
  orgId: string
  name: string
  /** Defaults to the project's own name — one board per project is the shape the product
   * ships with (see HubBoard.tsx's "one shared project board per org"); the schema allows
   * more per project for later. */
  boardName?: string
  repoFingerprint?: string
}

/** The project (and board) an org gets automatically when it is created in Clerk, so a
 * customer is never dropped onto a board picker with nothing in it. Named, not derived
 * from the org name, so `ensureDefaultProject` can recognize its own prior run on a
 * webhook replay without depending on the org name staying the same. */
export const DEFAULT_PROJECT_NAME = 'Default project'

/**
 * Creates one project and its first board in a single transaction — a project with no
 * board is useless (nothing can reference it), so the two are never created separately.
 *
 * A duplicate name is a `ConflictError` (409), not a 500: `projects` carries a
 * `UNIQUE (org_id, name)` constraint, and "you already have a project called that" is a
 * legitimate, expected request state a caller can act on, exactly like `cards.ts`'s
 * optimistic-concurrency conflicts.
 */
export async function createProject(
  sql: HubSqlPool, input: CreateProjectInput,
): Promise<{ project: HubProject; board: HubBoardRow }> {
  const name = boundedString(input.name, 'name', 120)
  const boardName = optionalBoundedString(input.boardName, 'board_name', 120) ?? name
  const repoFingerprint = optionalBoundedString(input.repoFingerprint, 'repo_fingerprint', 200) ?? null

  return withTransaction(sql, async (tx) => {
    const project = await insertProject(tx, input.orgId, name, repoFingerprint)
    if (!project) {
      throw new ConflictError(`a project named ${JSON.stringify(name)} already exists in this org`)
    }
    const board = await insertBoard(tx, input.orgId, project.id, boardName)
    return { project, board }
  })
}

/**
 * Creates the default project/board for `orgId` if — and only if — the org has no project
 * yet. Returns what it created, or null when it found one and did nothing.
 *
 * Called from the Clerk `organization.created` handler, which Clerk retries and can replay:
 * this runs inside that handler's transaction, after its `orgs` upsert has already written
 * (and therefore row-locked) the org, so a replay of the same webhook — or two deliveries
 * racing — cannot produce two default projects. The `ON CONFLICT (org_id, name) DO NOTHING`
 * inside `insertProject` is the second line of defense if it is ever called outside such a
 * transaction.
 */
export async function ensureDefaultProject(
  tx: HubSql, orgId: string,
): Promise<{ project: HubProject; board: HubBoardRow } | null> {
  const existing = await tx.query<{ id: string }>('SELECT id FROM projects WHERE org_id = $1 LIMIT 1', [orgId])
  if (existing.rows[0]) return null

  const project = await insertProject(tx, orgId, DEFAULT_PROJECT_NAME, null)
  if (!project) return null
  const board = await insertBoard(tx, orgId, project.id, DEFAULT_PROJECT_NAME)
  return { project, board }
}

/** Every board in the org, newest project last. Exists so a client (and the runbook's smoke
 * test) can discover a real `board_id` instead of guessing one — every write op requires it. */
export async function listBoards(sql: HubSql, orgId: string): Promise<HubBoardListing[]> {
  const result = await sql.query<HubBoardListing>(
    `SELECT b.id, b.org_id, b.project_id, b.name, b.created_at, p.name AS project_name
     FROM boards b JOIN projects p ON p.id = b.project_id
     WHERE b.org_id = $1
     ORDER BY b.created_at ASC, b.id ASC`,
    [orgId],
  )
  return result.rows
}

/** Returns null when the org already has a project with this name — the caller decides
 * whether that is a conflict (an explicit create) or a no-op (the default-project path). */
async function insertProject(
  tx: HubSql, orgId: string, name: string, repoFingerprint: string | null,
): Promise<HubProject | null> {
  const inserted = await tx.query<HubProject>(
    `INSERT INTO projects (id, org_id, name, repo_fingerprint)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (org_id, name) DO NOTHING
     RETURNING id, org_id, name, repo_fingerprint, created_at`,
    [`proj_${randomUUID()}`, orgId, name, repoFingerprint],
  )
  return inserted.rows[0] ?? null
}

async function insertBoard(tx: HubSql, orgId: string, projectId: string, name: string): Promise<HubBoardRow> {
  const inserted = await tx.query<HubBoardRow>(
    `INSERT INTO boards (id, org_id, project_id, name)
     VALUES ($1, $2, $3, $4)
     RETURNING id, org_id, project_id, name, created_at`,
    [`board_${randomUUID()}`, orgId, projectId, name],
  )
  return inserted.rows[0]
}
