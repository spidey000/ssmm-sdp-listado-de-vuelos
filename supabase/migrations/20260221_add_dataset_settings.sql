create table if not exists public.dataset_settings (
  dataset_id uuid primary key references public.datasets(id) on delete cascade,
  work_date text not null,
  updated_at timestamptz not null default timezone('utc', now()),
  updated_by uuid default auth.uid() references auth.users(id)
);

drop trigger if exists trg_dataset_settings_touch_updated_at on public.dataset_settings;
create trigger trg_dataset_settings_touch_updated_at
before update on public.dataset_settings
for each row
execute function public.touch_updated_at();

alter table public.dataset_settings enable row level security;

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

grant select, insert, update on public.dataset_settings to authenticated;

do $$
begin
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
