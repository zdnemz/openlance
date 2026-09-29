/**
 * Self-check for the database integrity constraints (run: pnpm check:db).
 *
 * The API has no test suite, so a constraint is only "verified" by asserting the
 * live database actually enforces it. Every check is a behavioural proof: attempt
 * a write that MUST be rejected and confirm it was. A constraint present in
 * schema.ts but missing from the applied migration is exactly the drift this
 * catches — which is why these run against the real DB, not a schema snapshot.
 *
 * Needs a reachable DATABASE_URL with current migrations applied (`pnpm db:migrate`).
 * Every row it creates is removed in the `finally` block.
 */
import { eq } from 'drizzle-orm'
import { getDb, execSql, closeDb } from '../src/db/index.ts'
import {
  attachments, disputes, jobs, messages,
  projectMilestones, projects, proposals, reviews, users,
} from '../src/db/schema.ts'

let failures = 0
function check(name: string, ok: boolean, extra = '') {
  if (!ok) { console.error(`✗ ${name}${extra ? ` — ${extra}` : ''}`); failures++ }
  else console.log(`✓ ${name}`)
}

/** True when the database rejected `fn`. */
async function rejects(fn: () => Promise<unknown>): Promise<boolean> {
  try { await fn(); return false } catch { return true }
}

const rows = <T>(r: unknown): T[] => (Array.isArray(r) ? r as T[] : [])
const addr = (tag: string) => `0x${tag.repeat(40)}`
const stamp = Date.now()

const db = getDb()
const [client] = await db.insert(users).values({
  walletAddress: addr('c'), displayName: `checkdb-client-${stamp}`,
}).returning()
const [freelancer] = await db.insert(users).values({
  walletAddress: addr('d'), displayName: `checkdb-freelancer-${stamp}`,
}).returning()

/**
 * A real parent chain, so the "this write must be ACCEPTED" controls below are
 * actually legal. A positive control built on `crypto.randomUUID()` FKs fails
 * the FOREIGN KEY instead of the CHECK, which makes the control meaningless —
 * it cannot tell "rejected by the constraint" from "rejected by a dangling ref".
 *
 * `projects.job_id` is UNIQUE, so the job that backs the project also carries
 * the proposal the project hangs off.
 */
const [jobB] = await db.insert(jobs).values({
  posterId: client!.id, title: 'checkdb-b', description: 'x', category: 'x',
  budgetMinWei: '0', budgetMaxWei: '1000',
}).returning()
const [proposal] = await db.insert(proposals).values({
  jobId: jobB!.id, freelancerId: freelancer!.id, coverNote: 'x',
  bidTotalWei: '0', deliveryDays: 1,
}).returning()
const [project] = await db.insert(projects).values({
  jobId: jobB!.id, proposalId: proposal!.id,
  clientId: client!.id, freelancerId: freelancer!.id,
}).returning()
const [milestone] = await db.insert(projectMilestones).values({
  projectId: project!.id, position: 0, title: 'x', description: 'x', amountWei: '0',
}).returning()

try {
  // ── 1. Money can never be negative — every wei amount is a uint256 on-chain,
  //       where a negative value is not expressible, so it is always a bug.
  check('negative milestone amount is rejected',
    await rejects(() => db.insert(projectMilestones).values({
      projectId: crypto.randomUUID(), position: 0, title: 'x', description: 'x', amountWei: '-1',
    })))
  check('negative user balance is rejected',
    await rejects(() => db.insert(users).values({
      walletAddress: addr('e'), displayName: `checkdb-neg-${stamp}`, totalEarnedWei: '-1',
    })))
  check('negative dispute round index is rejected',
    await rejects(() => db.insert(disputes).values({
      milestoneId: crypto.randomUUID(), projectId: crypto.randomUUID(),
      openedById: client!.id, round: -1,
    })))
  // Zero is a legal amount (a free milestone), so the check must not over-reach.
  check('zero amount is still accepted',
    !await rejects(() => db.insert(projectMilestones).values({
      projectId: project!.id, position: 9, title: 'x', description: 'x', amountWei: '0',
    })))

  // ── 2. Ranges the edge validation also enforces; this is the storage backstop
  //       for any other writer (a script, an import, a future admin path).
  const rate = (rating: number) => () => db.insert(reviews).values({
    milestoneId: crypto.randomUUID(), reviewerId: client!.id,
    revieweeId: freelancer!.id, rating, txHash: '0xdead',
  })
  check('review rating 0 is rejected', await rejects(rate(0)))
  check('review rating 6 is rejected', await rejects(rate(6)))
  // Positive controls: a legal write must still succeed, or the CHECKs are
  // rejecting valid data and the whole table is unusable.
  check('review rating 3 is accepted', !await rejects(() => db.insert(reviews).values({
    milestoneId: milestone!.id, reviewerId: client!.id,
    revieweeId: freelancer!.id, rating: 3, txHash: '0xdead',
  })))
  check('inverted job budget (max < min) is rejected',
    await rejects(() => db.insert(jobs).values({
      posterId: client!.id, title: 'x', description: 'x', category: 'x',
      budgetMinWei: '100', budgetMaxWei: '50',
    })))

  // ── 3. Referential integrity. `messages.attachment_id` used to be a bare
  //       uuid, so a message could point at an attachment that never existed.
  check('message pointing at a nonexistent attachment is rejected',
    await rejects(() => db.insert(messages).values({
      projectId: crypto.randomUUID(), senderId: client!.id, body: 'x',
      attachmentId: crypto.randomUUID(),
    })))
  check('attachment with empty storage_path is rejected',
    await rejects(() => db.insert(attachments).values({
      projectId: project!.id, uploaderId: client!.id, filename: 'b.txt',
      mimeType: 'text/plain', sizeBytes: 1, storageDriver: 'local', storagePath: '',
    })))
  // An attachment has exactly one owner. Both set means the read guard has to
  // pick; neither set means it has no scope at all and anyone can guess an id.
  check('attachment owned by a project AND a proposal is rejected',
    await rejects(() => db.insert(attachments).values({
      projectId: project!.id, proposalId: proposal!.id, uploaderId: client!.id,
      filename: 'both.txt', mimeType: 'text/plain', sizeBytes: 1,
      storageDriver: 'local', storagePath: 'p/both.txt',
    })))
  check('attachment with no owner is rejected',
    await rejects(() => db.insert(attachments).values({
      uploaderId: client!.id, filename: 'none.txt', mimeType: 'text/plain',
      sizeBytes: 1, storageDriver: 'local', storagePath: 'p/none.txt',
    })))
  // Positive control: each owner on its own is a legal write.
  check('a proposal-owned attachment is accepted',
    !await rejects(() => db.insert(attachments).values({
      proposalId: proposal!.id, uploaderId: freelancer!.id, filename: 'bid.pdf',
      mimeType: 'application/pdf', sizeBytes: 1, storageDriver: 'local',
      storagePath: `${proposal!.id}/bid.pdf`,
    })))

  // ── 4. Structure that a behavioural write cannot prove.
  const pk = rows<{ n: number }>(await execSql(`
    select count(*)::int as n from information_schema.table_constraints
    where table_name = 'submission_attachments' and constraint_type = 'PRIMARY KEY'`))
  check('submission_attachments has a primary key', (pk[0]?.n ?? 0) > 0)

  const dead = rows<{ column_name: string }>(await execSql(`
    select column_name from information_schema.columns
    where table_name = 'disputes' and column_name in (
      'client_proposed_arbiter', 'freelancer_proposed_arbiter', 'agreed_arbiter',
      'admin_assigned_arbiter', 'agreement_deadline', 'majority_arbiters')`))
  check('dead dispute columns are dropped', dead.length === 0, `found ${dead.map((d) => d.column_name).join(', ')}`)

  // ── 4b. No jsonb column may sit permanently at its default. The bug this
  //        catches: `majority_arbiters` was jsonb NOT NULL DEFAULT '[]', and
  //        NOTHING ever wrote it, so the project page read an always-empty array
  //        and printed "majority 0 arbiter(s)" on every settled dispute —
  //        impossible, since settlement needs a 2-of-3 quorum.
  //
  //        SQL cannot tell "defaulted but written" from "defaulted and never
  //        written", so this pins the exact reviewed set instead: adding a
  //        defaulted jsonb array is a deliberate act that requires listing it
  //        here, which is exactly the review that majority_arbiters skipped.
  const EXPECTED_DEFAULTED_JSONB = new Set([
    'projects.chosen_arbiters',        // written by project-arbiters.ts
    'disputes.selected_arbiters',      // written by the indexer on ArbitersSelected
    'disputes.committed_arbiters',     // no contract view; indexer-derived by design
    'disputes.revealed_arbiters',      // no contract view; indexer-derived by design
  ])
  const defaulted = rows<{ table: string; column: string }>(await execSql(`
    select c.relname as table, a.attname as column
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    where n.nspname = 'public'
      and a.atttypid = 'jsonb'::regtype
      and a.attnotnull
      and pg_get_expr(d.adbin, d.adrelid) like '%''[]''%'`))
  const unexpected = defaulted
    .map((d) => `${d.table}.${d.column}`)
    .filter((c) => !EXPECTED_DEFAULTED_JSONB.has(c))
  const missing = [...EXPECTED_DEFAULTED_JSONB].filter((c) => !defaulted.some((d) => `${d.table}.${d.column}` === c))
  check('defaulted jsonb arrays match the reviewed set', unexpected.length === 0 && missing.length === 0,
    [...unexpected.map((c) => `unexpected ${c}`), ...missing.map((c) => `missing ${c}`)].join(', '))

  // ── 5. Every FK column is indexed. An unindexed FK turns a parent DELETE
  //       into a seq-scan of the child table, and this schema deletes users
  //       (cascade to projects, messages, subscriptions) routinely.
  const unindexed = rows<{ table: string; column: string }>(await execSql(`
    select ccu.table_name as table, ccu.column_name as column
    from information_schema.table_constraints tc
    join information_schema.constraint_column_usage ccu
      on ccu.constraint_name = tc.constraint_name
     and ccu.constraint_schema = tc.constraint_schema
    where tc.constraint_type = 'FOREIGN KEY'
      and tc.table_schema = 'public'
      and not exists (
        select 1
        from pg_index i
        join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
        where i.indrelid = format('%I.%I', tc.table_schema, ccu.table_name)::regclass
          and a.attname = ccu.column_name
          and i.indisvalid
      )`))
  check('every FK column is indexed', unindexed.length === 0,
    unindexed.map((u) => `${u.table}.${u.column}`).join(', '))

  // ── 6. A legal write still round-trips: prove the constraints did not
  //       over-reach and break the happy path.
  const [job] = await db.insert(jobs).values({
    posterId: client!.id, title: 'checkdb', description: 'x', category: 'x',
    budgetMinWei: '0', budgetMaxWei: '1000',
  }).returning()
  const [back] = await db.select({ max: jobs.budgetMaxWei }).from(jobs).where(eq(jobs.id, job!.id))
  check('a legal job still round-trips its budget', back?.max === '1000', `got ${back?.max}`)
} finally {
  // Order matters. `projects.client_id` and `reviews.reviewer_id` carry NO
  // onDelete (NO ACTION), so deleting the users first would abort on the FK.
  // Deleting the project cascades to milestones → reviews, and from there to
  // messages, disputes, attachments and submissions.
  await execSql(`delete from projects where client_id in (select id from users where display_name like 'checkdb-%')`)
  // The proposal-owned attachment above cascades from its proposal, which
  // cascades from the job, and the jobs cascade from the poster.
  await execSql(`delete from jobs where poster_id in (select id from users where display_name like 'checkdb-%')`)
  await execSql(`delete from users where display_name like 'checkdb-%'`)
  await closeDb()
}

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1) }
console.log('\nAll database integrity checks passed')
