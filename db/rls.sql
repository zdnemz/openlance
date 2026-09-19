-- OpenLance RLS bootstrap (idempotent — safe to re-run).
--
-- Posture: the Hono API is THE write path (service-role credentials, which
-- bypass RLS). These policies constrain direct `authenticated` reads through
-- Supabase PostgREST / Realtime — the realtime plane used by the frontend.
-- On a plain local Postgres/PGlite the auth.uid() stub below is created only
-- when missing, so this file applies cleanly everywhere.

-- ── roles + helpers ──────────────────────────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS auth;
DO $rls_bootstrap$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'auth' AND p.proname = 'uid'
  ) THEN
    EXECUTE $fn$CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $body$ SELECT NULL::uuid $body$$fn$;
  END IF;
END $rls_bootstrap$;

GRANT USAGE ON SCHEMA public TO authenticated;

CREATE OR REPLACE FUNCTION public.is_project_participant(project uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER AS $$
    SELECT EXISTS (
      SELECT 1 FROM projects p
      WHERE p.id = project AND (p.client_id = auth.uid() OR p.freelancer_id = auth.uid())
    )
  $$;

-- ── enable RLS everywhere ────────────────────────────────────────────────
DO $$ BEGIN
  ALTER TABLE users ENABLE ROW LEVEL SECURITY;
  ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
  ALTER TABLE job_milestones ENABLE ROW LEVEL SECURITY;
  ALTER TABLE proposals ENABLE ROW LEVEL SECURITY;
  ALTER TABLE proposal_milestones ENABLE ROW LEVEL SECURITY;
  ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
  ALTER TABLE project_milestones ENABLE ROW LEVEL SECURITY;
  ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
  ALTER TABLE attachments ENABLE ROW LEVEL SECURITY;
  ALTER TABLE submissions ENABLE ROW LEVEL SECURITY;
  ALTER TABLE submission_attachments ENABLE ROW LEVEL SECURITY;
  ALTER TABLE reviews ENABLE ROW LEVEL SECURITY;
  ALTER TABLE disputes ENABLE ROW LEVEL SECURITY;
  ALTER TABLE ledger_events ENABLE ROW LEVEL SECURITY;
  ALTER TABLE arbiters ENABLE ROW LEVEL SECURITY;
END $$;

-- ── grants (read-only for the realtime plane) ────────────────────────────
GRANT SELECT ON users, jobs, job_milestones, projects, project_milestones,
  reviews, ledger_events, arbiters, submissions, submission_attachments,
  messages, attachments, disputes TO authenticated;

-- ── policies (DROP + CREATE for idempotency) ─────────────────────────────

-- public marketplace reads
DROP POLICY IF EXISTS users_public_read ON users;
CREATE POLICY users_public_read ON users FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS jobs_public_read ON jobs;
CREATE POLICY jobs_public_read ON jobs FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS job_milestones_public_read ON job_milestones;
CREATE POLICY job_milestones_public_read ON job_milestones FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS projects_participants_read ON projects;
CREATE POLICY projects_participants_read ON projects FOR SELECT TO authenticated
  USING (client_id = auth.uid() OR freelancer_id = auth.uid());

DROP POLICY IF EXISTS project_milestones_participants_read ON project_milestones;
CREATE POLICY project_milestones_participants_read ON project_milestones FOR SELECT TO authenticated
  USING (is_project_participant(project_id));

DROP POLICY IF EXISTS proposals_visibility_read ON proposals;
CREATE POLICY proposals_visibility_read ON proposals FOR SELECT TO authenticated USING (
  freelancer_id = auth.uid()
  OR job_id IN (SELECT id FROM jobs WHERE poster_id = auth.uid())
  OR status = 'accepted'
);

DROP POLICY IF EXISTS proposal_milestones_visibility_read ON proposal_milestones;
CREATE POLICY proposal_milestones_visibility_read ON proposal_milestones FOR SELECT TO authenticated USING (
  proposal_id IN (
    SELECT p.id FROM proposals p
    WHERE p.freelancer_id = auth.uid()
       OR p.job_id IN (SELECT id FROM jobs WHERE poster_id = auth.uid())
       OR p.status = 'accepted'
  )
);

-- collaboration: participants only.
-- messages are append-only BY DESIGN: there is deliberately no UPDATE or
-- DELETE policy on this table — the evidence log must be immutable (PRD F6).
DROP POLICY IF EXISTS messages_participants_read ON messages;
CREATE POLICY messages_participants_read ON messages FOR SELECT TO authenticated
  USING (is_project_participant(project_id));

DROP POLICY IF EXISTS attachments_participants_read ON attachments;
CREATE POLICY attachments_participants_read ON attachments FOR SELECT TO authenticated
  USING (is_project_participant(project_id));

DROP POLICY IF EXISTS submissions_participants_read ON submissions;
CREATE POLICY submissions_participants_read ON submissions FOR SELECT TO authenticated USING (
  milestone_id IN (SELECT id FROM project_milestones WHERE is_project_participant(project_id))
);

DROP POLICY IF EXISTS submission_attachments_participants_read ON submission_attachments;
CREATE POLICY submission_attachments_participants_read ON submission_attachments FOR SELECT TO authenticated USING (
  submission_id IN (
    SELECT s.id FROM submissions s
    JOIN project_milestones m ON m.id = s.milestone_id
    WHERE is_project_participant(m.project_id)
  )
);

-- trust + ledger: public
DROP POLICY IF EXISTS reviews_public_read ON reviews;
CREATE POLICY reviews_public_read ON reviews FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS ledger_public_read ON ledger_events;
CREATE POLICY ledger_public_read ON ledger_events FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS arbiters_public_read ON arbiters;
CREATE POLICY arbiters_public_read ON arbiters FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS disputes_participants_read ON disputes;
CREATE POLICY disputes_participants_read ON disputes FOR SELECT TO authenticated
  USING (is_project_participant(project_id));
