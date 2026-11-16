-- ONLY for unchanged stage-2 structure/data before new writes; never use DROP ... CASCADE.
-- Owner/session gate and final DB + binary backups are required, as for forward migration.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
do $$
begin
    if current_setting('app.multi_character_maintenance', true) is distinct from 'on' then
        raise exception 'mc_maintenance_required';
    end if;
    perform pg_advisory_xact_lock(70431862911502);
    if to_regclass('private.multi_character_migration_backup') is null then
        raise exception 'mc_rollback_backup_missing';
    end if;
end;
$$;
lock table public.profile, public.theme, public.sections, public.keywords, public.feed_images,
    public.characters, public.character_themes, public.main_theme,
    private.multi_character_migration_backup in access exclusive mode;
lock table storage.objects in share row exclusive mode;

do $$
declare v_backup private.multi_character_migration_backup%rowtype;
begin
    select * into strict v_backup from private.multi_character_migration_backup where migration_key = 'multi_character_structure_v1';
    if private.mc_migration_data() is distinct from v_backup.expected_data then
        raise exception 'mc_rollback_data_changed';
    end if;
    if private.mc_migration_catalog() is distinct from v_backup.expected_catalog then
        raise exception 'mc_rollback_schema_changed';
    end if;
end;
$$;

do $$
declare v_table text;
begin
    foreach v_table in array array['sections', 'keywords', 'feed_images'] loop
        execute format('alter table public.%I drop constraint %I, drop constraint %I, drop column character_id, add constraint %I unique (sort_order) deferrable initially deferred',
            v_table, v_table || '_character_id_fkey', v_table || '_character_sort_order_key', v_table || '_sort_order_key');
    end loop;
end;
$$;
drop table public.character_themes;
drop table public.main_theme;
drop table public.characters;
drop policy mc_maintenance_insert on storage.objects;
drop policy mc_maintenance_update on storage.objects;
drop policy mc_maintenance_delete on storage.objects;

-- Replay captured ACL/grant options instead of assuming repository bootstrap defaults.
do $$
declare
    v_acl jsonb := (select original_acl from private.multi_character_migration_backup);
    v_entry record;
begin
    for v_entry in select distinct a->>'kind' as kind, a->>'object_name' as object_name,
        a->>'grantee' as grantee from jsonb_array_elements(v_acl) a where not (a->>'is_owner')::boolean loop
        execute format('revoke all on %s %s from %s', v_entry.kind, v_entry.object_name,
            case when v_entry.grantee = 'PUBLIC' then 'PUBLIC' else quote_ident(v_entry.grantee) end);
    end loop;
    for v_entry in select a from jsonb_array_elements(v_acl) a where not (a->>'is_owner')::boolean loop
        execute format('grant %s on %s %s to %s%s', v_entry.a->>'privilege_type', v_entry.a->>'kind', v_entry.a->>'object_name',
            case when v_entry.a->>'grantee' = 'PUBLIC' then 'PUBLIC' else quote_ident(v_entry.a->>'grantee') end,
            case when (v_entry.a->>'is_grantable')::boolean then ' with grant option' else '' end);
    end loop;
    if private.mc_migration_data() is distinct from (select original_data from private.multi_character_migration_backup) then
        raise exception 'mc_rollback_data_mismatch';
    end if;
end;
$$;
drop function private.mc_migration_catalog();
drop function private.mc_migration_data();
drop table private.multi_character_migration_backup;
commit;
