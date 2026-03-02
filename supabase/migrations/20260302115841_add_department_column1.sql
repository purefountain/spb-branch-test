ALTER TABLE public.emplyees OWNER TO supabase_admin;
alter table if exists public.emplyees add department text default 'Hooli';