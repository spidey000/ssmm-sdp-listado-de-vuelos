-- Garantiza que solo administradores puedan modificar configuraciones y crear datasets.
drop policy if exists category_targets_update_allowed on public.category_targets;
create policy category_targets_update_allowed
on public.category_targets
for update
to authenticated
using (public.current_user_is_admin())
with check (public.current_user_is_admin());

drop policy if exists dataset_settings_insert_allowed on public.dataset_settings;
create policy dataset_settings_insert_allowed
on public.dataset_settings
for insert
to authenticated
with check (public.current_user_is_admin());

drop policy if exists dataset_settings_update_allowed on public.dataset_settings;
create policy dataset_settings_update_allowed
on public.dataset_settings
for update
to authenticated
using (public.current_user_is_admin())
with check (public.current_user_is_admin());

drop policy if exists flights_insert_allowed on public.flights;
create policy flights_insert_allowed
on public.flights
for insert
to authenticated
with check (public.current_user_is_admin());
