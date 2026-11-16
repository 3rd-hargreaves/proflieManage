-- OWNER ONLY at cutover, AFTER UI/API/Storage verification and request drain. Never auto-apply.
begin;
do $$
begin
    if current_setting('app.multi_character_maintenance', true) is distinct from 'on' then raise exception 'mc_maintenance_required'; end if;
    if current_user <> pg_get_userbyid((select relowner from pg_class where oid = 'private.character_api_control'::regclass)) then raise exception 'mc_owner_required'; end if;
    if to_regprocedure('public.save_character(bigint,jsonb,jsonb)') is null or not exists (select 1 from pg_policies where schemaname = 'storage' and policyname = 'site_images_reference_guard') then raise exception 'mc_api_not_ready'; end if;
end;
$$;
select pg_advisory_xact_lock(70431862911507);
update private.character_api_control set writes_enabled = true where id = 1;
drop policy if exists mc_maintenance_insert on storage.objects;
drop policy if exists mc_maintenance_update on storage.objects;
drop policy if exists mc_maintenance_delete on storage.objects;
commit;
