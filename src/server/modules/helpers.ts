/** Shared module helpers: participant guards + common loads. */
import { and, eq, or } from 'drizzle-orm'
import { getDb } from '../db'
import { Errors } from '../lib/errors'
import { jobMilestones, jobs, projectMilestones, projects } from '../db/schema'
import type { Project, ProjectMilestone, User } from '../db/schema'

export async function loadProject(projectId: string): Promise<Project> {
  const [p] = await getDb().select().from(projects).where(eq(projects.id, projectId)).limit(1)
  if (!p) throw Errors.notFound('Project')
  return p
}

/** The authenticated user must be the client or the freelancer on the project. */
export async function requireParticipant(projectId: string, user: User): Promise<Project> {
  const p = await loadProject(projectId)
  if (p.clientId !== user.id && p.freelancerId !== user.id) {
    throw Errors.forbidden('Only project participants may access this')
  }
  return p
}

export async function loadMilestone(milestoneId: string): Promise<{ milestone: ProjectMilestone; project: Project }> {
  const [m] = await getDb().select().from(projectMilestones).where(eq(projectMilestones.id, milestoneId)).limit(1)
  if (!m) throw Errors.notFound('Milestone')
  const project = await loadProject(m.projectId)
  return { milestone: m, project }
}

/** Job + its milestone template (positions ordered). */
export async function loadJobWithTemplate(jobId: string) {
  const db = getDb()
  const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1)
  if (!job) throw Errors.notFound('Job')
  const template = await db.select().from(jobMilestones).where(eq(jobMilestones.jobId, jobId))
  return { job, template: template.sort((a, b) => a.position - b.position) }
}

export async function isParticipant(projectId: string, userId: string): Promise<boolean> {
  const rows = await getDb().select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), or(eq(projects.clientId, userId), eq(projects.freelancerId, userId))))
    .limit(1)
  return rows.length > 0
}
