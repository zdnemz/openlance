"use client";

/**
 * Notification presentation helpers — one place that turns a raw inbox item
 * into human copy + a state icon, shared by the bell dropdown and the settings
 * page. Keeps type-string knowledge out of the components.
 */
import type { InboxItem } from "@/lib/types";

export interface NotifMeta {
  /** Short human label for the event type. */
  label: string;
  /** Icon key consumed by the bell (mapped to a Phosphor icon there). */
  icon: NotifIcon;
  tone: "money" | "dispute" | "review" | "proposal" | "system";
}

export type NotifIcon =
  | "coins" | "zap" | "file" | "shield" | "scales" | "star" | "handshake" | "bolt" | "bell";

const META: Record<string, NotifMeta> = {
  "proposal.received": { label: "Proposal received", icon: "file", tone: "proposal" },
  "proposal.accepted": { label: "Proposal accepted", icon: "handshake", tone: "proposal" },
  "proposal.rejected": { label: "Proposal rejected", icon: "file", tone: "proposal" },
  "project.created": { label: "Project created", icon: "bolt", tone: "proposal" },
  "milestone.funded": { label: "Milestone funded", icon: "coins", tone: "money" },
  "submission.received": { label: "Submission received", icon: "file", tone: "money" },
  "milestone.changes_requested": { label: "Changes requested", icon: "file", tone: "money" },
  "dispute.opened": { label: "Dispute opened", icon: "shield", tone: "dispute" },
  "dispute.arbiters_selected": { label: "Arbiters selected", icon: "scales", tone: "dispute" },
  "dispute.vote_committed": { label: "Vote committed", icon: "scales", tone: "dispute" },
  "dispute.vote_revealed": { label: "Vote revealed", icon: "scales", tone: "dispute" },
  "dispute.finalized": { label: "Dispute finalized", icon: "scales", tone: "dispute" },
  "dispute.no_quorum": { label: "No quorum — refunded", icon: "scales", tone: "dispute" },
  "dispute.tally_due": { label: "Tally due", icon: "scales", tone: "dispute" },
  "dispute.appealed": { label: "Dispute appealed", icon: "scales", tone: "dispute" },
  "dispute.arbiter_agreed": { label: "Arbiter agreed", icon: "scales", tone: "dispute" },
  "dispute.arbiter_assigned": { label: "Arbiter assigned", icon: "scales", tone: "dispute" },
  "dispute.resolved": { label: "Dispute resolved", icon: "scales", tone: "dispute" },
  "milestone.released": { label: "Milestone released", icon: "zap", tone: "money" },
  "milestone.refunded": { label: "Milestone refunded", icon: "coins", tone: "money" },
  "milestone.split": { label: "Milestone split", icon: "coins", tone: "money" },
  "project.completed": { label: "Project completed", icon: "star", tone: "review" },
  "review.received": { label: "Review received", icon: "star", tone: "review" },
  "webhook.test": { label: "Webhook test", icon: "bolt", tone: "system" },
};

export function notifMeta(type: string): NotifMeta {
  return META[type] ?? { label: type.replace(/[._]/g, " "), icon: "bell", tone: "system" };
}

/** Deep-link target for an inbox item (project → milestone → dispute). */
export function notifHref(item: InboxItem): string | null {
  const disputeId = typeof item.payload?.disputeId === "string" ? item.payload.disputeId : null;
  if (item.type.startsWith("dispute.") && disputeId) return `/disputes`;
  if (item.projectId) return `/projects/${item.projectId}`;
  const jobId = typeof item.payload?.jobId === "string" ? item.payload.jobId : null;
  if (jobId) return `/jobs/${jobId}`;
  return null;
}

/** One-line detail pulled from the payload, best-effort. */
export function notifDetail(item: InboxItem): string | null {
  const p = item.payload ?? {};
  const bits: string[] = [];
  if (typeof p.milestoneTitle === "string") bits.push(p.milestoneTitle);
  else if (typeof p.title === "string") bits.push(p.title);
  if (typeof p.jobTitle === "string") bits.push(p.jobTitle);
  if (typeof p.rating === "number") bits.push(`${p.rating}★`);
  if (typeof p.position === "number") bits.push(`#${p.position}`);
  if (typeof p.note === "string" && p.note) bits.push(p.note);
  if (typeof p.message === "string") bits.push(p.message);
  return bits.length ? bits.join(" · ") : null;
}
