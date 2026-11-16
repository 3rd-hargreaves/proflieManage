-- OWNER ONLY. Stop incoming HTTP writers first; the lock waits for guarded DB transactions.
-- It does not cancel uploads before their metadata transaction or privileged owner/service jobs.
begin;
do $$
begin
    if current_setting('app.multi_character_maintenance', true) is distinct from 'on' then raise exception 'mc_maintenance_required'; end if;
    if current_user <> pg_get_userbyid((select relowner from pg_class where oid = 'private.character_api_control'::regclass)) then raise exception 'mc_owner_required'; end if;
end;
$$;
select pg_advisory_xact_lock(70431862911507);
update private.character_api_control set writes_enabled = false where id = 1;
commit;
