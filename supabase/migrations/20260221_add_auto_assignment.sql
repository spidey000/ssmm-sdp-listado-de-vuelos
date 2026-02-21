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

create index if not exists flights_dataset_date_idx
  on public.flights(dataset_id, fecha);

create index if not exists flights_dataset_service_flag_idx
  on public.flights(dataset_id, service_flag);

create or replace function public.run_auto_assignment(p_dataset_id uuid, p_work_date text)
returns table(run_id uuid, seed text, work_date text, updated_flights integer, summary jsonb)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_seed text := encode(gen_random_bytes(8), 'hex');
  v_run_id uuid := gen_random_uuid();
begin
  if not public.current_user_is_allowed() then
    raise exception 'Usuario no autorizado para autoasignacion';
  end if;

  if coalesce(trim(p_work_date), '') = '' then
    raise exception 'Debes indicar un dia de trabajo';
  end if;

  perform pg_advisory_xact_lock(hashtext('auto_assign|' || p_dataset_id::text || '|' || p_work_date)::bigint);

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
      and f.fecha = p_work_date
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
      p_work_date,
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

alter table public.assignment_runs enable row level security;

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

grant select, insert on public.assignment_runs to authenticated;
