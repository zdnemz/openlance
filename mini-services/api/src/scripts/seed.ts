/**
 * Demo seed — the Appendix-A cast + a partially progressed project.
 *
 * Wallets are four deterministic test keys (listed below) so the future
 * frontend — and any recruiter with a burner — can sign in as each role.
 * Addresses are the key-derived truth (verified via viem), not from memory.
 *   Client     A  0xf39F…2266
 *   Freelancer B  0x7099…79c8
 *   Arbiter    C  0x9965…a4dc
 *   Admin      D  0x8d2c…1f37
 *
 * Seeds: profiles, a 2-milestone job, a competing proposal, the award →
 * project, chat, an attachment-free submission, and the mock-chain flow for
 * milestone 1 (fund → submit → approve) so the ledger/stats/reviews are all
 * populated. Milestone 2 is left DISPUTED-ready for the live demo script.
 */
import { eq } from 'drizzle-orm'
import { env } from '../config'
import { getDb, closeDb, execSql } from '../lib/db'
import { logger } from '../lib/logger'
import { getKv } from '../lib/kv'
import { getMockAdapter } from '../chain/adapter'
import { users, jobs, jobMilestones, proposals, proposalMilestones, projects, projectMilestones, messages } from '../db/schema'

const WALLETS = {
  client: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
  freelancer: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
  arbiter: '0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc',
  admin: '0x8d2cc5f9114234f2af1893997410dd9edd7a1f37',
}

async function upsertUser(wallet: string, fields: Partial<typeof users.$inferInsert>) {
  const db = await getDb()
  const [existing] = await db.select().from(users).where(eq(users.walletAddress, wallet)).limit(1)
  if (existing) return existing
  const [created] = await db.insert(users).values({ walletAddress: wallet, ...fields }).returning()
  return created!
}

async function main() {
  const db = await getDb()

  // Deterministic demo state: reset everything (the mock chain derives its
  // state from this DB, so the reset covers the chain simulation too).
  const kv = await getKv()
  await kv.del('mockchain:block')
  await execSql(`
    truncate table webhook_deliveries, webhook_subscriptions, notification_events,
      reconciliation_runs, ledger_events, indexer_state, disputes, reviews,
      submission_attachments, submissions, messages, attachments, project_milestones,
      projects, proposal_milestones, proposals, job_milestones, jobs, arbiters, users
    restart identity cascade
  `)
  logger.info('tables truncated — fresh demo state')

  const client = await upsertUser(WALLETS.client, {
    displayName: 'Maya (Client)', bio: 'Product lead at a small studio. Posts design + dev work.', role: 'client',
    skills: ['product', 'design'],
  })
  const freelancer = await upsertUser(WALLETS.freelancer, {
    displayName: 'Ravi (Freelancer)', bio: 'Fullstack dev. Solidity on the side. Ships fast.', role: 'freelancer',
    skills: ['typescript', 'next.js', 'solidity'],
  })
  const arbiter = await upsertUser(WALLETS.arbiter, {
    displayName: 'Ines (Arbiter)', bio: 'Independent arbiter. 72h SLA or my score pays for it.', role: 'both',
    skills: ['arbitration', 'defi'],
  })
  await upsertUser(WALLETS.admin, { displayName: 'EscrowLance Admin', role: 'both' })
  logger.info('users seeded', { client: client.id, freelancer: freelancer.id, arbiter: arbiter.id })

  // job with 2-milestone template
  const [job] = await db.insert(jobs).values({
    posterId: client.id,
    title: 'Escrow dashboard + wallet integration',
    description: 'Extend our marketplace with a milestone-escrow dashboard: wallet connect, milestone funding UI, and a live ledger view. Designs exist; you own implementation end-to-end and coordinate with our backend dev.',
    category: 'web3-frontend',
    skills: ['typescript', 'next.js', 'wagmi', 'viem'],
    budgetMinWei: '1500000000000000000',
    budgetMaxWei: '4000000000000000000',
  }).returning()
  await db.insert(jobMilestones).values([
    { jobId: job!.id, position: 1, title: 'Milestone 1 — Dashboard shell + wallet connect', description: 'Layout, routing, RainbowKit connect, profile hookups. Reviewable standalone.', amountWei: '1500000000000000000' },
    { jobId: job!.id, position: 2, title: 'Milestone 2 — Funding + ledger views', description: 'Fund-milestone flow, transaction toasts, ledger table with explorer links.', amountWei: '1500000000000000000' },
  ])
  logger.info('job seeded', { jobId: job!.id })

  // proposals (winner + a runner-up to show auto-reject)
  const [winning] = await db.insert(proposals).values({
    jobId: job!.id, freelancerId: freelancer.id,
    coverNote: 'I have built three escrow-adjacent dashboards (two with viem). I would split this exactly as your template suggests and can start Monday.',
    bidTotalWei: '3000000000000000000', deliveryDays: 21,
  }).returning()
  await db.insert(proposalMilestones).values([
    { proposalId: winning!.id, position: 1, title: 'Milestone 1 — Dashboard shell + wallet connect', description: 'Layout, routing, RainbowKit connect, profile hookups.', amountWei: '1500000000000000000' },
    { proposalId: winning!.id, position: 2, title: 'Milestone 2 — Funding + ledger views', description: 'Funding flow, toasts, ledger table.', amountWei: '1500000000000000000' },
  ])
  const runnerUp = await upsertUser('0x15d34aa6d42d4438c05a4b0a5c6b0e0e2d0b9b8a', { displayName: 'Dana (Runner-up)', role: 'freelancer' })
  const [losing] = await db.insert(proposals).values({
    jobId: job!.id, freelancerId: runnerUp.id,
    coverNote: 'Generalist fullstack dev, happy to take this on with a partner.',
    bidTotalWei: '3500000000000000000', deliveryDays: 30,
  }).returning()
  await db.insert(proposalMilestones).values([
    { proposalId: losing!.id, position: 1, title: 'Phase 1 — everything', description: 'Single delivery at the end.', amountWei: '3500000000000000000' },
  ])
  logger.info('proposals seeded')

  // award via the same transition the API performs (kept in sync deliberately)
  const [project] = await db.insert(projects).values({
    jobId: job!.id, proposalId: winning!.id, clientId: client.id, freelancerId: freelancer.id,
  }).returning()
  const ms = await db.select().from(proposalMilestones).where(eq(proposalMilestones.proposalId, winning!.id))
  const ordered = ms.sort((a, b) => a.position - b.position)
  const createdMilestones = await db.insert(projectMilestones).values(ordered.map((m, i) => ({
    projectId: project!.id, position: i + 1, title: m.title, description: m.description, amountWei: m.amountWei,
  }))).returning()
  await db.update(proposals).set({ status: 'accepted' }).where(eq(proposals.id, winning!.id))
  await db.update(proposals).set({ status: 'rejected' }).where(eq(proposals.id, losing!.id))
  await db.update(jobs).set({ status: 'in_progress' }).where(eq(jobs.id, job!.id))
  logger.info('project + milestones seeded', { projectId: project!.id, milestones: createdMilestones.length })

  // chat
  await db.insert(messages).values([
    { projectId: project!.id, senderId: client.id, body: 'Welcome aboard! Designs are in the shared drive — ask me anything here.' },
    { projectId: project!.id, senderId: freelancer.id, body: 'Thanks Maya. Kicking off with the shell; will flag the wallet-connect edge cases in this thread.' },
  ])

  // mock chain: register arbiter, then run milestone 1 through fund→submit→approve
  if (env.chainMode === 'mock') {
    const mock = getMockAdapter()
    const { uuidToBytes32 } = await import('../chain/events')
    await mock.registerArbiter(WALLETS.arbiter)
    const m1 = createdMilestones.find((m) => m.position === 1)!
    const m2 = createdMilestones.find((m) => m.position === 2)!
    const funded = await mock.fund(uuidToBytes32(m1.id), WALLETS.client, WALLETS.freelancer, m1.amountWei)
    logger.info('ms1 funded', { txHash: funded.txHash, onchainId: funded.args.milestoneId })
    await mock.submit(Number(funded.args.milestoneId), WALLETS.freelancer)
    await mock.approve(Number(funded.args.milestoneId), WALLETS.client)
    // milestone 2: funded but untouched — the dispute demo lives here
    const funded2 = await mock.fund(uuidToBytes32(m2.id), WALLETS.client, WALLETS.freelancer, m2.amountWei)
    logger.info('ms2 funded (dispute-ready)', { txHash: funded2.txHash, onchainId: funded2.args.milestoneId })
  } else {
    logger.warn('CHAIN_MODE=real: skipping chain progression — fund via real txs and the indexer will pick them up')
  }

  logger.info('seed complete ✓')
  logger.info('Demo tip: milestone 1 is released (fee taken, stats updated); milestone 2 is funded and dispute-ready.')
  await closeDb()
}

main().catch((err) => {
  console.error('seed failed:', err)
  process.exit(1)
})
