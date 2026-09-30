/**
 * Self-check for chain-generation tracking (run: pnpm check:generation).
 *
 * The API has no test suite, so — like `check-db-integrity.ts` — this proves the
 * behaviour against the live database rather than against a schema snapshot. The
 * failure it guards is silent by nature: a mirror left pointing at a chain that
 * no longer exists produces no error, no log, and no write. The indexer simply
 * returns an empty pass forever while the UI keeps showing the last chain's state.
 *
 * Everything it creates is removed in the `finally` block, and the generation
 * marker + checkpoint are restored to their prior values.
 */
import { eq } from 'drizzle-orm'
import { getDb, closeDb } from '../src/db/index.ts'
import { indexerState, jobs, projectMilestones, projects, proposals, users } from '../src/db/schema.ts'
import { detectGeneration, resetMirrorForNewChain, canAutoReset } from '../src/chain/generation.ts'
import { getChainAdapter } from '../src/chain/adapter.ts'
import type { ChainAdapter } from '../src/chain/adapter.ts'

let failures = 0
function check(name: string, ok: boolean, extra = '') {
  if (ok) console.log(`✓ ${name}`)
  else { console.error(`✗ ${name}${extra ? ` — ${extra}` : ''}`); failures++ }
}

const CHECKPOINT_ID = 'escrow'
const addr = (tag: string) => `0x${tag.repeat(40)}`
const stamp = Date.now()

/** A stub adapter: generation detection only reads `escrowAddress`. */
const stub = (escrowAddress: string): ChainAdapter =>
  ({ mode: 'real', escrowAddress, chainId: 31337 } as unknown as ChainAdapter)

const db = getDb()
const live = getChainAdapter()

if (live.mode !== 'real') {
  console.log('check:generation needs CHAIN_MODE=real (the live escrow address is the thing under test) — skipped')
  await closeDb()
  process.exit(0)
}

const [prior] = await db.select().from(indexerState).where(eq(indexerState.id, CHECKPOINT_ID)).limit(1)
const savedAddress = prior?.contractAddress ?? null
const savedBlock = prior?.lastBlock ?? 0
const [user] = await db.insert(users).values({
  walletAddress: addr('a'), displayName: `checkgen-${stamp}`,
}).returning()

async function putCheckpoint(lastBlock: number, contractAddress: string | null) {
  await db.insert(indexerState)
    .values({ id: CHECKPOINT_ID, lastBlock, contractAddress, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: indexerState.id,
      set: { lastBlock, contractAddress, updatedAt: new Date() },
    })
}

/**
 * A real parent chain, so the milestone insert exercises the onchain_id claim and
 * not the FOREIGN KEY. `projects.job_id` is UNIQUE, so one job carries the
 * proposal the project hangs off.
 */
const [client] = await db.insert(users).values({
  walletAddress: addr('c'), displayName: `checkgen-client-${stamp}`,
}).returning()
const [freelancer] = await db.insert(users).values({
  walletAddress: addr('d'), displayName: `checkgen-freelancer-${stamp}`,
}).returning()
const [job] = await db.insert(jobs).values({
  posterId: client!.id, title: 'checkgen', description: 'x', category: 'x',
  budgetMinWei: '0', budgetMaxWei: '1000',
}).returning()
const [proposal] = await db.insert(proposals).values({
  jobId: job!.id, freelancerId: freelancer!.id, coverNote: 'x',
  bidTotalWei: '0', deliveryDays: 1,
}).returning()
const [project] = await db.insert(projects).values({
  jobId: job!.id, proposalId: proposal!.id,
  clientId: client!.id, freelancerId: freelancer!.id,
}).returning()

/** A row that claims an onchain id, so the rebuild has something to clear. */
const [milestone] = await db.insert(projectMilestones).values({
  projectId: project!.id, position: 0, title: 'x', description: 'x',
  amountWei: '0', onchainId: 999_999, chainStatus: 'funded',
}).returning()

try {
  const liveAddress = live.escrowAddress.toLowerCase()

  // ── 1. A NULL marker must ADOPT, never reset. Shipping the column cannot be
  //       allowed to retroactively wipe a live mirror on its first tick.
  await putCheckpoint(savedBlock, null)
  const adopted = await detectGeneration(stub(liveAddress), 10_000)
  check('a checkpoint with no recorded address is adopted, not reset',
    adopted.kind === 'adopt', `got ${adopted.kind}`)

  // ── 2. Same address + checkpoint below tip → unchanged.
  await putCheckpoint(500, liveAddress)
  const same = await detectGeneration(stub(liveAddress), 10_000)
  check('the same address at a sane height is the same generation',
    same.kind === 'same', `got ${same.kind}`)

  // ── 3. Address changed → a new generation, whatever the height says. CHAIN_ID
  //       is 31337 on every anvil boot, so the address is the only signal here.
  const byAddress = await detectGeneration(stub(addr('b')), 10_000)
  check('a changed escrow address is a new generation',
    byAddress.kind === 'changed' && byAddress.signals.includes('address'),
    `got ${byAddress.kind}/${'signals' in byAddress ? byAddress.signals.join(',') : ''}`)

  // ── 4. Checkpoint ABOVE tip → a new generation, same address. A real chain
  //       only grows, so this is the wedge that silently killed the indexer:
  //       checkpoint 2665 against a tip of 586.
  const byHeight = await detectGeneration(stub(liveAddress), 100)
  check('a checkpoint above the chain tip is a new generation',
    byHeight.kind === 'changed' && byHeight.signals.includes('height'),
    `got ${byHeight.kind}/${'signals' in byHeight ? byHeight.signals.join(',') : ''}`)

  // Both signals at once is still one verdict, not two rebuilds.
  const both = await detectGeneration(stub(addr('c')), 100)
  check('both signals together still yield a single verdict',
    both.kind === 'changed' && both.signals.length === 2,
    `got ${both.kind}/${'signals' in both ? both.signals.join(',') : ''}`)

  // The rebuild takes a 'changed' verdict specifically — a 'fresh' or 'same' one
  // would have nothing to reset. Narrowing here keeps that contract honest.
  if (both.kind !== 'changed') {
    console.error('✗ expected a changed verdict to exercise the rebuild against')
    failures++
  }

  // ── 5. The rebuild clears chain claims and preserves the human record.
  if (both.kind === 'changed') {
    const cleared = await resetMirrorForNewChain(both)
    const [after] = await db.select().from(projectMilestones).where(eq(projectMilestones.id, milestone!.id)).limit(1)
    check('a rebuild releases the onchain id', after?.onchainId === null, `got ${after?.onchainId}`)
    check('a rebuild returns the milestone to pending_funding',
      after?.chainStatus === 'pending_funding', `got ${after?.chainStatus}`)
    check('a rebuild clears the funding proof too',
      after?.fundedTxHash === null && after?.fundedAt === null)
    check('a rebuild counts what it cleared', cleared.milestones >= 1, `got ${cleared.milestones}`)
    const [cp] = await db.select().from(indexerState).where(eq(indexerState.id, CHECKPOINT_ID)).limit(1)
    check('a rebuild rewinds the checkpoint to 0', cp?.lastBlock === 0, `got ${cp?.lastBlock}`)
    check('a rebuild records the live address', cp?.contractAddress?.toLowerCase() === both.liveAddress)

    // ── 6. Derived stats are chain-derived: with the ledger gone they have no
    //       basis, so they must not keep paying out the previous chain's
    //       settlements.
    const [withTotals] = await db.insert(users).values({
      walletAddress: addr('e'), displayName: `checkgen-totals-${stamp}`,
      totalEarnedWei: '12345', totalPaidWei: '999',
    }).returning()
    await resetMirrorForNewChain(both)
    const [zeroed] = await db.select().from(users).where(eq(users.id, withTotals!.id)).limit(1)
    check('a rebuild zeroes chain-derived payouts',
      zeroed?.totalEarnedWei === '0' && zeroed?.totalPaidWei === '0',
      `earned=${zeroed?.totalEarnedWei} paid=${zeroed?.totalPaidWei}`)
  }

  // ── 7. The user row must survive — this is not db:flush.
  const [survivor] = await db.select().from(users).where(eq(users.id, user!.id)).limit(1)
  check('a rebuild preserves off-chain records', !!survivor)

  check('auto-reset is disabled in production',
    canAutoReset() === (process.env.NODE_ENV !== 'production'),
    `NODE_ENV=${process.env.NODE_ENV}`)
} catch (err) {
  console.error('✗ check threw:', err instanceof Error ? err.message : err)
  failures++
} finally {
  // Same teardown order as check-db-integrity.ts: the milestone cascades from the
  // project, the project and job reference users with NO ACTION, so the users go last.
  await db.delete(projectMilestones).where(eq(projectMilestones.id, milestone!.id)).catch(() => {})
  await db.delete(projects).where(eq(projects.id, project!.id)).catch(() => {})
  await db.delete(proposals).where(eq(proposals.id, proposal!.id)).catch(() => {})
  await db.delete(jobs).where(eq(jobs.id, job!.id)).catch(() => {})
  await db.delete(users).where(eq(users.displayName, `checkgen-${stamp}`)).catch(() => {})
  await db.delete(users).where(eq(users.displayName, `checkgen-client-${stamp}`)).catch(() => {})
  await db.delete(users).where(eq(users.displayName, `checkgen-freelancer-${stamp}`)).catch(() => {})
  await db.delete(users).where(eq(users.displayName, `checkgen-totals-${stamp}`)).catch(() => {})
  // Leave the checkpoint exactly as found — this script shares the dev database.
  await putCheckpoint(savedBlock, savedAddress)
  await closeDb()
}

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1) }
console.log('\nAll chain-generation checks passed')
