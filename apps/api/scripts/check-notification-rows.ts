/**
 * Self-check: ONE user action must produce ONE inbox row (run: pnpm check:notification-rows).
 *
 * A single action used to fan out into several notification events describing the
 * same fact — the award emitted `proposal.accepted` AND `project.created`, and one
 * `finalizeDispute` tx emitted both the milestone settlement and `dispute.resolved`
 * (a no-quorum tally emitted both `dispute.finalized` and `dispute.no_quorum`).
 * Two rows for one action reads as a doubled notification and doubles webhook
 * deliveries.
 *
 * Needs DATABASE_URL (it writes its own fixtures and removes them again). No
 * chain, no running API: the module + indexer are called in-process.
 */
import { randomBytes } from 'node:crypto'
import { eq, inArray } from 'drizzle-orm'
import { getDb } from '../src/db/index.ts'
import { signSession } from '../src/lib/jwt.ts'
import { acceptProposal } from '../src/modules/proposals.ts'
import { ingestEvents } from '../src/chain/indexer.ts'
import type { RawChainLog } from '../src/chain/events.ts'
import {
  disputes, jobs, ledgerEvents, notificationEvents, notificationRecipients,
  projectMilestones, projects, proposalMilestones, proposals, users,
} from '../src/db/schema.ts'

let failures = 0
function check(name: string, ok: boolean, extra: unknown = '') {
  if (ok) console.log(`✓ ${name}`)
  else { console.error(`✗ ${name}`, extra); failures++ }
}

const db = getDb()
const ETH = (10n ** 18n).toString()

// ── Fixture: an open job with a submitted proposal. The award itself creates
//    the project; the indexer cases then hang two disputed milestones off it. ──
const seats = await db.select().from(users).where(eq(users.kycStatus, 'verified')).limit(3)
const [client, freelancer, arbiter] = seats
if (!client || !freelancer || !arbiter) {
  console.error('need three verified users in the DB to run this check')
  process.exit(1)
}

const [job] = await db.insert(jobs).values({
  posterId: client.id, title: 'notification rows check', description: 'temporary fixture',
  category: 'Engineering', skills: ['typescript'],
  budgetMinWei: ETH, budgetMaxWei: ETH, status: 'open',
}).returning()
const [proposal] = await db.insert(proposals).values({
  jobId: job!.id, freelancerId: freelancer.id, coverNote: 'temp', deliveryDays: 1, bidTotalWei: ETH,
}).returning()
await db.insert(proposalMilestones).values({ proposalId: proposal!.id, position: 1, title: 'M1', description: 'x', amountWei: ETH })

let projectId = ''
const disputed: { id: string }[] = []

const eventRow = {
  type: notificationEvents.type,
  user: notificationRecipients.userId,
}
const byMilestone = (milestoneId: string) => db.select(eventRow)
  .from(notificationEvents)
  .innerJoin(notificationRecipients, eq(notificationRecipients.eventId, notificationEvents.id))
  .where(eq(notificationEvents.milestoneId, milestoneId))
const byProject = (projectId: string) => db.select(eventRow)
  .from(notificationEvents)
  .innerJoin(notificationRecipients, eq(notificationRecipients.eventId, notificationEvents.id))
  .where(eq(notificationEvents.projectId, projectId))

function chainLog(name: string, txHash: string, logIndex: number, args: Record<string, unknown>): RawChainLog {
  return {
    name, txHash, logIndex, address: '0x' + '11'.repeat(20), chainId: 31337,
    blockNumber: 9_000_000 + logIndex, blockTime: new Date(), args,
  } as unknown as RawChainLog
}

const hashes: string[] = []
try {
  // 1. The award (POST /proposals/:id/accept) — one event, not two.
  const { token } = await signSession({ sub: client.id, address: client.walletAddress })
  const award = await acceptProposal(
    new Request('http://localhost/api/proposals/x/accept', { method: 'POST', headers: { Authorization: `Bearer ${token}` } }),
    proposal!.id,
  )
  projectId = (award as { project: { id: string } }).project.id
  const awardTypes = [...new Set((await byProject(projectId)).map((r) => r.type))]
  check('the award emits exactly one inbox row', awardTypes.length === 1, awardTypes)
  check('that row is proposal.accepted', awardTypes[0] === 'proposal.accepted', awardTypes)
  check('the award does not also emit project.created', !awardTypes.includes('project.created'))

  // Two disputed milestones on rounds that already seated the arbiter, so the
  // indexer cases below have a real party + arbiter audience.
  // The award already created position 1, so the disputed fixtures take 2 + 3.
  for (const [position, onchainId] of [[2, 9101], [3, 9102]] as const) {
    const [m] = await db.insert(projectMilestones).values({
      projectId, position, title: `M${position}`, description: 'x', amountWei: ETH,
      onchainId, chainStatus: 'disputed', softStatus: 'submitted',
    }).returning()
    await db.insert(disputes).values({
      milestoneId: m!.id, projectId, openedById: client.id, reason: 'temp',
      selectedArbiters: [arbiter.walletAddress],
    })
    disputed.push(m!)
  }

  // 2. finalizeDispute: MilestoneReleased(viaDispute) + DisputeResolved, one tx.
  const h1 = `0x${randomBytes(32).toString('hex')}`
  hashes.push(h1)
  await ingestEvents([
    chainLog('MilestoneReleased', h1, 0, { milestoneId: 9101, freelancer: freelancer.walletAddress, principal: '9', fee: '1', viaDisputeResolution: true }),
    chainLog('DisputeResolved', h1, 1, { milestoneId: 9101, arbiter: arbiter.walletAddress, outcome: 0 }),
  ])
  const settlement = await byMilestone(disputed[0]!.id)
  const settlementTypes = [...new Set(settlement.map((r) => r.type))]
  check('a dispute settlement emits one event, not two', settlementTypes.length === 1, settlementTypes)
  check('the settlement is the milestone payout', settlementTypes[0] === 'milestone.released', settlementTypes)
  check('the round arbiter still hears the outcome', settlement.some((r) => r.user === arbiter.id))

  // 3. No-quorum tally: DisputeFinalized(quorumMet=false) + NoQuorumFallback.
  const h2 = `0x${randomBytes(32).toString('hex')}`
  hashes.push(h2)
  await ingestEvents([
    chainLog('DisputeFinalized', h2, 0, { milestoneId: 9102, round: 0, outcome: 1, revealCount: 1, quorumMet: false }),
    chainLog('NoQuorumFallback', h2, 1, { milestoneId: 9102, opener: client.walletAddress, refunded: '0' }),
  ])
  const noQuorum = await byMilestone(disputed[1]!.id)
  const noQuorumTypes = [...new Set(noQuorum.map((r) => r.type))]
  check('a no-quorum tally emits one event', noQuorumTypes.length === 1, noQuorumTypes)
  check('that event is dispute.no_quorum', noQuorumTypes[0] === 'dispute.no_quorum', noQuorumTypes)
  // The fallback is a SETTLEMENT (the contract refunded the client inside the tally
  // and left the milestone terminal), and `NoQuorumFallback` is the only log that
  // carries it — no `Milestone*` event is emitted on that path. The mirror has to
  // land on the terminal status, stamp the settlement and close the dispute row, or
  // the client keeps seeing a "review window" on a milestone the chain has settled.
  const [settledMilestone] = await db.select().from(projectMilestones).where(eq(projectMilestones.id, disputed[1]!.id))
  check('a no-quorum tally settles the milestone', settledMilestone!.chainStatus === 'resolved_refund', settledMilestone!.chainStatus)
  check('the settlement hash is stamped on the milestone', settledMilestone!.settlementTxHash === h2, settledMilestone!.settlementTxHash)
  const [closedDispute] = await db.select().from(disputes).where(eq(disputes.milestoneId, disputed[1]!.id))
  check('the dispute row is closed, so no payout control survives', closedDispute!.status === 'resolved', closedDispute!.status)
  check('a no quorum is not recorded as a quorum ruling', closedDispute!.finalized === false, closedDispute!.finalized)
} finally {
  if (projectId) {
    await db.delete(notificationEvents).where(eq(notificationEvents.projectId, projectId))
    if (disputed.length) {
      await db.delete(notificationEvents).where(inArray(notificationEvents.milestoneId, disputed.map((m) => m.id)))
    }
    if (hashes.length) await db.delete(ledgerEvents).where(inArray(ledgerEvents.txHash, hashes))
    await db.delete(projects).where(eq(projects.id, projectId)) // cascades milestones + disputes
  }
  await db.delete(proposals).where(eq(proposals.id, proposal!.id))
  await db.delete(jobs).where(eq(jobs.id, job!.id))
}

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1) }
console.log('\nOne action, one inbox row — all checks passed')
process.exit(0)
