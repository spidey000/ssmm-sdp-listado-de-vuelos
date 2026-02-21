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
