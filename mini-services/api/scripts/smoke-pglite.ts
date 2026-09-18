// Smoke test: does PGlite (embedded Postgres WASM) work under Bun?
import { PGlite } from '@electric-sql/pglite'

const pg = new PGlite('./data/smoke-test')
await pg.exec(`create table if not exists t (id serial primary key, v text, n numeric(78,0))`)
await pg.query(`insert into t (v, n) values ($1, $2)`, ['hello', '123456789012345678901'])
const r = await pg.query<{ id: number; v: string; n: string }>(`select * from t order by id desc limit 1`)
console.log('rows:', r.rows)
if (r.rows[0]?.v !== 'hello') throw new Error('insert/read mismatch')

// RLS + enums (things we rely on)
await pg.exec(`
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then
      create role authenticated nologin;
    end if;
  end $$;
  create type mood as enum ('sad','ok','happy');
  create table if not exists rls_t (id int, owner uuid default gen_random_uuid());
  alter table rls_t enable row level security;
`)
const pol = await pg.query<{ c: number }>(`select count(*)::int as c from pg_policies where tablename = 'rls_t'`)
console.log('policies on rls_t:', pol.rows[0]?.c)
console.log('PGlite smoke test PASSED ✓')
await pg.close()
