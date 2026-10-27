-- Basket Lover: tablas para compartir los datos entre los entrenadores de un grupo.
-- Pega todo esto en Supabase → SQL Editor → New query → Run.

create table if not exists public.bl_spaces (
  id text primary key default substr(md5(random()::text || clock_timestamp()::text), 1, 12),
  name text not null,
  join_code text not null unique,
  owner uuid not null default auth.uid(),
  created_at timestamptz not null default now()
);

create table if not exists public.bl_members (
  space text not null references public.bl_spaces(id) on delete cascade,
  user_id uuid not null default auth.uid(),
  email text,
  created_at timestamptz not null default now(),
  primary key (space, user_id)
);

create table if not exists public.bl_docs (
  space text not null references public.bl_spaces(id) on delete cascade,
  id text not null,
  body jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid(),
  primary key (space, id)
);

alter table public.bl_spaces enable row level security;
alter table public.bl_members enable row level security;
alter table public.bl_docs enable row level security;

-- ¿El usuario que está conectado pertenece a este grupo?
create or replace function public.bl_is_member(s text) returns boolean
language sql security definer stable set search_path = public as $$
  select exists (select 1 from public.bl_members where space = s and user_id = auth.uid());
$$;

drop policy if exists "ver mi grupo" on public.bl_spaces;
create policy "ver mi grupo" on public.bl_spaces for select to authenticated using (public.bl_is_member(id));

drop policy if exists "ver compañeros" on public.bl_members;
create policy "ver compañeros" on public.bl_members for select to authenticated using (public.bl_is_member(space));
drop policy if exists "salir del grupo" on public.bl_members;
create policy "salir del grupo" on public.bl_members for delete to authenticated using (user_id = auth.uid());

drop policy if exists "leer datos del grupo" on public.bl_docs;
create policy "leer datos del grupo" on public.bl_docs for select to authenticated using (public.bl_is_member(space));
drop policy if exists "crear datos del grupo" on public.bl_docs;
create policy "crear datos del grupo" on public.bl_docs for insert to authenticated with check (public.bl_is_member(space));
drop policy if exists "cambiar datos del grupo" on public.bl_docs;
create policy "cambiar datos del grupo" on public.bl_docs for update to authenticated using (public.bl_is_member(space)) with check (public.bl_is_member(space));
drop policy if exists "borrar datos del grupo" on public.bl_docs;
create policy "borrar datos del grupo" on public.bl_docs for delete to authenticated using (public.bl_is_member(space));

-- Crear un grupo: lo crea y mete dentro a quien lo crea. Devuelve el id del grupo.
create or replace function public.bl_create_space(name text) returns text
language plpgsql security definer set search_path = public as $$
declare sid text; c text; i int := 0;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  loop
    c := upper(substr(translate(md5(random()::text || clock_timestamp()::text), '01', ''), 1, 6));
    exit when length(c) = 6 and not exists (select 1 from public.bl_spaces where join_code = c);
    i := i + 1; if i > 20 then raise exception 'no code'; end if;
  end loop;
  insert into public.bl_spaces (name, join_code, owner) values (name, c, auth.uid()) returning id into sid;
  insert into public.bl_members (space, user_id, email) values (sid, auth.uid(), auth.jwt() ->> 'email');
  return sid;
end $$;

-- Unirse a un grupo con su código. Devuelve el id del grupo, o null si el código no existe.
create or replace function public.bl_join(code text) returns text
language plpgsql security definer set search_path = public as $$
declare sid text;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  select id into sid from public.bl_spaces where join_code = upper(trim(code));
  if sid is null then return null; end if;
  insert into public.bl_members (space, user_id, email) values (sid, auth.uid(), auth.jwt() ->> 'email')
    on conflict do nothing;
  return sid;
end $$;

revoke all on function public.bl_create_space(text) from public, anon;
revoke all on function public.bl_join(text) from public, anon;
grant execute on function public.bl_create_space(text) to authenticated;
grant execute on function public.bl_join(text) to authenticated;
grant execute on function public.bl_is_member(text) to authenticated;

grant select on public.bl_spaces to authenticated;
grant select, delete on public.bl_members to authenticated;
grant select, insert, update, delete on public.bl_docs to authenticated;

-- Cambios en directo entre dispositivos
alter table public.bl_docs replica identity full;
do $$ begin
  alter publication supabase_realtime add table public.bl_docs;
exception when duplicate_object then null; end $$;
