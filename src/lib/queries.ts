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

export function useOverview() {
  return useQuery({ queryKey: qk.overview, queryFn: () => get<Overview>("/overview"), refetchInterval: 15_000 });
}

export function useJobs(filters?: Record<string, string>) {
  const search = new URLSearchParams(filters ?? {}).toString();
  return useQuery({
    queryKey: qk.jobs(filters),
    queryFn: () => get<{ items: JobView[]; total: number }>(`/jobs${search ? `?${search}` : ""}`),
  });
}

export function useJob(id: string) {
  return useQuery({ queryKey: qk.job(id), queryFn: () => get<JobView>(`/jobs/${id}`), enabled: !!id });
}

export function useProposals(jobId: string) {
  const token = useSession((s) => s.token);
  return useQuery({
    queryKey: qk.proposals(jobId),
    queryFn: () => get<ProposalView[]>(`/jobs/${jobId}/proposals`),
    enabled: !!jobId && !!token,
  });
}

export function useMyProposals() {
  const token = useSession((s) => s.token);
  return useQuery({
    queryKey: ["my-proposals", token],
    queryFn: async () => {
      const projects = await get<ProjectView[]>("/projects");
      // discover the user's proposals by walking their jobs — the API exposes
      // proposals per job; my active ones live on open jobs I bid on.
      return projects;
    },
    enabled: !!token,
  });
}

export function useProjects() {
  const token = useSession((s) => s.token);
  return useQuery({
    queryKey: qk.projects,
    queryFn: () => get<ProjectView[]>("/projects"),
    enabled: !!token,
  });
}

export function useProject(id: string) {
  const token = useSession((s) => s.token);
  return useQuery({
    queryKey: qk.project(id),
    queryFn: () => get<ProjectView>(`/projects/${id}`),
    enabled: !!id && !!token,
    refetchInterval: (query) => {
      const data = query.state.data as ProjectView | undefined;
      const busy = data?.milestones?.some((m) => ["funded", "submitted", "disputed"].includes(m.chainStatus));
      return busy ? 3000 : 12000;
    },
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
  return useQuery({ queryKey: qk.arbiters, queryFn: () => get<ArbiterView[]>("/arbiters") });
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

export function useLedger(filters?: Record<string, string>) {
  const search = new URLSearchParams(filters ?? {}).toString();
  return useQuery({
    queryKey: qk.ledger(filters),
    queryFn: () => get<{ items: LedgerEntry[]; total: number }>(`/ledger?${search}`),
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
