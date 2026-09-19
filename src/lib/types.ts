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
export type UserRole = "client" | "freelancer" | "both";

export interface PublicUser {
  id: string;
  walletAddress: string;
  displayName: string | null;
  avatarUrl: string | null;
  bio: string | null;
  skills: string[];
  links: Record<string, string>;
  role: UserRole;
  isArbiter: boolean;
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
  /** Below minScoreToWithdraw → stake locked + benched. */
  locked: boolean;
  unstakeRequested: boolean;
  /** May be drawn for new disputes (mirrors on-chain isEligible). */
  eligible: boolean;
  resolutions: number;
  resolutionsWithinSla: number;
  resolutionsLate: number;
  registeredAt: string;
  profile: { displayName: string | null; avatarUrl: string | null } | null;
  soulbound: boolean;
}

export interface RuntimeConfig {
  chainMode: string;
  chainId: number;
  feeBps: number;
  /** Minimum ETH (wei) to open a dispute — from the contract. */
  disputeFeeWei: string;
  /** Minimum arbiter collateral (wei). */
  minStakeWei: string;
  /** Trust score n below which a stake locks. */
  minScoreToWithdraw: number;
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
