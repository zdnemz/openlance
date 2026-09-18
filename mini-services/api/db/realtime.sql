-- Supabase Realtime publication (no-op on plain Postgres / PGlite).
-- The frontend subscribes to postgres_changes on these tables with the
-- session JWT we mint; RLS (rls.sql) shapes what each subscriber can see.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE messages';
  END IF;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE project_milestones';
  END IF;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE ledger_events';
  END IF;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
