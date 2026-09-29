/**
 * OpenLance off-chain schema (Drizzle / Postgres — Supabase compatible).
 *
 * THE STATE SPLIT (PRD §7.3): money + commitments + trust facts are
 * authoritative ON-CHAIN. Everything here that mirrors chain state
 * (project_milestones.chain_status, ledger_events, user stats) is an
 * UNTRUSTED CACHE derived from contract events by the indexer. Money-relevant
 * actions re-derive truth from the chain (adapter RPC), never from these rows.
 *
 * Arbiter registry state (registered · trust score · stake · tier · eligibility)
 * is NOT mirrored here at all — there is no off-chain arbiter table. Every
 * arbiter read goes straight to the ArbiterRegistry contract (see
 * backend/modules/arbiters.ts); the DB is never a source of arbiter truth.
 */
import { sql } from 'drizzle-orm'
import {
  bigint, bigserial, boolean, check, index, integer, jsonb, numeric, pgEnum, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core'

// ── Enums ───────────────────────────────────────────────────────────────────
export const userRole = pgEnum('user_role', ['client', 'freelancer', 'arbiter'])
/** Mock-KYC lifecycle for every role (simulated, never a real provider). */
export const kycStatus = pgEnum('kyc_status', ['none', 'pending', 'verified', 'rejected'])
export const jobStatus = pgEnum('job_status', ['draft', 'open', 'in_progress', 'completed', 'cancelled'])
export const proposalStatus = pgEnum('proposal_status', ['submitted', 'accepted', 'rejected', 'withdrawn'])
export const projectStatus = pgEnum('project_status', ['active', 'completed', 'cancelled'])
/** Mirror of the on-chain milestone state machine (PRD F4/F5). */
export const milestoneChainStatus = pgEnum('milestone_chain_status', [
  'pending_funding', 'funded', 'submitted', 'released', 'disputed',
  'resolved_release', 'resolved_refund', 'resolved_split', 'cancelled',
])
export const submissionSoftStatus = pgEnum('submission_soft_status', ['submitted', 'changes_requested'])
/**
 * Dispute lifecycle status. `open` covers the whole commit→reveal→tally window
 * (the on-chain `phase` column narrows it down); `resolved` is set once the
 * milestone settles.
 */
export const disputeStatus = pgEnum('dispute_status', ['open', 'agreed', 'assigned', 'resolved'])
/** On-chain round phase (Escrow.Phase): None/Commit/Reveal/Resolved. */
export const disputePhase = pgEnum('dispute_phase', ['none', 'commit', 'reveal', 'resolved'])
export const disputeOutcome = pgEnum('dispute_outcome', ['release', 'refund', 'split'])
export const attachmentStatus = pgEnum('attachment_status', ['pending', 'confirmed'])
export const deliveryStatus = pgEnum('delivery_status', ['pending', 'success', 'failed'])

/** Wei amounts can exceed PG bigint range (2^63) — numeric(78,0) is uint256-safe. */
const wei = (name: string) => numeric(name, { precision: 78, scale: 0 })

/**
 * `col >= 0` for one or more columns.
 *
 * Every money amount here is a uint256 on-chain, where a negative value cannot
 * be expressed. A negative `amount_wei` is therefore never a legitimate state —
 * it is a decode bug, a subtraction that underflowed, or a hand-written insert —
 * and it silently corrupts the balance sheet (`reserved + paidOut <= locked`).
 * Reject it at the storage boundary rather than trusting every writer to agree.
 */
const nonNeg = (name: string, ...cols: AnyPgColumn[]) =>
  check(name, sql`${sql.join(cols.map((c) => sql`${c} >= 0`), sql` and `)}`)

// ── Identity ────────────────────────────────────────────────────────────────
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  walletAddress: text('wallet_address').notNull().unique(), // lowercase; identity anchor
  displayName: text('display_name'),
  avatarUrl: text('avatar_url'),
  bio: text('bio'),
  skills: text('skills').array().notNull().default(sql`'{}'::text[]`),
  links: jsonb('links').notNull().default(sql`'{}'::jsonb`),
  role: userRole('role').notNull().default('client'),
  // ── Onboarding: single permanent role + simulated per-role KYC ──────────
  /** none → pending → verified (arbiter needs verified + on-chain tier ≥ bronze). */
  kycStatus: kycStatus('kyc_status').notNull().default('none'),
  /** light (client) | standard (freelancer) | enhanced (arbiter). */
  kycLevel: text('kyc_level'),
  kycUpdatedAt: timestamp('kyc_updated_at', { withTimezone: true }),
  // NOTE: arbiter standing (registered · trust score · stake · tier) is NOT
  // mirrored here — it is read live from the ArbiterRegistry on-chain. See
  // backend/modules/arbiters.ts. There is no off-chain arbiter table.
  // Derived stats — computed from chain settlement events, never client-writable.
  totalEarnedWei: wei('total_earned_wei').notNull().default('0'),
  totalPaidWei: wei('total_paid_wei').notNull().default('0'),
  completedProjectsAsClient: integer('completed_projects_as_client').notNull().default(0),
  completedProjectsAsFreelancer: integer('completed_projects_as_freelancer').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  nonNeg('users_totals_nonneg', t.totalEarnedWei, t.totalPaidWei),
  check('users_completed_nonneg', sql`${t.completedProjectsAsClient} >= 0 and ${t.completedProjectsAsFreelancer} >= 0`),
])

// ── Gasless sponsorship sessions ────────────────────────────────────────────
/**
 * A login-time EIP-712 `SponsorshipSession` voucher. The user signs once at
 * login (scoped by a server-generated `sessionId`); the relay registers it
 * on-chain on first use and every sponsored meta-tx is verified against it.
 *
 * The SESSION IS THE AUTHORIZATION: the contract checks the signature + expiry
 * on-chain, so this row is a CACHE the backend uses to (a) know a session
 * exists, (b) register it on-chain, and (c) quote/UX. It is never the sole
 * authority for moving money. `expiresAt` mirrors the JWT TTL.
 */
export const sponsorshipSessions = pgTable('sponsorship_sessions', {
  /** On-chain sessionId (bytes32 hex, lowercase) — the whole point of the row. */
  id: text('id').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  address: text('address').notNull(), // signer wallet, lowercase
  issuedAt: timestamp('issued_at', { withTimezone: true }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  /** EIP-712 signature over the SponsorshipSession digest (kept for on-chain registration). */
  signature: text('signature').notNull(),
  /** Whether the voucher has been registered with the forwarder contract yet. */
  registeredOnchain: boolean('registered_onchain').notNull().default(false),
  /** Sponsored meta-tx counter, for the per-user drain guard. */
  sponsoredTxCount: integer('sponsored_tx_count').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('sponsorship_sessions_user_idx').on(t.userId),
  index('sponsorship_sessions_expires_idx').on(t.expiresAt),
])

// ── Marketplace ─────────────────────────────────────────────────────────────
export const jobs = pgTable('jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  posterId: uuid('poster_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  description: text('description').notNull(),
  category: text('category').notNull(),
  skills: text('skills').array().notNull().default(sql`'{}'::text[]`),
  /** Always 0: the client sets a ceiling, the freelancer's bid sets the price. */
  budgetMinWei: wei('budget_min_wei').notNull().default(sql`'0'::numeric`),
  /** The client's ceiling — the hard cap on any bid (createProposal enforces it). */
  budgetMaxWei: wei('budget_max_wei').notNull(),
  status: jobStatus('status').notNull().default('draft'),
  // ── Award vault (draft → publish (free) → award → fund) ──────────────────
  // The client posts a ceiling and no counterparty exists at publish, so the
  // budget is locked on-chain by the award signature, not before. These columns
  // are the off-chain ledger of that lock.
  // ponytail: off-chain vault ledger (amount + tx hash); on-chain JobVault
  // contract later if custodial trust demands it.
  /** Amount locked on-chain for this job = the winning bid, set at award. */
  depositAmountWei: wei('deposit_amount_wei'),
  /** Funding tx hash anchoring the lock (the client's fundAllFromCredit call). */
  depositTxHash: text('deposit_tx_hash'),
  depositedAt: timestamp('deposited_at', { withTimezone: true }),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('jobs_status_idx').on(t.status),
  index('jobs_category_idx').on(t.category),
  // "my jobs" is the poster's landing query; the FK had no index, so it seq-scanned.
  index('jobs_poster_idx').on(t.posterId),
  nonNeg('jobs_budget_nonneg', t.budgetMinWei, t.budgetMaxWei, t.depositAmountWei),
  // A max below the min is an inverted range, not a budget. Every listing filter
  // (`budget_max >= ?`) assumes max is the upper bound.
  check('jobs_budget_ordered', sql`${t.budgetMaxWei} >= ${t.budgetMinWei}`),
])

export const proposals = pgTable('proposals', {
  id: uuid('id').primaryKey().defaultRandom(),
  jobId: uuid('job_id').notNull().references(() => jobs.id, { onDelete: 'cascade' }),
  freelancerId: uuid('freelancer_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  coverNote: text('cover_note').notNull(),
  bidTotalWei: wei('bid_total_wei').notNull(),
  deliveryDays: integer('delivery_days').notNull(),
  status: proposalStatus('status').notNull().default('submitted'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('proposals_job_freelancer_idx').on(t.jobId, t.freelancerId),
  // "proposals on this job" and "this freelancer's proposals" are both hot; the
  // unique index only serves the composite, so neither leading lookup was covered.
  index('proposals_job_idx').on(t.jobId),
  index('proposals_freelancer_idx').on(t.freelancerId),
  nonNeg('proposals_bid_nonneg', t.bidTotalWei),
  check('proposals_delivery_days_positive', sql`${t.deliveryDays} > 0`),
])

export const proposalMilestones = pgTable('proposal_milestones', {
  id: uuid('id').primaryKey().defaultRandom(),
  proposalId: uuid('proposal_id').notNull().references(() => proposals.id, { onDelete: 'cascade' }),
  position: integer('position').notNull(),
  title: text('title').notNull(),
  description: text('description').notNull(),
  amountWei: wei('amount_wei').notNull(),
}, (t) => [
  uniqueIndex('proposal_milestones_position_idx').on(t.proposalId, t.position),
  nonNeg('proposal_milestones_amount_nonneg', t.amountWei),
  check('proposal_milestones_position_nonneg', sql`${t.position} >= 0`),
])

// ── Projects (created at award — the off-chain bridge event, PRD F2) ────────
export const projects = pgTable('projects', {
  id: uuid('id').primaryKey().defaultRandom(),
  jobId: uuid('job_id').notNull().unique().references(() => jobs.id),
  proposalId: uuid('proposal_id').notNull().unique().references(() => proposals.id),
  clientId: uuid('client_id').notNull().references(() => users.id),
  freelancerId: uuid('freelancer_id').notNull().references(() => users.id),
  status: projectStatus('status').notNull().default('active'),
  // ── Mutual arbiter lock (propose → approve → lock, max 3; fallback auto) ─
  /** Pending proposal: { proposerId, addresses[] } until the other side approves. */
  arbiterProposal: jsonb('arbiter_proposal'),
  /** Locked 1–3 lowercase registry addresses, used at dispute open. */
  chosenArbiters: jsonb('chosen_arbiters').notNull().default(sql`'[]'::jsonb`),
  arbitersLockedAt: timestamp('arbiters_locked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // "my projects" as client and as freelancer — the two home screens.
  index('projects_client_idx').on(t.clientId),
  index('projects_freelancer_idx').on(t.freelancerId),
])

/**
 * Per-project milestones. Created from the accepted proposal's breakdown;
 * chain fields are an event-sourced mirror of the escrow contract.
 * `ref` (uuid) travels inside the funding tx so the indexer can map the
 * on-chain milestone id back to this row deterministically.
 */
export const projectMilestones = pgTable('project_milestones', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  position: integer('position').notNull(),
  title: text('title').notNull(),
  description: text('description').notNull(),
  amountWei: wei('amount_wei').notNull(),
  onchainId: bigint('onchain_id', { mode: 'number' }).unique(),
  chainStatus: milestoneChainStatus('chain_status').notNull().default('pending_funding'),
  fundedTxHash: text('funded_tx_hash'),
  fundedAt: timestamp('funded_at', { withTimezone: true }),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  settledAt: timestamp('settled_at', { withTimezone: true }),
  settlementTxHash: text('settlement_tx_hash'),
  // Off-chain soft state: latest submission request-changes flag (PRD F8)
  softStatus: submissionSoftStatus('soft_status'),
  softStatusNote: text('soft_status_note'),
  // ── Pull payout (approved → claimable → freelancer withdraws) ────────────
  withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }),
  withdrawTxHash: text('withdraw_tx_hash'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('project_milestones_position_idx').on(t.projectId, t.position),
  nonNeg('project_milestones_amount_nonneg', t.amountWei),
  check('project_milestones_position_nonneg', sql`${t.position} >= 0`),
])

// ── Collaboration ───────────────────────────────────────────────────────────
/** Append-only evidence log: no update, no delete — by design (PRD F6). */
export const messages = pgTable('messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  senderId: uuid('sender_id').notNull().references(() => users.id),
  body: text('body').notNull(),
  // Was a bare uuid: a message could point at an attachment that never existed
  // (or was deleted), and the chat UI rendered a broken tile. `set null` keeps the
  // message — it is append-only evidence — and drops only the dangling pointer.
  attachmentId: uuid('attachment_id').references(() => attachments.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('messages_project_created_idx').on(t.projectId, t.createdAt),
  index('messages_sender_idx').on(t.senderId),
  index('messages_attachment_idx').on(t.attachmentId),
])

/**
 * One file store for two owners. A project file (deliverable, submission
 * evidence) and a proposal file (a bid's supporting material, attached before
 * any project exists) are the same bytes in the same bucket, so they share the
 * table and the init → upload → confirm pipeline. Exactly one owner is set:
 * an attachment with both, or neither, has no readable scope and every read
 * guard would have to guess.
 */
export const attachments = pgTable('attachments', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  proposalId: uuid('proposal_id').references(() => proposals.id, { onDelete: 'cascade' }),
  uploaderId: uuid('uploader_id').notNull().references(() => users.id),
  filename: text('filename').notNull(),
  mimeType: text('mime_type').notNull(),
  sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
  storageDriver: text('storage_driver').notNull(), // 'supabase' | 'local'
  storagePath: text('storage_path').notNull(),
  status: attachmentStatus('status').notNull().default('pending'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('attachments_project_idx').on(t.projectId),
  index('attachments_proposal_idx').on(t.proposalId),
  index('attachments_uploader_idx').on(t.uploaderId),
  check('attachments_single_owner', sql`num_nonnulls(${t.projectId}, ${t.proposalId}) = 1`),
  // `initAttachment` writes storagePath='' in a two-step insert→update, so an
  // interrupted write leaves an empty path. files.ts resolves `join(dir, '')` to
  // the project directory itself, where a HEAD "succeeds" and the attachment
  // confirms against nothing. Reject the empty path at the boundary.
  check('attachments_storage_path_present', sql`length(${t.storagePath}) > 0`),
])

export const submissions = pgTable('submissions', {
  id: uuid('id').primaryKey().defaultRandom(),
  milestoneId: uuid('milestone_id').notNull().references(() => projectMilestones.id, { onDelete: 'cascade' }),
  authorId: uuid('author_id').notNull().references(() => users.id),
  notes: text('notes').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('submissions_milestone_idx').on(t.milestoneId), index('submissions_author_idx').on(t.authorId)])

/**
 * Join table. It had a uniqueIndex but NO primary key, so Postgres had no
 * identity for the row and replication/upsert paths had nothing to key on. The
 * composite PK is the uniqueness guarantee; the separate uniqueIndex is dropped
 * as redundant. `attachmentId` is indexed on its own for the reverse lookup
 * ("which submissions use this attachment?").
 */
export const submissionAttachments = pgTable('submission_attachments', {
  submissionId: uuid('submission_id').notNull().references(() => submissions.id, { onDelete: 'cascade' }),
  attachmentId: uuid('attachment_id').notNull().references(() => attachments.id, { onDelete: 'cascade' }),
}, (t) => [
  primaryKey({ columns: [t.submissionId, t.attachmentId] }),
  index('submission_attachments_attachment_idx').on(t.attachmentId),
])

// ── Trust layer ─────────────────────────────────────────────────────────────
/** One review per side per milestone; only accepted after on-chain settlement. */
export const reviews = pgTable('reviews', {
  id: uuid('id').primaryKey().defaultRandom(),
  milestoneId: uuid('milestone_id').notNull().references(() => projectMilestones.id, { onDelete: 'cascade' }),
  reviewerId: uuid('reviewer_id').notNull().references(() => users.id),
  revieweeId: uuid('reviewee_id').notNull().references(() => users.id),
  rating: integer('rating').notNull(), // 1..5
  body: text('body'),
  txHash: text('tx_hash').notNull(), // settlement tx that unlocked this review
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('reviews_milestone_reviewer_idx').on(t.milestoneId, t.reviewerId),
  // The zod schema validated 1..5 at the edge; this is the storage-level backstop
  // for any other writer (a script, a future import, a hand-rolled admin call).
  check('reviews_rating_range', sql`${t.rating} between 1 and 5`),
  // "my reviews" and "reviews about me" (the public profile feed) — the composite
  // unique index above only serves milestone-scoped lookups.
  index('reviews_reviewer_idx').on(t.reviewerId),
  index('reviews_reviewee_created_idx').on(t.revieweeId, t.createdAt),
])

/**
 * Dispute coordination lives off-chain; funds/outcomes live on-chain.
 *
 * Multi-arbiter model (contract v2): opening a dispute selects up to 3 random,
 * eligible, non-party arbiters who vote via commit-reveal; the 2-of-3 majority
 * decides. The columns below are the indexer's mirror of the on-chain round so
 * the UI can render the phase, the selected arbiters, the deadline clocks and
 * the tally. Money truth is always re-derived from the chain, never from here.
 */
export const disputes = pgTable('disputes', {
  id: uuid('id').primaryKey().defaultRandom(),
  milestoneId: uuid('milestone_id').notNull().unique().references(() => projectMilestones.id, { onDelete: 'cascade' }),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  openedById: uuid('opened_by_id').notNull().references(() => users.id),
  reason: text('reason'),
  status: disputeStatus('status').notNull().default('open'),
  // ── On-chain round mirror ───────────────────────────────────────────────
  /** Current round index (0 = original, 1+ = appeals). */
  round: integer('round').notNull().default(0),
  phase: disputePhase('phase').notNull().default('none'),
  /** Selected arbiters for the current round (lowercase addresses). */
  selectedArbiters: jsonb('selected_arbiters').notNull().default(sql`'[]'::jsonb`),
  commitDeadline: timestamp('commit_deadline', { withTimezone: true }),
  revealDeadline: timestamp('reveal_deadline', { withTimezone: true }),
  appealCount: integer('appeal_count').notNull().default(0),
  /** Revealed vote tally per outcome, keyed by round index. */
  tally: jsonb('tally').notNull().default(sql`'{}'::jsonb`),
  revealedArbiters: jsonb('revealed_arbiters').notNull().default(sql`'[]'::jsonb`),
  committedArbiters: jsonb('committed_arbiters').notNull().default(sql`'[]'::jsonb`),
  finalized: boolean('finalized').notNull().default(false),
  finalizedAt: timestamp('finalized_at', { withTimezone: true }),
  // ── Settlement ───────────────────────────────────────────────────────────
  /**
   * Winning arbiter (majority representative) for the settled round, from the
   * `DisputeResolved` log. This is the on-chain majority, and it is what the UI
   * shows.
   *
   * It replaces `majority_arbiters` (jsonb array), which was dropped: nothing
   * ever wrote it, so it sat at its `'[]'` default and the project page
   * rendered "majority 0 arbiter(s)" on every settled dispute — impossible,
   * since settlement requires a 2-of-3 quorum. The full majority set is
   * derivable on-chain from the `VoteRevealed` logs; only the representative
   * was ever needed here.
   */
  resolvedArbiter: text('resolved_arbiter'),
  outcome: disputeOutcome('outcome'),
  resolutionTxHash: text('resolution_tx_hash'),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // "disputes on this project" (listDisputes, project timeline) and "disputes I
  // opened" (party inbox) — both were seq-scans on unindexed FKs.
  index('disputes_project_idx').on(t.projectId),
  index('disputes_opened_by_idx').on(t.openedById),
  // slaScan runs every 15 min: `status = 'open' AND reveal_deadline <= now()`
  // (workers/crons.ts:24). It was a full scan of the dispute table on a timer.
  index('disputes_sla_scan_idx').on(t.status, t.revealDeadline),
  // `round` is a chain-supplied round index (0 = original, 1+ = appeals). A
  // negative value is a decode error, and it would silently mis-address the
  // round the appeal/overturn logic reads.
  check('disputes_round_nonneg', sql`${t.round} >= 0`),
])

// ── Chain mirror (untrusted cache — PRD F13) ───────────────────────────────
export const ledgerEvents = pgTable('ledger_events', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  chainId: integer('chain_id').notNull(),
  blockNumber: bigint('block_number', { mode: 'number' }).notNull(),
  blockTime: timestamp('block_time', { withTimezone: true }).notNull(),
  txHash: text('tx_hash').notNull(),
  logIndex: integer('log_index').notNull(),
  contractAddress: text('contract_address').notNull(),
  eventType: text('event_type').notNull(),
  milestoneOnchainId: bigint('milestone_onchain_id', { mode: 'number' }),
  projectId: uuid('project_id'),
  payload: jsonb('payload').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('ledger_tx_log_idx').on(t.txHash, t.logIndex), // idempotency key
  index('ledger_project_idx').on(t.projectId),
  index('ledger_type_idx').on(t.eventType),
  index('ledger_milestone_idx').on(t.milestoneOnchainId), // stats recompute filters on this
  // The indexer's whole job is "give me blocks after N", and overview orders by
  // block DESC. blockNumber was the only column with no index — the single most
  // selective column in the table, and the one that grows without bound.
  index('ledger_chain_block_idx').on(t.chainId, t.blockNumber),
])

/** Indexer checkpoint per contract (last fully ingested block). */
export const indexerState = pgTable('indexer_state', {
  id: text('id').primaryKey(), // 'escrow' | 'arbiter-registry'
  lastBlock: bigint('last_block', { mode: 'number' }).notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

// ── Notifications / webhooks (PRD F9) ───────────────────────────────────────
/** Transactional outbox: one row per domain event; delivery is a separate concern. */
export const notificationEvents = pgTable('notification_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  type: text('type').notNull(),
  actorAddress: text('actor_address'), // lowercase wallet or null (system)
  projectId: uuid('project_id'),
  milestoneId: uuid('milestone_id'),
  payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('notification_events_created_idx').on(t.createdAt),
  // slaScan de-dupes with `type = ? AND milestone_id = ?` per pending dispute,
  // inside a loop (crons.ts:31) — milestone_id is the selective side.
  index('notification_events_milestone_type_idx').on(t.milestoneId, t.type),
])

/**
 * Per-user inbox projection of the outbox. One row per (event, recipient) —
 * written by the emission path so the in-app feed is a simple indexed read.
 * `readAt` is the read receipt; unread = readAt IS NULL.
 */
export const notificationRecipients = pgTable('notification_recipients', {
  id: uuid('id').primaryKey().defaultRandom(),
  eventId: uuid('event_id').notNull().references(() => notificationEvents.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  readAt: timestamp('read_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('notification_recipients_event_user_idx').on(t.eventId, t.userId),
  index('notification_recipients_user_created_idx').on(t.userId, t.createdAt),
  index('notification_recipients_user_unread_idx').on(t.userId, t.readAt),
])

/**
 * Per-user notification preferences (PRD F9). Absence of a row = default
 * (all types on, webhook delivery on). A row with `muted=true` silences both the
 * inbox projection and webhook fan-out for that type.
 */
export const notificationPreferences = pgTable('notification_preferences', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  /** '*' is the global default; otherwise a NotificationType. */
  eventType: text('event_type').notNull(),
  muted: boolean('muted').notNull().default(false),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('notification_prefs_user_type_idx').on(t.userId, t.eventType)])

export const webhookSubscriptions = pgTable('webhook_subscriptions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  url: text('url').notNull(),
  secret: text('secret').notNull(), // HMAC key (generated server-side)
  eventTypes: text('event_types').array().notNull().default(sql`'{}'::text[]`), // empty = all
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // writeOutbox's fan-out filters `active = true` across ALL subscriptions
  // (notify.ts:141) — this is on the hot path of every single emitted event.
  index('webhook_subscriptions_active_idx').on(t.active),
  index('webhook_subscriptions_user_idx').on(t.userId),
])

export const webhookDeliveries = pgTable('webhook_deliveries', {
  id: uuid('id').primaryKey().defaultRandom(),
  subscriptionId: uuid('subscription_id').notNull().references(() => webhookSubscriptions.id, { onDelete: 'cascade' }),
  eventId: uuid('event_id').notNull().references(() => notificationEvents.id, { onDelete: 'cascade' }),
  envelope: jsonb('envelope').notNull(),
  status: deliveryStatus('status').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  lastStatusCode: integer('last_status_code'),
  lastError: text('last_error'),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('webhook_deliveries_sub_idx').on(t.subscriptionId, t.createdAt),
  // eventId cascades from notificationEvents; an unindexed FK makes every
  // outbox delete a seq-scan of this table.
  index('webhook_deliveries_event_idx').on(t.eventId),
])

/** Nightly mirror-vs-chain reconciliation reports (PRD §7.3 + interviews). */
export const reconciliationRuns = pgTable('reconciliation_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  checked: integer('checked').notNull().default(0),
  drifts: integer('drifts').notNull().default(0),
  report: jsonb('report'),
})

// ── Row type exports ────────────────────────────────────────────────────────
export type User = typeof users.$inferSelect
export type Job = typeof jobs.$inferSelect
export type Proposal = typeof proposals.$inferSelect
export type Project = typeof projects.$inferSelect
export type ProjectMilestone = typeof projectMilestones.$inferSelect
export type Message = typeof messages.$inferSelect
export type Attachment = typeof attachments.$inferSelect
export type Submission = typeof submissions.$inferSelect
export type Review = typeof reviews.$inferSelect
export type Dispute = typeof disputes.$inferSelect
export type LedgerEvent = typeof ledgerEvents.$inferSelect
export type NotificationEvent = typeof notificationEvents.$inferSelect
export type NotificationRecipient = typeof notificationRecipients.$inferSelect
export type NotificationPreference = typeof notificationPreferences.$inferSelect
export type WebhookSubscription = typeof webhookSubscriptions.$inferSelect
export type WebhookDelivery = typeof webhookDeliveries.$inferSelect
export type SponsorshipSession = typeof sponsorshipSessions.$inferSelect
