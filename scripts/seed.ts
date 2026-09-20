/**
 * Demo seed — the Appendix-A cast + a partially progressed project.
 *
 *   bun scripts/seed.ts        (or)  npx tsx scripts/seed.ts
 *
 * Wallets are four deterministic test keys (public — safe to ship) so anyone
 * can sign in as each role. Seeds: profiles, a 2-milestone job, a competing
 * proposal, the award → project, chat, and (mock chain) the fund → submit →
 * approve flow for milestone 1. Milestone 2 is left dispute-ready.
 */
import { eq } from 'drizzle-orm'
import { env } from '../src/server/config'
import { closeDb, execSql, getDb } from '../src/server/db'
import { getKv } from '../src/server/lib/kv'
import { getMockAdapter } from '../src/server/chain/adapter'
import { uuidToBytes32 } from '../src/server/chain/events'
import { users, jobs, jobMilestones, proposals, proposalMilestones, projects, projectMilestones, messages } from '../src/server/db/schema'

const WALLETS = {
  client: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
  freelancer: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
  arbiter: '0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc',
  admin: '0x8d2cc5f9114234f2af1893997410dd9edd7a1f37',
}

async function upsertUser(wallet: string, fields: Partial<typeof users.$inferInsert>) {
  const db = getDb()
  const [existing] = await db.select().from(users).where(eq(users.walletAddress, wallet)).limit(1)
  if (existing) return existing
  const [created] = await db.insert(users).values({ walletAddress: wallet, ...fields }).returning()
  return created!
}

async function main() {
  const db = getDb()

  // Deterministic demo state: reset everything (the mock chain derives its
  // state from this DB, so the reset covers the chain simulation too).
  const kv = await getKv()
  await kv.del('mockchain:block')
  await execSql(`
    truncate table notification_recipients, notification_preferences,
      webhook_deliveries, webhook_subscriptions, notification_events,
      reconciliation_runs, ledger_events, indexer_state, disputes, reviews,
      submission_attachments, submissions, messages, attachments, project_milestones,
      projects, proposal_milestones, proposals, job_milestones, jobs, arbiters, users
    restart identity cascade
  `)
  console.log('[seed] tables truncated — fresh demo state')

  const client = await upsertUser(WALLETS.client, {
    displayName: 'Maya (Client)', bio: 'Product lead at a small studio. Posts design + dev work.', role: 'client',
    skills: ['product', 'design'],
  })
  const freelancer = await upsertUser(WALLETS.freelancer, {
    displayName: 'Ravi (Freelancer)', bio: 'Fullstack dev. Solidity on the side. Ships fast.', role: 'freelancer',
    skills: ['typescript', 'next.js', 'solidity'],
  })
  const arbiter = await upsertUser(WALLETS.arbiter, {
    displayName: 'Ines (Arbiter)', bio: 'Independent arbiter. 72h SLA or my score pays for it.', role: 'arbiter',
    skills: ['arbitration', 'defi'],
  })
  await upsertUser(WALLETS.admin, { displayName: 'OpenLance Admin', role: 'client' })
  console.log('[seed] users seeded')

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
    { jobId: job!.id, position: 1, title: 'Milestone 1 — Dashboard shell + wallet connect', description: 'Layout, routing, wallet connect, profile hookups. Reviewable standalone.', amountWei: '1500000000000000000' },
    { jobId: job!.id, position: 2, title: 'Milestone 2 — Funding + ledger views', description: 'Fund-milestone flow, transaction toasts, ledger table with explorer links.', amountWei: '1500000000000000000' },
  ])
  console.log('[seed] job seeded')

  // proposals (winner + a runner-up to show auto-reject)
  const [winning] = await db.insert(proposals).values({
    jobId: job!.id, freelancerId: freelancer.id,
    coverNote: 'I have built three escrow-adjacent dashboards (two with viem). I would split this exactly as your template suggests and can start Monday.',
    bidTotalWei: '3000000000000000000', deliveryDays: 21,
  }).returning()
  await db.insert(proposalMilestones).values([
    { proposalId: winning!.id, position: 1, title: 'Milestone 1 — Dashboard shell + wallet connect', description: 'Layout, routing, wallet connect, profile hookups.', amountWei: '1500000000000000000' },
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
  console.log('[seed] proposals seeded')

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
  console.log('[seed] project + milestones seeded')

  // chat
  await db.insert(messages).values([
    { projectId: project!.id, senderId: client.id, body: 'Welcome aboard! Designs are in the shared drive — ask me anything here.' },
    { projectId: project!.id, senderId: freelancer.id, body: 'Thanks Maya. Kicking off with the shell; will flag the wallet-connect edge cases in this thread.' },
  ])

  // mock chain: register arbiter, then run milestone 1 through fund→submit→approve
  if (env.chainMode === 'mock') {
    const mock = getMockAdapter()
    await mock.registerArbiter(WALLETS.arbiter)
    const m1 = createdMilestones.find((m) => m.position === 1)!
    const m2 = createdMilestones.find((m) => m.position === 2)!
    const funded = await mock.fund(uuidToBytes32(m1.id), WALLETS.client, WALLETS.freelancer, m1.amountWei)
    await mock.submit(Number(funded.args.milestoneId), WALLETS.freelancer)
    await mock.approve(Number(funded.args.milestoneId), WALLETS.client)
    const funded2 = await mock.fund(uuidToBytes32(m2.id), WALLETS.client, WALLETS.freelancer, m2.amountWei)
    console.log('[seed] mock chain progressed', { ms1: funded.args.milestoneId, ms2: funded2.args.milestoneId })
  } else {
    console.warn('[seed] CHAIN_MODE=real: skipping chain progression — fund via real txs and the indexer will pick them up')
  }

  console.log('[seed] complete ✓ — milestone 1 released, milestone 2 funded + dispute-ready')
  await closeDb()
}

main().catch((err) => {
  console.error('[seed] failed:', err)
  process.exit(1)
})
