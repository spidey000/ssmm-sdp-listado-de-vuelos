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
  created_at timestamptz not null default timezone('utc', now()),
  constraint flights_unique_per_dataset unique (dataset_id, flight_key),
  constraint flights_operated_metadata check (
    (operated = false and operated_at is null and operated_by_email is null)
    or
    (operated = true and operated_at is not null and operated_by_email is not null)
  )
);

create index if not exists flights_dataset_category_idx
  on public.flights(dataset_id, categoria_clasificacion);

create index if not exists flights_dataset_operated_idx
  on public.flights(dataset_id, operated);

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

alter table public.allowed_emails enable row level security;
alter table public.datasets enable row level security;
alter table public.category_targets enable row level security;
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
end;
$$;
