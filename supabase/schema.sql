-- Bingo — wklej w Supabase: SQL Editor → New query → Run
-- (ten sam projekt co Conquest jest OK)

create table if not exists public.bingo_rooms (
  code text not null,
  kind text not null check (kind in ('classic')),
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (code, kind)
);

alter table public.bingo_rooms enable row level security;

drop policy if exists "bingo_rooms_read" on public.bingo_rooms;
drop policy if exists "bingo_rooms_write" on public.bingo_rooms;

create policy "bingo_rooms_read" on public.bingo_rooms for select using (true);
create policy "bingo_rooms_write" on public.bingo_rooms for all using (true) with check (true);

grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on public.bingo_rooms to anon, authenticated;
