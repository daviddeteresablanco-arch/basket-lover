-- Basket Lover: cada equipo se comparte por separado (actualización).
-- Pega todo esto en Supabase → SQL Editor → New query → Run.

alter table public.bl_spaces add column if not exists team text;

-- Tu grupo de antes pasa a ser solo el del Infantil masculino.
update public.bl_spaces set team = '91f8eytp', name = 'Distrito Olímpico · Infantil masculino'
  where id = '7358da2bbcb8' and team is null;

drop function if exists public.bl_create_space(text);
-- Compartir un equipo: crea su grupo (con su código) y mete dentro a quien lo comparte. Devuelve el id del grupo.
create or replace function public.bl_create_space(name text, team text) returns text
language plpgsql security definer set search_path = public as $$
declare sid text; c text; i int := 0;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  select s.id into sid from public.bl_spaces s join public.bl_members m on m.space = s.id
    where s.team = bl_create_space.team and m.user_id = auth.uid() limit 1;
  if sid is not null then return sid; end if;
  loop
    c := upper(substr(translate(md5(random()::text || clock_timestamp()::text), '01', ''), 1, 6));
    exit when length(c) = 6 and not exists (select 1 from public.bl_spaces where join_code = c);
    i := i + 1; if i > 20 then raise exception 'no code'; end if;
  end loop;
  insert into public.bl_spaces (name, join_code, owner, team) values (name, c, auth.uid(), bl_create_space.team) returning id into sid;
  insert into public.bl_members (space, user_id, email) values (sid, auth.uid(), auth.jwt() ->> 'email');
  return sid;
end $$;

revoke all on function public.bl_create_space(text, text) from public, anon;
grant execute on function public.bl_create_space(text, text) to authenticated;
