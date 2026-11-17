-- Onboarding: the workspace's document library, and Exa as a platform service.
--
-- Insider context (decks, case studies, call notes, price sheets, recordings) comes in as files or links. Files live
-- in the private Storage bucket 'workspace-docs' under '<workspace_id>/...'; one workspace_documents row per file or
-- link holds the text the 'documents' function extracted from it, which researchers and writers read with the
-- seller's profile.

-- ---------------------------------------------------------------------------------------------------------------
-- Exa is run by the platform for every workspace: the starting workspace's key becomes the platform key.
-- ---------------------------------------------------------------------------------------------------------------

select vault.update_secret(d.id, d.decrypted_secret, 'int_exa_key')
  from vault.decrypted_secrets d
 where d.name = public.secret_vault_name('00000000-0000-4000-8000-000000000001', 'int_exa_key')
   and not exists (select 1 from vault.secrets s where s.name = 'int_exa_key');
-- Other workspaces' own Exa keys are no longer read.
delete from vault.secrets where name like 'ws\_%\_int\_exa\_key';

-- ---------------------------------------------------------------------------------------------------------------
-- workspace_documents
-- ---------------------------------------------------------------------------------------------------------------

create table if not exists public.workspace_documents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null default public.current_workspace_id() references public.workspaces(id) on delete cascade,
  kind text not null check (kind in ('file', 'link')),
  name text not null check (length(name) between 1 and 300),
  -- Storage path for a file ('<workspace_id>/<uuid>-<name>'); the URL for a link.
  path text,
  url text check (url is null or url ~ '^https?://'),
  mime text,
  size_bytes bigint check (size_bytes is null or size_bytes >= 0),
  -- pending: waiting for extraction. ready: text extracted. stored: kept, but this kind of file can't be read yet
  -- (images, audio, video). failed: extraction failed (see error).
  status text not null default 'pending' check (status in ('pending', 'ready', 'stored', 'failed')),
  extracted_text text,
  chars integer not null default 0,
  error text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((kind = 'file' and path is not null) or (kind = 'link' and url is not null))
);
create index if not exists workspace_documents_workspace_idx on public.workspace_documents (workspace_id, created_at desc);

alter table public.workspace_documents enable row level security;

drop policy if exists workspace_documents_same_workspace on public.workspace_documents;
create policy workspace_documents_same_workspace on public.workspace_documents as restrictive for all to authenticated
  using (workspace_id = (select public.current_workspace_id()))
  with check (workspace_id = (select public.current_workspace_id()));

-- Everyone in the workspace may read the library; admins who manage integrations add and remove from it. Extraction
-- results (status, text) are written by the 'documents' function with the service role.
drop policy if exists workspace_documents_select on public.workspace_documents;
create policy workspace_documents_select on public.workspace_documents for select to authenticated
  using (public.is_active_member());
drop policy if exists workspace_documents_insert on public.workspace_documents;
create policy workspace_documents_insert on public.workspace_documents for insert to authenticated
  with check (public.is_active_member() and public.has_perm('manage_integrations')
              and status = 'pending' and extracted_text is null and created_by = auth.uid()
              and (kind = 'link' or split_part(path, '/', 1) = public.current_workspace_id()::text));
drop policy if exists workspace_documents_delete on public.workspace_documents;
create policy workspace_documents_delete on public.workspace_documents for delete to authenticated
  using (public.is_active_member() and public.has_perm('manage_integrations'));

revoke all on public.workspace_documents from anon, authenticated;
grant select, delete on public.workspace_documents to authenticated;
grant insert (kind, name, path, url, mime, size_bytes, created_by) on public.workspace_documents to authenticated;

-- ---------------------------------------------------------------------------------------------------------------
-- Storage: one private bucket, one folder per workspace.
-- ---------------------------------------------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('workspace-docs', 'workspace-docs', false, 52428800, array[
  'application/pdf',
  'text/csv', 'text/markdown', 'text/plain', 'text/x-markdown',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'image/png', 'image/jpeg',
  'video/quicktime', 'video/mp4',
  'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/mpeg'
])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists workspace_docs_select on storage.objects;
create policy workspace_docs_select on storage.objects for select to authenticated
  using (bucket_id = 'workspace-docs' and public.is_active_member()
         and (storage.foldername(name))[1] = public.current_workspace_id()::text);
drop policy if exists workspace_docs_insert on storage.objects;
create policy workspace_docs_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'workspace-docs' and public.is_active_member() and public.has_perm('manage_integrations')
              and (storage.foldername(name))[1] = public.current_workspace_id()::text);
drop policy if exists workspace_docs_delete on storage.objects;
create policy workspace_docs_delete on storage.objects for delete to authenticated
  using (bucket_id = 'workspace-docs' and public.is_active_member() and public.has_perm('manage_integrations')
         and (storage.foldername(name))[1] = public.current_workspace_id()::text);
