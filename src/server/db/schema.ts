/**
 * OpenLance off-chain schema (Drizzle / Postgres — Supabase compatible).
 *
 * THE STATE SPLIT (PRD §7.3): money + commitments + trust facts are
 * authoritative ON-CHAIN. Everything here that mirrors chain state
 * (project_milestones.chain_status, ledger_events, arbiters, user stats) is an
 * UNTRUSTED CACHE derived from contract events by the indexer. Money-relevant
 * actions re-derive truth from the chain (adapter RPC), never from these rows.
 */
import { sql } from 'drizzle-orm'
import {
  bigint, bigserial, boolean, index, integer, jsonb, numeric, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid,
} from 'drizzle-orm/pg-core'

// ── Enums ───────────────────────────────────────────────────────────────────
export const userRole = pgEnum('user_role', ['client', 'freelancer', 'arbiter'])
/** Mock-KYC lifecycle for every role (simulated, never a real provider). */
export const kycStatus = pgEnum('kyc_status', ['none', 'pending', 'verified', 'rejected'])
export const jobStatus = pgEnum('job_status', ['open', 'in_progress', 'completed', 'cancelled'])
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
  /** Mirror of ArbiterRegistry.tierOf (0 none … 3 gold). */
  arbiterTier: integer('arbiter_tier').notNull().default(0),
  // Mirror of the on-chain ArbiterRegistry (indexer-maintained).
  isArbiter: boolean('is_arbiter').notNull().default(false),
  // Derived stats — computed from chain settlement events, never client-writable.
  totalEarnedWei: wei('total_earned_wei').notNull().default('0'),
  totalPaidWei: wei('total_paid_wei').notNull().default('0'),
  completedProjectsAsClient: integer('completed_projects_as_client').notNull().default(0),
  completedProjectsAsFreelancer: integer('completed_projects_as_freelancer').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

// ── Marketplace ─────────────────────────────────────────────────────────────
export const jobs = pgTable('jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  posterId: uuid('poster_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  description: text('description').notNull(),
  category: text('category').notNull(),
  skills: text('skills').array().notNull().default(sql`'{}'::text[]`),
  budgetMinWei: wei('budget_min_wei').notNull(),
  budgetMaxWei: wei('budget_max_wei').notNull(),
  status: jobStatus('status').notNull().default('open'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('jobs_status_idx').on(t.status), index('jobs_category_idx').on(t.category)])

/** Ordered milestone template attached to a job post (PRD F1). */
export const jobMilestones = pgTable('job_milestones', {
  id: uuid('id').primaryKey().defaultRandom(),
  jobId: uuid('job_id').notNull().references(() => jobs.id, { onDelete: 'cascade' }),
  position: integer('position').notNull(),
  title: text('title').notNull(),
  description: text('description').notNull(),
  amountWei: wei('amount_wei').notNull(),
}, (t) => [uniqueIndex('job_milestones_job_position_idx').on(t.jobId, t.position)])

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
}, (t) => [uniqueIndex('proposals_job_freelancer_idx').on(t.jobId, t.freelancerId)])

export const proposalMilestones = pgTable('proposal_milestones', {
  id: uuid('id').primaryKey().defaultRandom(),
  proposalId: uuid('proposal_id').notNull().references(() => proposals.id, { onDelete: 'cascade' }),
  position: integer('position').notNull(),
  title: text('title').notNull(),
  description: text('description').notNull(),
  amountWei: wei('amount_wei').notNull(),
}, (t) => [uniqueIndex('proposal_milestones_position_idx').on(t.proposalId, t.position)])

// ── Projects (created at award — the off-chain bridge event, PRD F2) ────────
export const projects = pgTable('projects', {
  id: uuid('id').primaryKey().defaultRandom(),
  jobId: uuid('job_id').notNull().unique().references(() => jobs.id),
  proposalId: uuid('proposal_id').notNull().unique().references(() => proposals.id),
  clientId: uuid('client_id').notNull().references(() => users.id),
  freelancerId: uuid('freelancer_id').notNull().references(() => users.id),
  status: projectStatus('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

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
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('project_milestones_position_idx').on(t.projectId, t.position)])

// ── Collaboration ───────────────────────────────────────────────────────────
/** Append-only evidence log: no update, no delete — by design (PRD F6). */
export const messages = pgTable('messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  senderId: uuid('sender_id').notNull().references(() => users.id),
  body: text('body').notNull(),
  attachmentId: uuid('attachment_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('messages_project_created_idx').on(t.projectId, t.createdAt)])

export const attachments = pgTable('attachments', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  uploaderId: uuid('uploader_id').notNull().references(() => users.id),
  filename: text('filename').notNull(),
  mimeType: text('mime_type').notNull(),
  sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
  storageDriver: text('storage_driver').notNull(), // 'supabase' | 'local'
  storagePath: text('storage_path').notNull(),
  status: attachmentStatus('status').notNull().default('pending'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('attachments_project_idx').on(t.projectId)])

export const submissions = pgTable('submissions', {
  id: uuid('id').primaryKey().defaultRandom(),
  milestoneId: uuid('milestone_id').notNull().references(() => projectMilestones.id, { onDelete: 'cascade' }),
  authorId: uuid('author_id').notNull().references(() => users.id),
  notes: text('notes').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('submissions_milestone_idx').on(t.milestoneId)])

export const submissionAttachments = pgTable('submission_attachments', {
  submissionId: uuid('submission_id').notNull().references(() => submissions.id, { onDelete: 'cascade' }),
  attachmentId: uuid('attachment_id').notNull().references(() => attachments.id, { onDelete: 'cascade' }),
}, (t) => [uniqueIndex('submission_attachment_idx').on(t.submissionId, t.attachmentId)])

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
}, (t) => [uniqueIndex('reviews_milestone_reviewer_idx').on(t.milestoneId, t.reviewerId)])

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
  // ── Legacy nomination fields (kept for older rows; unused by v2 flow) ────
  clientProposedArbiter: text('client_proposed_arbiter'),
  freelancerProposedArbiter: text('freelancer_proposed_arbiter'),
  agreedArbiter: text('agreed_arbiter'),
  adminAssignedArbiter: text('admin_assigned_arbiter'),
  agreementDeadline: timestamp('agreement_deadline', { withTimezone: true }).notNull(),
  // ── Settlement ───────────────────────────────────────────────────────────
  /** Winning arbiter (majority representative) for the settled round. */
  resolvedArbiter: text('resolved_arbiter'),
  /** Majority arbiters of the settled round. */
  majorityArbiters: jsonb('majority_arbiters').notNull().default(sql`'[]'::jsonb`),
  outcome: disputeOutcome('outcome'),
  resolutionTxHash: text('resolution_tx_hash'),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

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
])

/** Indexer checkpoint per contract (last fully ingested block). */
export const indexerState = pgTable('indexer_state', {
  id: text('id').primaryKey(), // 'escrow' | 'arbiter-registry'
  lastBlock: bigint('last_block', { mode: 'number' }).notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/** Mirror of ArbiterRegistry + ERC-5194 SBT trust data + staking (PRD F11/F12). */
export const arbiters = pgTable('arbiters', {
  address: text('address').primaryKey(), // lowercase
  registered: boolean('registered').notNull().default(true),
  sbtTokenId: bigint('sbt_token_id', { mode: 'number' }),
  trustScore: integer('trust_score').notNull().default(0),
  /** ETH collateral held on-chain (wei). Mirror of `stakeOf`. */
  stakeWei: wei('stake_wei').notNull().default('0'),
  /** True when the arbiter has requested to unstake (benched from selection). */
  unstakeRequested: boolean('unstake_requested').notNull().default(false),
  /** True when score < minScoreToWithdraw: stake locked, benched. */
  locked: boolean('locked').notNull().default(false),
  resolutions: integer('resolutions').notNull().default(0),
  resolutionsWithinSla: integer('resolutions_within_sla').notNull().default(0),
  resolutionsLate: integer('resolutions_late').notNull().default(0),
  registeredAt: timestamp('registered_at', { withTimezone: true }),
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
}, (t) => [index('notification_events_created_idx').on(t.createdAt)])

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
})

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
}, (t) => [index('webhook_deliveries_sub_idx').on(t.subscriptionId, t.createdAt)])

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
export type Arbiter = typeof arbiters.$inferSelect
export type NotificationEvent = typeof notificationEvents.$inferSelect
export type NotificationRecipient = typeof notificationRecipients.$inferSelect
export type NotificationPreference = typeof notificationPreferences.$inferSelect
export type WebhookSubscription = typeof webhookSubscriptions.$inferSelect
export type WebhookDelivery = typeof webhookDeliveries.$inferSelect
