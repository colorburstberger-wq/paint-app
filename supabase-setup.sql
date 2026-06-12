-- Rental Services OS Supabase setup
-- Supabase = authentication + relational business records.
-- Google Drive = photos, videos, bills, proofs, catalogues. Supabase stores only Drive metadata/links.

create extension if not exists pgcrypto;

create table if not exists public.app_users (
  id uuid primary key references auth.users(id) on delete cascade,
  email text unique,
  full_name text,
  role text not null default 'Field Staff' check (role in ('Owner','Operations Manager','Field Staff')),
  status text not null default 'Active' check (status in ('Active','Inactive')),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table public.app_users enable row level security;

drop policy if exists app_users_read_own_or_owner on public.app_users;
create policy app_users_read_own_or_owner on public.app_users
for select using (
  id = auth.uid()
  or exists (select 1 from public.app_users u where u.id = auth.uid() and u.role = 'Owner' and u.status = 'Active')
);

drop policy if exists app_users_insert_self on public.app_users;
create policy app_users_insert_self on public.app_users
for insert with check (id = auth.uid());

drop policy if exists app_users_owner_update on public.app_users;
create policy app_users_owner_update on public.app_users
for update using (exists (select 1 from public.app_users u where u.id = auth.uid() and u.role = 'Owner' and u.status = 'Active'))
with check (exists (select 1 from public.app_users u where u.id = auth.uid() and u.role = 'Owner' and u.status = 'Active'));

create or replace function public.claim_first_owner(p_full_name text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
  v_email text;
begin
  select count(*) into v_count from public.app_users where role = 'Owner';
  select email into v_email from auth.users where id = auth.uid();
  if v_count = 0 and auth.uid() is not null then
    insert into public.app_users(id, email, full_name, role, status)
    values(auth.uid(), v_email, coalesce(p_full_name, v_email), 'Owner', 'Active')
    on conflict (id) do update set role = 'Owner', status = 'Active', full_name = coalesce(excluded.full_name, public.app_users.full_name), updated_at = now();
  end if;
end;
$$;

grant execute on function public.claim_first_owner(text) to authenticated;

create or replace function public.current_app_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select role from public.app_users where id = auth.uid() and status = 'Active'), 'Field Staff');
$$;

grant execute on function public.current_app_role() to authenticated;

-- Generic relational record table creator
create or replace function public.create_rental_record_table(p_table text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  execute format('create table if not exists public.%I (
    record_id text primary key,
    record_data jsonb not null default ''{}''::jsonb,
    customer_id text default '''',
    article_id text default '''',
    rental_id text default '''',
    invoice_id text default '''',
    task_id text default '''',
    record_owner uuid null,
    assigned_to text default '''',
    status text default '''',
    updated_by uuid null references auth.users(id),
    created_at timestamptz default now(),
    updated_at timestamptz default now()
  )', p_table);
  execute format('alter table public.%I enable row level security', p_table);
end;
$$;

select public.create_rental_record_table('rental_articles');
select public.create_rental_record_table('rental_customers');
select public.create_rental_record_table('rental_quotations');
select public.create_rental_record_table('rental_invoices');
select public.create_rental_record_table('rental_expenses');
select public.create_rental_record_table('rental_vendors');
select public.create_rental_record_table('rental_purchase_orders');
select public.create_rental_record_table('rental_tasks');
select public.create_rental_record_table('rental_movements');
select public.create_rental_record_table('rental_staff_profiles');
select public.create_rental_record_table('rental_leave_requests');
select public.create_rental_record_table('rental_payroll_runs');
select public.create_rental_record_table('rental_audit_logs');
select public.create_rental_record_table('rental_issues');
select public.create_rental_record_table('rental_returns');
select public.create_rental_record_table('rental_payments');
select public.create_rental_record_table('rental_repairs');
select public.create_rental_record_table('rental_attendance');

drop function if exists public.create_rental_record_table(text);

-- Apply common RLS to operational tables.
do $$
declare t text;
begin
  foreach t in array array[
    'rental_articles','rental_customers','rental_quotations','rental_invoices','rental_expenses','rental_vendors','rental_purchase_orders',
    'rental_tasks','rental_movements','rental_audit_logs','rental_issues','rental_returns','rental_payments','rental_repairs'
  ] loop
    execute format('drop policy if exists %I_read on public.%I', t, t);
    execute format('create policy %I_read on public.%I for select using (
      public.current_app_role() in (''Owner'',''Operations Manager'') or record_owner = auth.uid()
    )', t, t);
    execute format('drop policy if exists %I_write on public.%I', t, t);
    execute format('create policy %I_write on public.%I for insert with check (
      public.current_app_role() in (''Owner'',''Operations Manager'') or record_owner = auth.uid() or updated_by = auth.uid()
    )', t, t);
    execute format('drop policy if exists %I_update on public.%I', t, t);
    execute format('create policy %I_update on public.%I for update using (
      public.current_app_role() in (''Owner'',''Operations Manager'') or record_owner = auth.uid()
    ) with check (
      public.current_app_role() in (''Owner'',''Operations Manager'') or record_owner = auth.uid()
    )', t, t);
  end loop;
end $$;

-- Staff/payroll/salary tables: staff can read own rows, Owner manages everything.
do $$
declare t text;
begin
  foreach t in array array['rental_staff_profiles','rental_leave_requests','rental_payroll_runs'] loop
    execute format('drop policy if exists %I_read_salary on public.%I', t, t);
    execute format('create policy %I_read_salary on public.%I for select using (
      public.current_app_role() in (''Owner'',''Operations Manager'') or record_owner = auth.uid()
    )', t, t);
    execute format('drop policy if exists %I_owner_write_salary on public.%I', t, t);
    execute format('create policy %I_owner_write_salary on public.%I for all using (public.current_app_role() = ''Owner'') with check (public.current_app_role() = ''Owner'')', t, t);
  end loop;
end $$;

-- Attendance: staff can insert/update/read their own attendance; Owner/Manager read all; only Owner can void/delete from backend.
drop policy if exists rental_attendance_read on public.rental_attendance;
create policy rental_attendance_read on public.rental_attendance for select using (
  public.current_app_role() in ('Owner','Operations Manager') or record_owner = auth.uid() or updated_by = auth.uid()
);
drop policy if exists rental_attendance_insert on public.rental_attendance;
create policy rental_attendance_insert on public.rental_attendance for insert with check (record_owner = auth.uid() or updated_by = auth.uid() or public.current_app_role() in ('Owner','Operations Manager'));
drop policy if exists rental_attendance_update on public.rental_attendance;
create policy rental_attendance_update on public.rental_attendance for update using (record_owner = auth.uid() or public.current_app_role() = 'Owner') with check (record_owner = auth.uid() or public.current_app_role() = 'Owner');

-- Google Drive metadata table
create table if not exists public.media_files (
  drive_file_id text primary key,
  record_type text default '',
  record_id text default '',
  owner_table text default '',
  owner_field text default '',
  file_name text default '',
  mime_type text default '',
  size_bytes bigint default 0,
  drive_web_view_link text default '',
  drive_web_content_link text default '',
  drive_folder_id text default '',
  metadata jsonb not null default '{}'::jsonb,
  uploaded_by uuid null references auth.users(id),
  uploaded_at timestamptz default now()
);
alter table public.media_files enable row level security;
drop policy if exists media_files_read on public.media_files;
create policy media_files_read on public.media_files for select using (
  public.current_app_role() in ('Owner','Operations Manager') or uploaded_by = auth.uid()
);
drop policy if exists media_files_write on public.media_files;
create policy media_files_write on public.media_files for insert with check (uploaded_by = auth.uid() or public.current_app_role() in ('Owner','Operations Manager'));
drop policy if exists media_files_update on public.media_files;
create policy media_files_update on public.media_files for update using (uploaded_by = auth.uid() or public.current_app_role() = 'Owner') with check (uploaded_by = auth.uid() or public.current_app_role() = 'Owner');

create table if not exists public.rental_system_settings (
  record_id text primary key,
  record_data jsonb not null default '{}'::jsonb,
  updated_by uuid null references auth.users(id),
  updated_at timestamptz default now()
);
alter table public.rental_system_settings enable row level security;
drop policy if exists rental_system_settings_read on public.rental_system_settings;
create policy rental_system_settings_read on public.rental_system_settings for select using (public.current_app_role() in ('Owner','Operations Manager','Field Staff'));
drop policy if exists rental_system_settings_owner_write on public.rental_system_settings;
create policy rental_system_settings_owner_write on public.rental_system_settings for all using (public.current_app_role() = 'Owner') with check (public.current_app_role() = 'Owner');

-- Legacy snapshot table kept only for migration/fallback. Keep it Owner/Manager-only because it contains the full business file.
create table if not exists public.rental_app_snapshots (
  id text primary key,
  payload jsonb not null,
  updated_by uuid null references auth.users(id),
  updated_at timestamptz default now()
);
alter table public.rental_app_snapshots enable row level security;
drop policy if exists rental_app_snapshots_owner_manager_read on public.rental_app_snapshots;
create policy rental_app_snapshots_owner_manager_read on public.rental_app_snapshots for select using (public.current_app_role() in ('Owner','Operations Manager'));
drop policy if exists rental_app_snapshots_owner_manager_write on public.rental_app_snapshots;
create policy rental_app_snapshots_owner_manager_write on public.rental_app_snapshots for all using (public.current_app_role() in ('Owner','Operations Manager')) with check (public.current_app_role() in ('Owner','Operations Manager'));

create index if not exists idx_rental_tasks_due on public.rental_tasks ((record_data->>'dueDate'));
create index if not exists idx_rental_attendance_owner on public.rental_attendance (record_owner);
create index if not exists idx_media_files_record on public.media_files (record_type, record_id);
