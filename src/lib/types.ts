/** API shape contracts (mirrors src/server modules). */

export type JobStatus = "open" | "in_progress" | "completed" | "cancelled";
export type MilestoneChainStatus =
  | "pending_funding"
  | "funded"
  | "submitted"
  | "released"
  | "disputed"
  | "resolved_release"
  | "resolved_refund"
  | "resolved_split"
  | "cancelled";
export type ProposalStatus = "submitted" | "accepted" | "rejected" | "withdrawn";
export type ProjectStatus = "active" | "completed" | "cancelled";
export type DisputeStatus = "open" | "agreed" | "assigned" | "resolved";
/** On-chain round phase (Escrow.Phase) mirrored by the indexer. */
export type DisputePhase = "none" | "commit" | "reveal" | "resolved";
export type UserRole = "client" | "freelancer" | "arbiter";
export type KycStatus = "none" | "pending" | "verified" | "rejected";

export interface PublicUser {
  id: string;
  walletAddress: string;
  displayName: string | null;
  avatarUrl: string | null;
  bio: string | null;
  skills: string[];
  links: Record<string, string>;
  role: UserRole;
  kycStatus: KycStatus;
  kycLevel: string | null;
  /** Mirror of ArbiterRegistry.tierOf (0 none … 3 gold). */
  arbiterTier: number;
  isArbiter: boolean;
  isAdmin?: boolean;
  stats: {
    totalEarnedWei: string;
    totalPaidWei: string;
    completedProjectsAsClient: number;
    completedProjectsAsFreelancer: number;
  };
  createdAt: string;
}

export interface MilestoneTemplate {
  id: string;
  position: number;
  title: string;
  description: string;
  amountWei: string;
  amountEth: string;
}

export interface JobView {
  id: string;
  title: string;
  description: string;
  category: string;
  skills: string[];
  status: JobStatus;
  budget: { minWei: string; maxWei: string; minEth: string; maxEth: string };
  poster?: {
    id: string;
    walletAddress: string;
    displayName: string | null;
    avatarUrl: string | null;
    stats: { completedProjectsAsClient: number; totalPaidWei: string };
  };
  milestones: MilestoneTemplate[];
  templateTotalWei: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProposalView {
  id: string;
  jobId: string;
  freelancerId: string;
  coverNote: string;
  deliveryDays: number;
  status: ProposalStatus;
  bidTotalWei: string;
  bidTotalEth: string;
  milestones: { position: number; title: string; description: string; amountWei: string; amountEth: string }[];
  createdAt: string;
}

export interface ProjectMilestone {
  id: string;
  projectId: string;
  position: number;
  title: string;
  description: string;
  amountWei: string;
  amountEth: string;
  onchainId: number | null;
  chainStatus: MilestoneChainStatus;
  softStatus: string | null;
  fundedAt: string | null;
  submittedAt: string | null;
  settledAt: string | null;
  settlementTxHash: string | null;
  fund?: { contract: string; chainId: number; ref: string; amountWei: string };
}

export interface ProjectView {
  id: string;
  jobId: string;
  proposalId: string;
  status: ProjectStatus;
  client: { id: string; walletAddress: string; displayName: string | null };
  freelancer: { id: string; walletAddress: string; displayName: string | null };
  milestones: ProjectMilestone[];
  createdAt: string;
  [key: string]: unknown;
}

export interface MessageView {
  id: string;
  projectId: string;
  senderId: string;
  body: string;
  attachmentId: string | null;
  createdAt: string;
}

export interface SubmissionView {
  id: string;
  milestoneId: string;
  authorId: string;
  notes: string;
  createdAt: string;
  attachments?: { id: string; filename: string; sizeBytes: number; contentType: string }[];
}

export interface ReviewView {
  id: string;
  milestoneId: string;
  reviewerId: string;
  revieweeId: string;
  rating: number;
  body: string | null;
  txHash: string | null;
  createdAt: string;
}

export interface DisputeView {
  id: string;
  milestoneId: string;
  projectId: string;
  openedById: string;
  reason: string;
  status: DisputeStatus;
  // ── Multi-arbiter round state (mirrored from chain) ─────────────────────
  round: number;
  phase: DisputePhase;
  /** Arbiters selected for the current round (lowercase addresses). */
  selectedArbiters: string[];
  committedArbiters: string[];
  revealedArbiters: string[];
  /** Revealed vote tally per round, keyed by round index → [release, refund, split]. */
  tally: Record<string, number[]>;
  commitDeadline: string | null;
  revealDeadline: string | null;
  appealCount: number;
  finalized: boolean;
  finalizedAt: string | null;
  // ── Legacy nomination fields (schema-compatible; unused by the v2 flow) ─
  clientProposedArbiter: string | null;
  freelancerProposedArbiter: string | null;
  agreedArbiter: string | null;
  adminAssignedArbiter: string | null;
  agreementDeadline: string;
  // ── Settlement ──────────────────────────────────────────────────────────
  resolvedArbiter: string | null;
  majorityArbiters: string[];
  outcome: "release" | "refund" | "split" | null;
  resolutionTxHash: string | null;
  resolvedAt: string | null;
  createdAt: string;
}

export interface LedgerEntry {
  id: string;
  chainId: number;
  eventType: string;
  blockNumber: number;
  blockTime: string;
  txHash: string;
  explorerUrl: string;
  contractAddress: string;
  milestoneOnchainId: number | null;
  projectId: string | null;
  payload: Record<string, unknown>;
}

export interface ArbiterView {
  address: string;
  registered: boolean;
  sbtTokenId: string | null;
  trustScore: number;
  /** ETH collateral (wei). */
  stakeWei: string;
  /** 0 none · 1 bronze · 2 silver · 3 gold (mirrors Registry.tierOf). */
  tier: number;
  /** Below minScoreToWithdraw → stake locked + benched. */
  locked: boolean;
  unstakeRequested: boolean;
  /** May be drawn for new disputes (mirrors on-chain isEligible). */
  eligible: boolean;
  /** ISO time when the min-stake-duration clock clears (null when eligible/unknown). */
  selectableAfter?: string | null;
  /** Off-chain KYC state (product needs verified + tier≥bronze for full standing). */
  kycStatus?: string | null;
  resolutions: number;
  resolutionsWithinSla: number;
  resolutionsLate: number;
  registeredAt: string;
  profile: { displayName: string | null; avatarUrl: string | null } | null;
  soulbound: boolean;
}

/** Resolved storage system configuration (mirrors the server's `storageConfig()`). */
export interface StorageRuntimeConfig {
  driver: "supabase" | "local";
  configured: boolean;
  bucket: string;
  visibility: "private" | "public";
  prefix: string;
  projectRef: string | null;
  supabaseUrl: string | null;
  localDir: string;
  maxUploadBytes: number;
  signedUrlTtlSeconds: number;
  allowedMime: string[];
}

export interface RuntimeConfig {
  chainMode: string;
  chainId: number;
  feeBps: number;
  /** Minimum ETH (wei) to open a dispute — from the contract. */
  disputeFeeWei: string;
  /** Minimum arbiter collateral (wei). */
  minStakeWei: string;
  /** Tier floors (wei): bronze = minStake, silver/gold from registry. */
  tierSilverWei?: string;
  tierGoldWei?: string;
  /** Trust score n below which a stake locks. */
  minScoreToWithdraw: number;
  /** Seconds of continuous stake required before an arbiter is selectable. */
  minStakeDurationSeconds: number;
  /** Seconds staked before requestUnstake may be called (withdraw is immediate). */
  unstakeCooldownSeconds: number;
  /** Dispute windows (seconds): commit / reveal / appeal. */
  commitWindowSeconds?: number;
  revealWindowSeconds?: number;
  appealWindowSeconds?: number;
  dbDriver: string;
  storageDriver: string;
  queueMode: string;
  /** Full storage system config (bucket, limits, signed-URL TTL, …). */
  storage?: StorageRuntimeConfig;
  contracts: { escrow: string | null; arbiterRegistry: string | null; timelock: string | null };
}

export interface Overview {
  service: string;
  config: RuntimeConfig;
  counts: { users: number; jobs: number; projects: number; proposals: number; messages: number; reviews: number; ledgerEvents: number };
  milestoneHistogram: Record<string, number>;
  arbiters: ArbiterView[];
  latestLedger: LedgerEntry[];
}

// ── Notifications & webhooks (PRD F9) ───────────────────────────────────────

/** Canonical notification types — mirrors src/server/domain/notifications.ts. */
export const NOTIFICATION_TYPES = [
  "proposal.received",
  "proposal.accepted",
  "proposal.rejected",
  "project.created",
  "milestone.funded",
  "submission.received",
  "milestone.changes_requested",
  "dispute.opened",
  "dispute.arbiters_selected",
  "dispute.vote_committed",
  "dispute.vote_revealed",
  "dispute.finalized",
  "dispute.no_quorum",
  "dispute.tally_due",
  "dispute.appealed",
  "dispute.arbiter_agreed",
  "dispute.arbiter_assigned",
  "dispute.resolved",
  "milestone.released",
  "milestone.refunded",
  "milestone.split",
  "project.completed",
  "review.received",
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export interface InboxItem {
  id: string;
  eventId: string;
  type: string;
  actorAddress: string | null;
  projectId: string | null;
  milestoneId: string | null;
  payload: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
}

export interface InboxResponse {
  items: InboxItem[];
  unread: number;
}

export interface NotificationPreference {
  eventType: string;
  muted: boolean;
}

export interface PreferencesResponse {
  types: readonly string[];
  preferences: NotificationPreference[];
}

export type DeliveryStatus = "pending" | "success" | "failed";

export interface WebhookStats {
  pending: number;
  success: number;
  failed: number;
  total: number;
}

export interface WebhookSubscription {
  id: string;
  userId: string;
  url: string;
  secret: string;
  eventTypes: string[];
  active: boolean;
  createdAt: string;
  stats?: WebhookStats;
}

export interface WebhookDelivery {
  id: string;
  subscriptionId: string;
  eventId: string;
  envelope: { id: string; type: string; ts: string; actor: string | null; payload: Record<string, unknown> };
  status: DeliveryStatus;
  attempts: number;
  lastStatusCode: number | null;
  lastError: string | null;
  deliveredAt: string | null;
  createdAt: string;
}
