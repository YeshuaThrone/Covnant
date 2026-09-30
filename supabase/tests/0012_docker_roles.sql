-- Bare-Postgres stand-in for the Supabase-managed role that the house grant
-- convention expects: 0012 ends with GRANT ALL ... TO service_role, which
-- aborts the docker-entrypoint's ON_ERROR_STOP init run because bare
-- postgres:16-alpine ships no Supabase roles. NOLOGIN: the role is a grant
-- target only, mirroring Supabase where the login is managed by the platform.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin;
  end if;
end
$$;
