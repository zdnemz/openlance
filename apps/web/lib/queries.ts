"use client";

/** TanStack Query hooks over the API — the read model of every screen. */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { get, post, patch } from "@/lib/api";
import { useSession } from "@/lib/session";
import type {
  ArbiterView, DisputeView, InboxResponse, JobView, LedgerEntry, MessageView, Overview,
  PreferencesResponse, ProjectView, ProposalView, PublicUser, ReviewView, SubmissionView,
  WebhookDelivery, WebhookSubscription,
} from "@/lib/types";

export const qk = {
  overview: ["overview"] as const,
  jobs: (filters?: Record<string, string>) => ["jobs", filters ?? {}] as const,
  job: (id: string) => ["job", id] as const,
  proposals: (jobId: string) => ["proposals", jobId] as const,
  projects: ["projects"] as const,
  project: (id: string) => ["project", id] as const,
  messages: (id: string) => ["messages", id] as const,
  submissions: (projectId: string, milestoneId: string) => ["submissions", projectId, milestoneId] as const,
  reviews: (milestoneId: string) => ["reviews", milestoneId] as const,
  projectReviews: (id: string) => ["project-reviews", id] as const,
  disputes: ["disputes"] as const,
  dispute: (id: string) => ["dispute", id] as const,
  arbiters: ["arbiters"] as const,
  ledger: (filters?: Record<string, string>) => ["ledger", filters ?? {}] as const,
  user: (address: string) => ["user", address] as const,
  userReviews: (address: string) => ["user-reviews", address] as const,
  me: ["me"] as const,
  notifications: (unreadOnly?: boolean) => ["notifications", unreadOnly ?? false] as const,
  notificationPreferences: ["notification-preferences"] as const,
  webhooks: ["webhooks"] as const,
  webhookDeliveries: (id: string) => ["webhook-deliveries", id] as const,
};

/**
 * Cadence for a list the COUNTERPARTY mutates.
 *
 * These were each given a poll by hand, and the ones nobody thought about were
 * the ones a second party changes: the delivery record, the bid list, the
 * project list. A client with the room open waiting for the freelancer to
 * deliver saw the project and the chat update and the delivery sit stale —
 * so "refresh" was the only way to find out whether work had arrived. If you
 * are not the only person who can change this data, it polls.
 */
export const LIVE_POLL_MS = 4000;

export function useOverview() {
  return useQuery({ queryKey: qk.overview, queryFn: () => get<Overview>("/overview"), refetchInterval: 15_000 });
}

export function useJobs(filters?: Record<string, string>, enabled = true) {
  const search = new URLSearchParams(filters ?? {}).toString();
  return useQuery({
    queryKey: qk.jobs(filters),
    queryFn: () => get<{ items: JobView[]; total: number }>(`/jobs${search ? `?${search}` : ""}`),
    enabled,
    refetchInterval: LIVE_POLL_MS,
  });
}

/**
 * A job's row is a mirror of the chain, and the poster can change it from OUTSIDE
 * this page: `unlockBudget` is a direct wallet call, and the indexer only learns
 * about it on its next pass (up to INDEXER_POLL_MS + confirmations). The panel
 * that withdrew could invalidate immediately, but the row had not moved yet — so
 * it refetched the same `open` row and then nothing ever refetched again, and
 * "refresh the page" was the only way to see the job had gone back to draft.
 *
 * So the job row polls while it is still escrow-backed. Past that point nothing
 * off-page can move it: `in_progress`/completed`/cancelled` are driven by the
 * award, which happens on this page and already invalidates, so the poll stops
 * rather than running forever.
 *
 * Exported so the rule is pinned where it is declared, not copied into a check.
 */
export function jobPollMs(data: JobView | undefined): number | false {
  return data?.status === "open" ? 3000 : false;
}

export function useJob(id: string) {
  return useQuery({
    queryKey: qk.job(id),
    queryFn: () => get<JobView>(`/jobs/${id}`),
    enabled: !!id,
    refetchInterval: (query) => jobPollMs(query.state.data as JobView | undefined),
  });
}

export function useProposals(jobId: string) {
  const token = useSession((s) => s.token);
  return useQuery({
    queryKey: qk.proposals(jobId),
    queryFn: () => get<ProposalView[]>(`/jobs/${jobId}/proposals`),
    enabled: !!jobId && !!token,
    refetchInterval: LIVE_POLL_MS,
  });
}

export function useProjects() {
  const token = useSession((s) => s.token);
  return useQuery({
    queryKey: qk.projects,
    queryFn: () => get<ProjectView[]>("/projects"),
    enabled: !!token,
    refetchInterval: LIVE_POLL_MS,
  });
}

/**
 * How often the project room re-reads the mirror.
 *
 * A milestone at `pending_funding` counts as busy. A mined funding tx is
 * invisible in the mirror until the indexer catches up, and that gap is exactly
 * when the room is least trustworthy — it still offers Fund for value already
 * locked. It polled slowest (12s) precisely then, so "refresh to see the
 * funding" was the only way to get a current answer.
 *
 * Exported so the rule is pinned where it is declared, not copied into a check.
 */
export function projectPollMs(data: ProjectView | undefined): number {
  const busy = data?.milestones?.some((m) =>
    ["pending_funding", "funded", "submitted", "disputed"].includes(m.chainStatus),
  );
  return busy ? 3000 : 12000;
}

export function useProject(id: string) {
  const token = useSession((s) => s.token);
  return useQuery({
    queryKey: qk.project(id),
    queryFn: () => get<ProjectView>(`/projects/${id}`),
    enabled: !!id && !!token,
    refetchInterval: (query) => projectPollMs(query.state.data as ProjectView | undefined),
  });
}

export function useMessages(projectId: string) {
  const token = useSession((s) => s.token);
  return useQuery({
    queryKey: qk.messages(projectId),
    queryFn: () => get<MessageView[]>(`/projects/${projectId}/messages?limit=120`),
    enabled: !!projectId && !!token,
    refetchInterval: 4000,
  });
}

export function useSubmissions(projectId: string, milestoneId: string) {
  const token = useSession((s) => s.token);
  return useQuery({
    queryKey: qk.submissions(projectId, milestoneId),
    queryFn: () => get<SubmissionView[]>(`/projects/${projectId}/milestones/${milestoneId}/submissions`),
    enabled: !!projectId && !!milestoneId && !!token,
    // The freelancer writes this and the client reads it. Without a poll the
    // client's open room showed the project and the chat moving and the
    // delivery frozen, so the one thing they were waiting for needed a reload.
    refetchInterval: LIVE_POLL_MS,
  });
}

export function useMilestoneReviews(milestoneId: string) {
  const token = useSession((s) => s.token);
  return useQuery({
    queryKey: qk.reviews(milestoneId),
    queryFn: () => get<ReviewView[]>(`/milestones/${milestoneId}/reviews`),
    enabled: !!milestoneId && !!token,
  });
}

export function useProjectReviews(projectId: string) {
  const token = useSession((s) => s.token);
  return useQuery({
    queryKey: qk.projectReviews(projectId),
    queryFn: () => get<ReviewView[]>(`/projects/${projectId}/reviews`),
    enabled: !!projectId && !!token,
  });
}

export function useDisputes() {
  const token = useSession((s) => s.token);
  return useQuery({
    queryKey: qk.disputes,
    queryFn: () => get<DisputeView[]>("/disputes"),
    enabled: !!token,
    refetchInterval: 8000,
  });
}

export function useArbiters() {
  return useQuery({ queryKey: qk.arbiters, queryFn: () => get<ArbiterView[]>("/arbiters"), refetchInterval: 15_000 });
}

export function useUser(address: string) {
  return useQuery({ queryKey: qk.user(address), queryFn: () => get<PublicUser>(`/users/${address}`), enabled: /^0x[0-9a-fA-F]{40}$/.test(address ?? "") });
}

export function useUserReviews(address: string) {
  return useQuery({
    queryKey: qk.userReviews(address),
    queryFn: () => get<ReviewView[]>(`/users/${address}/reviews`),
    enabled: /^0x[0-9a-fA-F]{40}$/.test(address ?? ""),
  });
}

export function useLedger(filters?: Record<string, string>, enabled = true) {
  const token = useSession((s) => s.token);
  const search = new URLSearchParams(filters ?? {}).toString();
  return useQuery({
    queryKey: qk.ledger(filters),
    queryFn: () => get<{ items: LedgerEntry[]; total: number }>(`/ledger${search ? `?${search}` : ""}`),
    // The chain pulse is rendered above the signed-out empty state, so without
    // this guard a signed-out visitor's dashboard fired a 401-ing read.
    enabled: enabled && !!token,
    refetchInterval: 10_000,
  });
}

// ── Notifications & webhooks (PRD F9) ───────────────────────────────────────

/** Inbox feed + unread count; polls so the bell stays live. */
export function useNotifications(unreadOnly = false) {
  const token = useSession((s) => s.token);
  return useQuery({
    queryKey: qk.notifications(unreadOnly),
    queryFn: () => get<InboxResponse>(`/notifications${unreadOnly ? "?unread=true" : ""}`),
    enabled: !!token,
    refetchInterval: 15_000,
  });
}

export function useNotificationPreferences() {
  const token = useSession((s) => s.token);
  return useQuery({
    queryKey: qk.notificationPreferences,
    queryFn: () => get<PreferencesResponse>("/notifications/preferences"),
    enabled: !!token,
  });
}

export function useWebhooks() {
  const token = useSession((s) => s.token);
  return useQuery({
    queryKey: qk.webhooks,
    queryFn: () => get<WebhookSubscription[]>("/webhooks"),
    enabled: !!token,
  });
}

export function useWebhookDeliveries(id: string) {
  const token = useSession((s) => s.token);
  return useQuery({
    queryKey: qk.webhookDeliveries(id),
    queryFn: () => get<{ items: WebhookDelivery[]; total: number }>(`/webhooks/${id}/deliveries?limit=50`),
    enabled: !!id && !!token,
    refetchInterval: 8_000,
  });
}

/** Mutation helpers with cache surgery kept next to their shapes. */
export function useInvalidate() {
  const qc = useQueryClient();
  return {
    project: (id: string) => void qc.invalidateQueries({ queryKey: qk.project(id) }),
    projects: () => void qc.invalidateQueries({ queryKey: qk.projects }),
    job: (id: string) => {
      void qc.invalidateQueries({ queryKey: qk.job(id) });
      void qc.invalidateQueries({ queryKey: qk.jobs() });
    },
    proposals: (jobId: string) => void qc.invalidateQueries({ queryKey: qk.proposals(jobId) }),
    /** Prefix match — every milestone's submission list is stale after a write. */
    submissions: () => void qc.invalidateQueries({ queryKey: ["submissions"] }),
    messages: (id: string) => void qc.invalidateQueries({ queryKey: qk.messages(id) }),
    reviews: (milestoneId: string, projectId: string) => {
      void qc.invalidateQueries({ queryKey: qk.reviews(milestoneId) });
      void qc.invalidateQueries({ queryKey: qk.projectReviews(projectId) });
    },
    disputes: () => void qc.invalidateQueries({ queryKey: qk.disputes }),
    overview: () => void qc.invalidateQueries({ queryKey: qk.overview }),
    user: (address: string) => void qc.invalidateQueries({ queryKey: qk.user(address) }),
    notifications: () => void qc.invalidateQueries({ queryKey: ["notifications"] }),
    webhooks: () => void qc.invalidateQueries({ queryKey: qk.webhooks }),
    webhookDeliveries: (id: string) => void qc.invalidateQueries({ queryKey: qk.webhookDeliveries(id) }),
    notificationPreferences: () => void qc.invalidateQueries({ queryKey: qk.notificationPreferences }),
  };
}

export { get, post, patch };
