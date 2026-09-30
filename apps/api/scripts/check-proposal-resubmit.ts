/**
 * A withdrawn bid must free the freelancer's one slot on a job (PRD F2).
 *
 * The unique index behind this was UNCONDITIONAL, so pulling a bid left the
 * freelancer occupying the slot permanently: the job page showed the propose
 * form again (it filtered `status !== "withdrawn"`) and every resubmit 409'd
 * `duplicate_proposal` with no way forward.
 *
 * This drives the real constraint against the real database, because the bug
 * lived in the interaction between a partial unique index and a write-path
 * guard — neither alone would have shown it. Seeds its own fixture when the
 * devnet is empty, and removes everything it created.
 */
process.env.NODE_ENV ??= 'test'
import postgres from 'postgres'
import { LIVE_PROPOSAL_STATUSES } from '../src/db/schema.ts'

const DB = postgres(process.env.DATABASE_URL!, { max: 1 })

let pass = 0
let fail = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    pass++
    console.log(`✓ ${name}`)
  } else {
    fail++
    console.log(`✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

interface Pair {
  jobId: string
  freelancerId: string
  /** Ids created by this check, so cleanup can remove exactly those. */
  seededJobs: string[]
  seededUsers: string[]
}

async function obtainPair(): Promise<Pair> {
  const found = await DB`
    SELECT j.id AS job_id, u.id AS freelancer_id
    FROM jobs j
    JOIN users u ON u.role = 'freelancer' AND u.kyc_status = 'verified'
    WHERE j.status = 'open' AND j.poster_id <> u.id
      AND NOT EXISTS (
        SELECT 1 FROM proposals p
        WHERE p.job_id = j.id AND p.freelancer_id = u.id AND p.status IN ('submitted','accepted')
      )
    LIMIT 1
  `
  const row = found[0] as { job_id: string; freelancer_id: string } | undefined
  if (row) return { jobId: row.job_id, freelancerId: row.freelancer_id, seededJobs: [], seededUsers: [] }

  const [poster] = await DB`
    INSERT INTO users (wallet_address, role, kyc_status, display_name)
    VALUES ('0x00000000000000000000000000000000c0de0001', 'client', 'verified', 'check: poster')
    ON CONFLICT (wallet_address) DO UPDATE SET kyc_status = 'verified'
    RETURNING id
  `
  const [freelancer] = await DB`
    INSERT INTO users (wallet_address, role, kyc_status, display_name)
    VALUES ('0x00000000000000000000000000000000f2ee0001', 'freelancer', 'verified', 'check: freelancer')
    ON CONFLICT (wallet_address) DO UPDATE SET kyc_status = 'verified'
    RETURNING id
  `
  const [job] = await DB`
    INSERT INTO jobs (poster_id, title, description, category, skills, status, budget_max_wei, published_at)
    VALUES (${poster!.id}, 'check: resubmit probe', 'Fixture for check:proposal-resubmit.',
            'backend', ARRAY[]::text[], 'open', 1000000000000000000, now())
    RETURNING id
  `
  // Only the job is ours to delete. The two user rows came back through
  // ON CONFLICT DO UPDATE, so they may predate this check — deleting them would
  // take real demo data with it.
  return { jobId: job!.id, freelancerId: freelancer!.id, seededJobs: [job!.id], seededUsers: [] }
}

async function main() {
  const { jobId, freelancerId, seededJobs, seededUsers } = await obtainPair()

  try {
    // The guard and the index must agree, or a concurrent double-submit turns
    // the real constraint violation into a 500 instead of a readable 409.
    check('the write guard uses a shared list of live statuses', Array.isArray(LIVE_PROPOSAL_STATUSES))
    check(
      'the live statuses are the ones that occupy the slot',
      LIVE_PROPOSAL_STATUSES.includes('submitted') && LIVE_PROPOSAL_STATUSES.includes('accepted')
        && !LIVE_PROPOSAL_STATUSES.includes('withdrawn') && !LIVE_PROPOSAL_STATUSES.includes('rejected'),
      [...LIVE_PROPOSAL_STATUSES].join(','),
    )

    const idx = await DB`
      SELECT indexdef FROM pg_indexes WHERE indexname = 'proposals_job_freelancer_idx'
    `
    const def = idx[0]?.indexdef ?? ''
    check('the unique index exists', !!def, 'proposals_job_freelancer_idx missing')
    check(
      'the index is PARTIAL — withdrawn/rejected rows must not be covered',
      def.includes('submitted') && def.includes('accepted') && !def.includes('withdrawn'),
      def,
    )

    // A live bid still holds the slot.
    const [{ id: first }] = await DB`
      INSERT INTO proposals (job_id, freelancer_id, cover_note, bid_total_wei, delivery_days, status)
      VALUES (${jobId}, ${freelancerId}, 'check: probe', 1, 1, 'submitted')
      RETURNING id
    `
    let blockedLive = false
    try {
      await DB`
        INSERT INTO proposals (job_id, freelancer_id, cover_note, bid_total_wei, delivery_days, status)
        VALUES (${jobId}, ${freelancerId}, 'check: second live bid', 1, 1, 'submitted')
      `
    } catch {
      blockedLive = true
    }
    check('a second LIVE bid on the same job is still refused', blockedLive)

    // Withdrawing frees it — this is the bug.
    await DB`UPDATE proposals SET status = 'withdrawn' WHERE id = ${first}`
    let allowedAfterWithdraw = false
    try {
      const [{ id: second }] = await DB`
        INSERT INTO proposals (job_id, freelancer_id, cover_note, bid_total_wei, delivery_days, status)
        VALUES (${jobId}, ${freelancerId}, 'check: bid again', 1, 1, 'submitted')
        RETURNING id
      `
      allowedAfterWithdraw = !!second
    } catch (err) {
      check('a bid after withdrawing is allowed', false, (err as Error).message)
    }
    check('a bid after withdrawing is allowed', allowedAfterWithdraw)

    // And a rejected row frees it too.
    const rejected = await DB`
      SELECT 1 FROM proposals
      WHERE job_id = ${jobId} AND freelancer_id = ${freelancerId} AND status = 'rejected'
      LIMIT 1
    `
    check('the check leaves no rejected row behind to confuse the next run', rejected.length === 0)
  } finally {
    await DB`DELETE FROM proposals WHERE job_id = ${jobId} AND freelancer_id = ${freelancerId}`
    for (const id of seededJobs) await DB`DELETE FROM jobs WHERE id = ${id}`
    for (const id of seededUsers) await DB`DELETE FROM users WHERE id = ${id}`
    await DB.end()
  }

  console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch(async (err) => {
  console.error(err)
  await DB.end().catch(() => {})
  process.exit(1)
})
