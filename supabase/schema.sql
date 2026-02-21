create extension if not exists pgcrypto;

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

create table if not exists public.allowed_emails (
  email text primary key,
  active boolean not null default true,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint allowed_emails_lowercase check (email = lower(email))
);

drop trigger if exists trg_allowed_emails_touch_updated_at on public.allowed_emails;
create trigger trg_allowed_emails_touch_updated_at
before update on public.allowed_emails
for each row
execute function public.touch_updated_at();

create or replace function public.current_user_email()
returns text
language sql
stable
as $$
  select lower(coalesce(auth.jwt() ->> 'email', ''));
$$;

create or replace function public.is_email_allowed(p_email text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.allowed_emails ae
    where ae.email = lower(trim(p_email))
      and ae.active = true
  );
$$;

create or replace function public.current_user_is_allowed()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_email_allowed(public.current_user_email());
$$;

grant execute on function public.is_email_allowed(text) to anon, authenticated;
grant execute on function public.current_user_is_allowed() to authenticated;

create table if not exists public.datasets (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  source_hash text not null,
  created_at timestamptz not null default timezone('utc', now()),
  created_by uuid not null default auth.uid() references auth.users(id)
);

create table if not exists public.category_targets (
  dataset_id uuid not null references public.datasets(id) on delete cascade,
  category text not null,
  target_percent numeric(5,2) not null,
  updated_at timestamptz not null default timezone('utc', now()),
  updated_by uuid default auth.uid() references auth.users(id),
  primary key (dataset_id, category),
  constraint category_targets_range check (target_percent >= 0 and target_percent <= 100)
);

drop trigger if exists trg_category_targets_touch_updated_at on public.category_targets;
create trigger trg_category_targets_touch_updated_at
before update on public.category_targets
for each row
execute function public.touch_updated_at();

create table if not exists public.dataset_settings (
  dataset_id uuid primary key references public.datasets(id) on delete cascade,
  work_date text not null,
  updated_at timestamptz not null default timezone('utc', now()),
  updated_by uuid default auth.uid() references auth.users(id)
);

create table if not exists public.assignment_runs (
  id uuid primary key default gen_random_uuid(),
  dataset_id uuid not null references public.datasets(id) on delete cascade,
  work_date text not null,
  seed text not null,
  summary_json jsonb not null default '[]'::jsonb,
  updated_flights integer not null default 0,
  created_at timestamptz not null default timezone('utc', now()),
  created_by uuid not null default auth.uid() references auth.users(id)
);

drop trigger if exists trg_dataset_settings_touch_updated_at on public.dataset_settings;
create trigger trg_dataset_settings_touch_updated_at
before update on public.dataset_settings
for each row
execute function public.touch_updated_at();

create table if not exists public.flights (
  id uuid primary key default gen_random_uuid(),
  dataset_id uuid not null references public.datasets(id) on delete cascade,
  flight_key text not null,
  categoria_clasificacion text not null,
  tipo text not null,
  fecha text not null,
  hora text not null,
  cia text not null,
  dscia text not null,
  cdocia text not null,
  vuelo text not null,
  operated boolean not null default false,
  operated_at timestamptz,
  operated_by_email text,
  service_flag text,
  service_flag_source text,
  service_flag_updated_at timestamptz,
  service_flag_updated_by_email text,
  service_flag_run_id uuid,
  created_at timestamptz not null default timezone('utc', now()),
  constraint flights_unique_per_dataset unique (dataset_id, flight_key),
  constraint flights_operated_metadata check (
    (operated = false and operated_at is null and operated_by_email is null)
    or
    (operated = true and operated_at is not null and operated_by_email is not null)
  )
);

alter table public.flights
  add column if not exists service_flag text,
  add column if not exists service_flag_source text,
  add column if not exists service_flag_updated_at timestamptz,
  add column if not exists service_flag_updated_by_email text,
  add column if not exists service_flag_run_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'flights_service_flag_values'
  ) then
    alter table public.flights
      add constraint flights_service_flag_values check (service_flag is null or service_flag in ('ATENDER', 'NO_ATENDER'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'flights_service_flag_source_values'
  ) then
    alter table public.flights
      add constraint flights_service_flag_source_values check (service_flag_source is null or service_flag_source in ('auto', 'manual'));
  end if;
end;
$$;

create index if not exists flights_dataset_category_idx
  on public.flights(dataset_id, categoria_clasificacion);

create index if not exists flights_dataset_operated_idx
  on public.flights(dataset_id, operated);

create index if not exists flights_dataset_date_idx
  on public.flights(dataset_id, fecha);

create index if not exists flights_dataset_service_flag_idx
  on public.flights(dataset_id, service_flag);

create or replace function public.enforce_flight_operated_rules()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    if new.operated = true then
      if new.operated_at is null then
        new.operated_at = timezone('utc', now());
      end if;

      if coalesce(trim(new.operated_by_email), '') = '' then
        new.operated_by_email = public.current_user_email();
      end if;

      new.operated_by_email = lower(new.operated_by_email);
    else
      new.operated_at = null;
      new.operated_by_email = null;
    end if;

    return new;
  end if;

  if old.operated = true and new.operated = false then
    raise exception 'No se puede desmarcar un vuelo ya operado';
  end if;

  if old.operated = true and new.operated = true then
    new.operated = true;
    new.operated_at = old.operated_at;
    new.operated_by_email = old.operated_by_email;
    return new;
  end if;

  if old.operated = false and new.operated = true then
    if new.operated_at is null then
      new.operated_at = timezone('utc', now());
    end if;

    if coalesce(trim(new.operated_by_email), '') = '' then
      new.operated_by_email = public.current_user_email();
    end if;

    new.operated_by_email = lower(new.operated_by_email);
    return new;
  end if;

  new.operated = false;
  new.operated_at = null;
  new.operated_by_email = null;
  return new;
end;
$$;

drop trigger if exists trg_flights_enforce_operated on public.flights;
create trigger trg_flights_enforce_operated
before insert or update on public.flights
for each row
execute function public.enforce_flight_operated_rules();

create or replace function public.parse_work_date(p_value text)
returns date
language plpgsql
immutable
as $$
declare
  v_value text := trim(coalesce(p_value, ''));
  v_parts text[];
  v_date date;
  v_normalized text;
begin
  if v_value = '' then
    return null;
  end if;

  if v_value ~ '^\d{4}-\d{2}-\d{2}$' then
    v_date := to_date(v_value, 'YYYY-MM-DD');
    if to_char(v_date, 'YYYY-MM-DD') = v_value then
      return v_date;
    end if;
    return null;
  end if;

  if v_value ~ '^\d{1,2}/\d{1,2}/\d{4}$' then
    v_parts := regexp_split_to_array(v_value, '/');
    v_normalized := lpad(v_parts[1], 2, '0') || '/' || lpad(v_parts[2], 2, '0') || '/' || v_parts[3];
    v_date := to_date(v_normalized, 'DD/MM/YYYY');
    if to_char(v_date, 'DD/MM/YYYY') = v_normalized then
      return v_date;
    end if;
    return null;
  end if;

  if v_value ~ '^\d{1,2}-\d{1,2}-\d{4}$' then
    v_parts := regexp_split_to_array(v_value, '-');
    v_normalized := lpad(v_parts[1], 2, '0') || '-' || lpad(v_parts[2], 2, '0') || '-' || v_parts[3];
    v_date := to_date(v_normalized, 'DD-MM-YYYY');
    if to_char(v_date, 'DD-MM-YYYY') = v_normalized then
      return v_date;
    end if;
    return null;
  end if;

  return null;
end;
$$;

create or replace function public.run_auto_assignment(p_dataset_id uuid, p_work_date text)
returns table(run_id uuid, seed text, work_date text, updated_flights integer, summary jsonb)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_seed text := encode(gen_random_bytes(8), 'hex');
  v_run_id uuid := gen_random_uuid();
  v_work_date date;
  v_work_date_iso text;
begin
  if not public.current_user_is_allowed() then
    raise exception 'Usuario no autorizado para autoasignacion';
  end if;

  v_work_date := public.parse_work_date(p_work_date);
  if v_work_date is null then
    raise exception 'Debes indicar un dia de trabajo valido';
  end if;

  v_work_date_iso := to_char(v_work_date, 'YYYY-MM-DD');

  perform pg_advisory_xact_lock(hashtext('auto_assign|' || p_dataset_id::text || '|' || v_work_date_iso)::bigint);

  if not exists (select 1 from public.datasets d where d.id = p_dataset_id) then
    raise exception 'Dataset no encontrado';
  end if;

  return query
  with flights_day as (
    select
      f.id,
      f.categoria_clasificacion,
      coalesce(ct.target_percent, 0)::numeric(5,2) as target_percent,
      count(*) over (partition by f.categoria_clasificacion) as total_category,
      row_number() over (
        partition by f.categoria_clasificacion
        order by md5(f.flight_key || '|' || v_seed), f.flight_key
      ) as category_rank
    from public.flights f
    left join public.category_targets ct
      on ct.dataset_id = f.dataset_id
     and ct.category = f.categoria_clasificacion
    where f.dataset_id = p_dataset_id
      and public.parse_work_date(f.fecha) = v_work_date
  ), decision as (
    select
      fd.id,
      fd.categoria_clasificacion,
      fd.target_percent,
      fd.total_category,
      least(fd.total_category, ceil(fd.total_category * fd.target_percent / 100.0)::integer) as required_count,
      fd.category_rank
    from flights_day fd
  ), updated as (
    update public.flights f
    set
      service_flag = case when d.category_rank <= d.required_count then 'ATENDER' else 'NO_ATENDER' end,
      service_flag_source = 'auto',
      service_flag_updated_at = timezone('utc', now()),
      service_flag_updated_by_email = public.current_user_email(),
      service_flag_run_id = v_run_id
    from decision d
    where f.id = d.id
    returning
      d.categoria_clasificacion as category,
      d.total_category as total,
      d.target_percent,
      d.required_count,
      case when d.category_rank <= d.required_count then 1 else 0 end as assigned_attend
  ), summary_rows as (
    select
      u.category,
      max(u.total)::integer as total,
      max(u.target_percent)::numeric(5,2) as target_percent,
      max(u.required_count)::integer as required_count,
      sum(u.assigned_attend)::integer as assigned_count
    from updated u
    group by u.category
  ), summary_json as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'category', sr.category,
          'total', sr.total,
          'targetPercent', sr.target_percent,
          'requiredCount', sr.required_count,
          'assignedCount', sr.assigned_count
        )
        order by sr.category
      ),
      '[]'::jsonb
    ) as payload
    from summary_rows sr
  ), inserted_run as (
    insert into public.assignment_runs (
      id,
      dataset_id,
      work_date,
      seed,
      summary_json,
      updated_flights,
      created_by
    )
    select
      v_run_id,
      p_dataset_id,
      v_work_date_iso,
      v_seed,
      sj.payload,
      coalesce((select count(*) from updated), 0),
      auth.uid()
    from summary_json sj
    returning id, seed, work_date, updated_flights, summary_json
  )
  select ir.id, ir.seed, ir.work_date, ir.updated_flights, ir.summary_json
  from inserted_run ir;
end;
$$;

grant execute on function public.run_auto_assignment(uuid, text) to authenticated;

alter table public.allowed_emails enable row level security;
alter table public.datasets enable row level security;
alter table public.category_targets enable row level security;
alter table public.dataset_settings enable row level security;
alter table public.assignment_runs enable row level security;
alter table public.flights enable row level security;

drop policy if exists datasets_select_allowed on public.datasets;
create policy datasets_select_allowed
on public.datasets
for select
to authenticated
using (public.current_user_is_allowed());

drop policy if exists datasets_insert_allowed on public.datasets;
create policy datasets_insert_allowed
on public.datasets
for insert
to authenticated
with check (public.current_user_is_allowed() and created_by = auth.uid());

drop policy if exists datasets_update_allowed on public.datasets;
create policy datasets_update_allowed
on public.datasets
for update
to authenticated
using (public.current_user_is_allowed())
with check (public.current_user_is_allowed());

drop policy if exists category_targets_select_allowed on public.category_targets;
create policy category_targets_select_allowed
on public.category_targets
for select
to authenticated
using (public.current_user_is_allowed());

drop policy if exists category_targets_insert_allowed on public.category_targets;
create policy category_targets_insert_allowed
on public.category_targets
for insert
to authenticated
with check (public.current_user_is_allowed());

drop policy if exists category_targets_update_allowed on public.category_targets;
create policy category_targets_update_allowed
on public.category_targets
for update
to authenticated
using (public.current_user_is_allowed())
with check (public.current_user_is_allowed());

drop policy if exists dataset_settings_select_allowed on public.dataset_settings;
create policy dataset_settings_select_allowed
on public.dataset_settings
for select
to authenticated
using (public.current_user_is_allowed());

drop policy if exists dataset_settings_insert_allowed on public.dataset_settings;
create policy dataset_settings_insert_allowed
on public.dataset_settings
for insert
to authenticated
with check (public.current_user_is_allowed());

drop policy if exists dataset_settings_update_allowed on public.dataset_settings;
create policy dataset_settings_update_allowed
on public.dataset_settings
for update
to authenticated
using (public.current_user_is_allowed())
with check (public.current_user_is_allowed());

drop policy if exists assignment_runs_select_allowed on public.assignment_runs;
create policy assignment_runs_select_allowed
on public.assignment_runs
for select
to authenticated
using (public.current_user_is_allowed());

drop policy if exists assignment_runs_insert_allowed on public.assignment_runs;
create policy assignment_runs_insert_allowed
on public.assignment_runs
for insert
to authenticated
with check (public.current_user_is_allowed());

drop policy if exists flights_select_allowed on public.flights;
create policy flights_select_allowed
on public.flights
for select
to authenticated
using (public.current_user_is_allowed());

drop policy if exists flights_insert_allowed on public.flights;
create policy flights_insert_allowed
on public.flights
for insert
to authenticated
with check (public.current_user_is_allowed());

drop policy if exists flights_update_allowed on public.flights;
create policy flights_update_allowed
on public.flights
for update
to authenticated
using (public.current_user_is_allowed() and operated = false)
with check (public.current_user_is_allowed());

grant usage on schema public to anon, authenticated;
grant select, insert, update on public.datasets to authenticated;
grant select, insert, update on public.category_targets to authenticated;
grant select, insert, update on public.dataset_settings to authenticated;
grant select, insert on public.assignment_runs to authenticated;
grant select, insert, update on public.flights to authenticated;

revoke all on public.allowed_emails from anon;
revoke all on public.allowed_emails from authenticated;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'flights'
  ) then
    alter publication supabase_realtime add table public.flights;
  end if;

  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'category_targets'
  ) then
    alter publication supabase_realtime add table public.category_targets;
  end if;

  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'dataset_settings'
  ) then
    alter publication supabase_realtime add table public.dataset_settings;
  end if;
end;
$$;
