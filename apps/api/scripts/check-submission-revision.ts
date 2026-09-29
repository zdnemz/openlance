/**
 * Self-check: the submission → request-changes → revision loop
 * (run: pnpm check:submission-revision).
 *
 * Request-changes is an OFF-CHAIN soft state: Escrow.submit() reverts on
 * anything but Funded, so the milestone stays `submitted` on-chain and the
 * revision is a new delivery record against it. Gating the submission endpoint
 * on `funded` alone left the freelancer stranded — the API answered
 * `milestone_not_fundable` and the room had no control, so a milestone that was
 * not right could only be approved or disputed, never fixed.
 *
 * The rule:
 *   funded, nothing requested   → submit, still owes the chain its `submit()`
 *   submitted, nothing requested→ refused (a second submit() would revert)
 *   changes_requested           → the client can ask, the freelancer can revise
 *   submitted + requested       → revision accepted, and it owes the chain nothing
 *   + 3 attachments → ok; 4 → refused
 *
 * The same evidence ceiling guards a bid's supporting files. The proposal side
 * is one append per file, so its guard counts what is already attached — a bid
 * could otherwise accumulate files without limit, each costing a full upload
 * round-trip before anyone reviews it.
 *
 * Needs DATABASE_URL (it writes its own fixtures and removes them again). No
 * chain, no running API: the modules are called in-process.
 */
import { eq } from 'drizzle-orm'
import { getDb } from '../src/db/index.ts'
import { signSession } from '../src/lib/jwt.ts'
import { acceptProposal } from '../src/modules/proposals.ts'
import { getProject } from '../src/modules/projects.ts'
import { createSubmission, requestChanges, listSubmissions, MAX_SUBMISSION_ATTACHMENTS } from '../src/modules/submissions.ts'
import { initProposalAttachment } from '../src/modules/files.ts'
import { MAX_OWNER_ATTACHMENTS } from '../src/storage/index.ts'
import { AppError } from '../src/lib/errors.ts'
import {
  attachments, jobs, notificationEvents, projectMilestones, proposalMilestones, proposals, projects, users,
} from '../src/db/schema.ts'

let failures = 0
function check(name: string, ok: boolean, extra: unknown = '') {
  if (ok) console.log(`✓ ${name}`)
  else { console.error(`✗ ${name}`, extra); failures++ }
}

const db = getDb()
const ETH = (10n ** 18n).toString()

/** The typed error a call raised, or null when it unexpectedly succeeded. */
async function refused(fn: () => Promise<unknown>): Promise<AppError | null> {
  try {
    await fn()
    return null
  } catch (e) {
    return e instanceof AppError ? e : null
  }
}

// ── Fixture: an open job + proposal, awarded for real so the project and its
//    milestone come from the production path, not hand-written rows. ──
const [client, freelancer] = await db.select().from(users).where(eq(users.kycStatus, 'verified')).limit(2)
if (!client || !freelancer) {
  console.error('need two verified users in the DB to run this check')
  process.exit(1)
}

const [job] = await db.insert(jobs).values({
  posterId: client.id, title: 'submission revision check', description: 'temporary fixture',
  category: 'Engineering', skills: ['typescript'],
  budgetMinWei: ETH, budgetMaxWei: ETH, status: 'open',
}).returning()
const [proposal] = await db.insert(proposals).values({
  jobId: job!.id, freelancerId: freelancer.id, coverNote: 'temp', deliveryDays: 1, bidTotalWei: ETH,
}).returning()
await db.insert(proposalMilestones).values({ proposalId: proposal!.id, position: 1, title: 'M1', description: 'x', amountWei: ETH })

let projectId = ''
try {
  const auth = async (u: { id: string; walletAddress: string }) => ({
    Authorization: `Bearer ${(await signSession({ sub: u.id, address: u.walletAddress })).token}`,
  })
  const clientAuth = await auth(client)
  const freeAuth = await auth(freelancer)
  const post = (headers: Record<string, string>, path: string, body: unknown) =>
    new Request(`http://localhost${path}`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  const get = (headers: Record<string, string>, path: string) =>
    new Request(`http://localhost${path}`, { headers })
  const milestone = async () => (await db.select().from(projectMilestones)
    .where(eq(projectMilestones.projectId, projectId)).limit(1))[0]!
  const deliveries = (headers: Record<string, string>, mid: string) =>
    listSubmissions(get(headers, `/api/projects/${projectId}/milestones/${mid}/submissions`), projectId, mid)

  const award = await acceptProposal(
    new Request('http://localhost/api/proposals/x/accept', { method: 'POST', headers: clientAuth }),
    proposal!.id,
  )
  projectId = (award as { project: { id: string } }).project.id
  const mid = (await milestone()).id

  // The award leaves the milestone unfunded. `funded` + an onchainId short-circuits
  // ensureMilestoneOnchain, so the check needs no chain.
  const setChain = (chainStatus: string, softStatus: string | null) => db.update(projectMilestones)
    .set({ chainStatus, softStatus }).where(eq(projectMilestones.id, mid))
  await setChain('funded', null)

  // Confirmed project attachments — what the delivery picker would have uploaded.
  const atts = await db.insert(attachments).values([0, 1, 2, 3].map((i) => ({
    projectId, uploaderId: freelancer.id, filename: `evidence-${i}.pdf`, mimeType: 'application/pdf',
    sizeBytes: 1024, storageDriver: 'local', storagePath: `${projectId}/a${i}/evidence-${i}.pdf`, status: 'confirmed',
  }))).returning()
  const ids = (n: number) => atts.slice(0, n).map((a) => a.id)

  // 1. A first delivery on a funded milestone still owes the chain its submit().
  const first = await createSubmission(post(freeAuth, '/submissions', { notes: 'v1', attachmentIds: ids(3) }), projectId, mid)
  check('a first delivery requires the on-chain submit()', first.onchainActionRequired === 'markSubmitted', first)
  const firstRow = (await deliveries(clientAuth, mid))[0]!
  check('3 attachments are accepted', firstRow.attachments.length === 3, firstRow.attachments)

  // The evidence ceiling is a server invariant, so it is proved HERE, while the
  // milestone is still `funded` and the state gate cannot answer first. Tested
  // after the submit, the state check (409) would mask the ceiling (400) and the
  // assertion would pass for the wrong reason.
  const overCeiling = await refused(() => createSubmission(
    post(freeAuth, '/submissions', { notes: 'too many', attachmentIds: ids(MAX_SUBMISSION_ATTACHMENTS + 1) }), projectId, mid,
  ))
  check(`${MAX_SUBMISSION_ATTACHMENTS + 1} attachments are refused`, overCeiling?.status === 400, overCeiling)
  check('the refused attempt left no record', (await deliveries(clientAuth, mid)).length === 1)

  await setChain('submitted', 'submitted')

  // 2. With no request-changes there is no second delivery — re-sending submit()
  //    would revert against the Submitted milestone.
  const dup = await refused(() => createSubmission(post(freeAuth, '/submissions', { notes: 'v2' }), projectId, mid))
  check('a second delivery is refused while the first stands', dup?.code === 'milestone_not_fundable', dup)

  // 3. The client asks, with a note.
  await requestChanges(post(clientAuth, '/request-changes', { note: 'the seam is wrong' }), projectId, mid)
  const asked = await milestone()
  check('request-changes is recorded off-chain', asked.softStatus === 'changes_requested', asked)
  check('the chain stays submitted', asked.chainStatus === 'submitted', asked)
  check("the client's note is persisted", asked.softStatusNote === 'the seam is wrong', asked.softStatusNote)

  // 4. The note has to reach the freelancer — without it in the read model they
  //    are told to revise without being told what to revise.
  const view = await getProject(get(freeAuth, `/api/projects/${projectId}`), projectId)
  const shown = view.milestones.find((x) => x.id === mid)!
  check('the read model exposes the revision note', shown.softStatusNote === 'the seam is wrong', shown.softStatusNote)

  // 5. The revision is accepted, and owes the chain nothing.
  const revision = await createSubmission(post(freeAuth, '/submissions', { notes: 'v2', attachmentIds: ids(1) }), projectId, mid)
  check('the revision is accepted', revision.id !== first.id)
  check('a revision requires no on-chain tx', revision.onchainActionRequired === null, revision)
  const revised = await milestone()
  check('the milestone is back in review', revised.softStatus === 'submitted', revised)
  check('both deliveries are in the record', (await deliveries(clientAuth, mid)).length === 2)

  // 6. The list carries the evidence each delivery names, with no holes.
  const rows = await deliveries(clientAuth, mid)
  check('the newest delivery lists its attachment', rows[0]!.attachments.length === 1, rows[0]!.attachments)
  check('the first delivery still lists all three', rows[1]!.attachments.length === 3, rows[1]!.attachments)
  check('no holes in the attachment list', rows.every((s) => s.attachments.every((a) => !!a)))

  // 7. The same evidence ceiling guards a bid's supporting files, counted per
  //    append. The proposal this script already awarded is still owned by the
  //    bidding freelancer, so it is the fixture.
  const initFile = (i: number) => initProposalAttachment(
    post(freeAuth, '/attachments', { filename: `bid-${i}.pdf`, mimeType: 'application/pdf', sizeBytes: 8 }),
    proposal!.id,
  )
  for (let i = 0; i < MAX_OWNER_ATTACHMENTS; i++) await initFile(i)
  const overBid = await refused(() => initFile(MAX_OWNER_ATTACHMENTS))
  check('a proposal at the ceiling refuses another file', overBid?.status === 400, overBid)
  const bidFiles = await db.select().from(attachments).where(eq(attachments.proposalId, proposal!.id))
  check('the refused append left nothing behind', bidFiles.length === MAX_OWNER_ATTACHMENTS, bidFiles.length)
} finally {
  if (projectId) {
    await db.delete(notificationEvents).where(eq(notificationEvents.projectId, projectId))
    await db.delete(attachments).where(eq(attachments.projectId, projectId))
    await db.delete(projects).where(eq(projects.id, projectId)) // cascades milestones + submissions
  }
  if (proposal) {
    await db.delete(attachments).where(eq(attachments.proposalId, proposal.id))
    await db.delete(proposalMilestones).where(eq(proposalMilestones.proposalId, proposal.id))
  }
  await db.delete(proposals).where(eq(proposals.id, proposal!.id))
  await db.delete(jobs).where(eq(jobs.id, job!.id))
}

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1) }
console.log('\nDeliver, request, revise — all checks passed')
process.exit(0)
