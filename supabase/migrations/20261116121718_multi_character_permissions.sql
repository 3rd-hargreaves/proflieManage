-- Stage 3 RLS/Storage policies; writes remain closed until cutover.
begin;
do $$
begin
    if current_setting('app.multi_character_maintenance', true) is distinct from 'on' then raise exception 'mc_maintenance_required'; end if;
    if not exists (select 1 from storage.buckets where id = 'site-images' and public) then raise exception 'mc_public_image_bucket_required'; end if;
end;
$$;
grant usage on schema public to anon, authenticated;
grant usage on schema private to authenticated;
revoke all on public.characters, public.character_themes, public.main_theme, public.sections, public.keywords, public.feed_images from public, anon, authenticated, service_role;
grant select on public.characters, public.character_themes, public.main_theme, public.sections, public.keywords, public.feed_images to anon, authenticated;
grant insert, update, delete on public.characters, public.character_themes, public.sections, public.keywords, public.feed_images to authenticated;
grant update on public.main_theme to authenticated;
revoke all on public.profile, public.theme from public, anon, authenticated, service_role;
revoke all on function public.load_site(), public.save_site(jsonb,jsonb), private.site_snapshot(), private.site_content(jsonb) from public, anon, authenticated, service_role;
revoke all on sequence public.characters_id_seq, public.sections_id_seq, public.keywords_id_seq, public.feed_images_id_seq from public, anon, authenticated, service_role;
grant usage, select on sequence public.characters_id_seq, public.sections_id_seq, public.keywords_id_seq, public.feed_images_id_seq to authenticated;
grant select on private.character_api_control to authenticated;
grant select, insert, update on private.character_creation_requests to authenticated;
grant select, insert on private.character_deletion_receipts to authenticated;
create policy character_control_admin_read on private.character_api_control for select to authenticated using ((select private.is_site_admin()));
create policy character_requests_admin_read on private.character_creation_requests for select to authenticated using ((select private.is_site_admin()));
create policy character_requests_admin_insert on private.character_creation_requests for insert to authenticated with check ((select private.is_site_admin()) and (select private.character_writes_enabled()));
create policy character_requests_admin_update on private.character_creation_requests for update to authenticated
    using ((select private.is_site_admin()) and (select private.character_writes_enabled())) with check ((select private.is_site_admin()) and (select private.character_writes_enabled()));
create policy character_deletions_admin_read on private.character_deletion_receipts for select to authenticated using ((select private.is_site_admin()));
create policy character_deletions_admin_insert on private.character_deletion_receipts for insert to authenticated with check ((select private.is_site_admin()) and (select private.character_writes_enabled()));
do $$
declare
    v_table text;
    v_policy record;
    v_function record;
begin
    foreach v_table in array array['characters', 'character_themes', 'sections', 'keywords', 'feed_images', 'main_theme'] loop
        execute format('alter table public.%I enable row level security', v_table);
        for v_policy in select policyname from pg_policies where schemaname = 'public' and tablename = v_table loop
            execute format('drop policy %I on public.%I', v_policy.policyname, v_table);
        end loop;
        execute format('create policy %I on public.%I for select to anon, authenticated using (true)', v_table || '_character_public_read', v_table);
        execute format('create policy %I on public.%I for insert to authenticated with check ((select private.is_site_admin()) and (select private.character_writes_enabled()))', v_table || '_character_admin_insert', v_table);
        execute format('create policy %I on public.%I for update to authenticated using ((select private.is_site_admin()) and (select private.character_writes_enabled())) with check ((select private.is_site_admin()) and (select private.character_writes_enabled()))', v_table || '_character_admin_update', v_table);
        execute format('create policy %I on public.%I for delete to authenticated using ((select private.is_site_admin()) and (select private.character_writes_enabled()))', v_table || '_character_admin_delete', v_table);
    end loop;
    for v_function in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'private' and p.proname in ('character_writes_enabled', 'require_character_admin', 'validate_character_image', 'can_upload_character_image', 'can_delete_character_image', 'validate_character_theme', 'validate_character_data', 'validate_character_order', 'character_content', 'character_snapshot', 'write_character_data') loop
        execute format('revoke all on function %s from public, anon, authenticated, service_role', v_function.signature);
        execute format('grant execute on function %s to authenticated', v_function.signature);
    end loop;
end;
$$;
grant execute on function public.load_main(), public.load_character(bigint) to anon, authenticated;
grant execute on function public.reserve_character_id(uuid), public.create_character(bigint,uuid,jsonb), public.save_character(bigint,jsonb,jsonb), public.delete_character(bigint,jsonb), public.save_character_order(jsonb,jsonb), public.save_main_theme(jsonb,jsonb), public.load_image_references() to authenticated;
drop policy if exists site_images_admin_select on storage.objects;
drop policy if exists site_images_admin_insert on storage.objects;
drop policy if exists site_images_admin_update on storage.objects;
drop policy if exists site_images_admin_delete on storage.objects;
create policy site_images_admin_select on storage.objects for select to authenticated using (bucket_id = 'site-images' and name ~ '^(profile|feed)/.+' and (select private.is_site_admin()));
create policy site_images_admin_insert on storage.objects for insert to authenticated with check (bucket_id = 'site-images' and private.can_upload_character_image(name));
create policy site_images_admin_delete on storage.objects for delete to authenticated using (bucket_id = 'site-images' and private.can_delete_character_image(name));
-- Restrictive guards also constrain other permissive policies for this bucket.
create policy site_images_namespace_guard on storage.objects as restrictive for insert to authenticated with check (bucket_id <> 'site-images' or private.can_upload_character_image(name));
create policy site_images_reference_guard on storage.objects as restrictive for delete to authenticated using (bucket_id <> 'site-images' or private.can_delete_character_image(name));
create policy site_images_no_update on storage.objects as restrictive for update to authenticated using (bucket_id <> 'site-images') with check (bucket_id <> 'site-images');
update storage.buckets set file_size_limit = 10485760, allowed_mime_types = array['image/jpeg', 'image/png'] where id = 'site-images';
-- Retain mc_maintenance_* and writes_enabled=false until explicit cutover.
commit;
