/**
 * Self-check: a job whose locked budget is withdrawn must leave the marketplace
 * (run: pnpm check:job-unpublish).
 *
 * `open` is the only status that means "this budget is escrowed" — publish locks
 * the ceiling precisely so a bidder knows the money is there, and `createProposal`
 * caps every bid at that ceiling. `unlockBudget` is a direct wallet call with no
 * server path, so the only observer is the `BudgetUnlocked` log. Before this the
 * indexer filed it as ledger-only and the job stayed in the marketplace with
 * nothing behind it, where an accepted bid would revert on-chain at funding.
 *
 * Needs DATABASE_URL (it writes its own fixtures and removes them again). No
 * chain and no running API: the indexer and the reconcile repair are called
 * in-process — the same entry points `indexer-pump` and the nightly cron use —
 * and the repair gets a stub adapter so it runs without a chain.
 */
import { randomBytes } from 'node:crypto'
import { eq, inArray } from 'drizzle-orm'
import { getDb } from '../src/db/index.ts'
import { ingestEvents } from '../src/chain/indexer.ts'
import { repairUnfundedJobs } from '../src/chain/reconcile.ts'
import type { ChainAdapter } from '../src/chain/adapter.ts'
import { uuidToBytes32, type RawChainLog } from '../src/chain/events.ts'
import { deletableByFunding, fundedForCeiling } from '../src/modules/jobs.ts'
import { jobs, ledgerEvents, users } from '../src/db/schema.ts'

let failures = 0
function check(name: string, ok: boolean, extra: unknown = '') {
  if (ok) console.log(`✓ ${name}`)
  else { console.error(`✗ ${name}`, extra); failures++ }
}

const db = getDb()
const ETH = (10n ** 18n).toString()

const [poster] = await db.select().from(users).where(eq(users.role, 'client')).limit(1)
if (!poster) {
  console.error('need one client user in the DB to run this check')
  process.exit(1)
}

/** Every job this check created, so the cleanup removes exactly those and no others. */
const seeded: { id: string }[] = []
async function seed(fields: Partial<typeof jobs.$inferInsert>) {
  const [job] = await db.insert(jobs).values({
    posterId: poster.id, title: 'check: temporary fixture', description: 'temporary fixture',
    category: 'Engineering', skills: [], budgetMinWei: ETH, budgetMaxWei: ETH,
    depositedAt: new Date(), publishedAt: new Date(),
    ...fields,
  }).returning()
  seeded.push(job!)
  return job!
}

function unlockLog(jobId: string, amount: string, logIndex: number): RawChainLog {
  return {
    name: 'BudgetUnlocked', txHash: `0x${randomBytes(32).toString('hex')}`, logIndex,
    address: '0x' + '11'.repeat(20), chainId: 31337,
    blockNumber: 9_100_000 + logIndex, blockTime: new Date(),
    args: { jobRef: uuidToBytes32(jobId), client: poster.walletAddress, amount },
  } as unknown as RawChainLog
}

/** A stub chain that reports `freeWei` for exactly one jobRef, null for anything else. */
function chainReporting(jobId: string, freeWei: string | null): ChainAdapter {
  return {
    mode: 'real', escrowAddress: '0x' + '11'.repeat(20), chainId: 31337,
    getJobBudget: async (jobRef: string) =>
      jobRef === uuidToBytes32(jobId) && freeWei !== null
        ? { lockedWei: ETH, reservedWei: '0', paidOutWei: '0', freeWei }
        : null,
  } as unknown as ChainAdapter
}

const txHashes: string[] = []
const ingest = async (log: RawChainLog) => { txHashes.push(log.txHash); await ingestEvents([log]) }
const reload = async (id: string) => (await db.select().from(jobs).where(eq(jobs.id, id)))[0]!

try {
  // ── 1. The indexer: a withdrawal off an open job takes it back to draft.
  const open = await seed({ title: 'check: withdrawal unpublishes', status: 'open', depositAmountWei: ETH, depositTxHash: `0x${'ab'.repeat(32)}` })
  const firstLog = unlockLog(open.id, ETH, 0)
  await ingest(firstLog)

  const unpublished = await reload(open.id)
  check('a withdrawn open job goes back to draft', unpublished.status === 'draft', unpublished.status)
  // The funding ledger described the lock that just went away; leaving it set
  // would advertise a deposit this job no longer has.
  check('the deposit ledger is cleared with it',
    unpublished.depositAmountWei === null && unpublished.depositTxHash === null
    && unpublished.depositedAt === null && unpublished.publishedAt === null,
    { deposit: unpublished.depositAmountWei, tx: unpublished.depositTxHash })

  // ── 2. Re-ingesting the same log (same tx_hash + log_index) is a no-op, like
  //      every other chain event.
  const replay = await ingestEvents([firstLog])
  check('replaying the withdrawal changes nothing', replay.duplicates === 1 && replay.applied === 0, replay)
  check('and the job is still a draft', (await reload(open.id)).status === 'draft')

  // ── 3. A partial withdrawal counts too — the ceiling is no longer covered, so
  //      a bid at it would revert at funding time.
  await ingest(unlockLog(open.id, '1', 1))
  check('a partial withdrawal does not re-publish it', (await reload(open.id)).status === 'draft')

  // ── 4. An awarded job is a project, not a listing: the surplus return is the
  //      ordinary one and must not touch it.
  const awarded = await seed({ title: 'check: awarded surplus stays', status: 'in_progress', depositAmountWei: ETH, depositTxHash: `0x${'cd'.repeat(32)}` })
  await ingest(unlockLog(awarded.id, ETH, 2))
  const afterAward = await reload(awarded.id)
  check('an awarded job is untouched by its own surplus return',
    afterAward.status === 'in_progress' && afterAward.depositAmountWei === ETH, afterAward.status)

  // ── 5. The draft that withdrawal left behind can still hold a lock, and the
  //      row must not be deletable while it does — bytes32(job.id) cannot be
  //      re-derived once the job is gone, so that ETH would be stranded forever.
  check('a draft with a balance left locked is not deletable',
    !deletableByFunding(1n).ok && deletableByFunding(1n).reason === 'funding_locked')
  check('a draft with nothing left is deletable', deletableByFunding(0n).ok)

  // ── 6. The rule itself, independent of where it is read from: an unreadable
  //      chain is unknown, never unfunded, so a flaky RPC cannot unpublish a
  //      funded job.
  check('a fully covered ceiling is still funded', fundedForCeiling(BigInt(ETH), BigInt(ETH)))
  check('one wei short of the ceiling is not funded', !fundedForCeiling(BigInt(ETH) - 1n, BigInt(ETH)))
  check('an unreadable chain is not treated as unfunded', fundedForCeiling(null, BigInt(ETH)))

  // ── 7. The nightly repair is the safety net for a withdrawal whose log the
  //      indexer never saw (checkpoint already past it, or the indexer was down).
  const funded = await seed({ title: 'check: reconcile leaves funded alone', status: 'open', depositAmountWei: ETH, depositTxHash: `0x${'ef'.repeat(32)}` })
  const kept = await repairUnfundedJobs(chainReporting(funded.id, ETH))
  check('a fully funded open job is left open',
    (await reload(funded.id)).status === 'open' && !kept.some((d) => d.jobId === funded.id), kept)

  const repaired = await repairUnfundedJobs(chainReporting(funded.id, '0'))
  const repairRow = await reload(funded.id)
  check('an open job the chain no longer covers is unpublished by the repair',
    repairRow.status === 'draft' && repairRow.depositAmountWei === null, repairRow.status)
  check('and it is reported as repaired',
    repaired.some((d) => d.jobId === funded.id && d.action === 'repaired'), repaired)

  const unreadable = await seed({ title: 'check: unreadable chain changes nothing', status: 'open', depositAmountWei: ETH, depositTxHash: `0x${'12'.repeat(32)}` })
  const blind = await repairUnfundedJobs(chainReporting(unreadable.id, null))
  check('an unreadable chain is reported, not acted on',
    (await reload(unreadable.id)).status === 'open'
    && blind.some((d) => d.jobId === unreadable.id && d.action === 'unreachable'), blind)
} finally {
  if (txHashes.length) await db.delete(ledgerEvents).where(inArray(ledgerEvents.txHash, txHashes))
  await db.delete(jobs).where(inArray(jobs.id, seeded.map((j) => j.id)))
}

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1) }
console.log('\nWithdrawing a published budget unpublishes the job — all checks passed')
process.exit(0)
