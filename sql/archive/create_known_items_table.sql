create table if not exists public.known_items (
  gid integer primary key,
  name text not null,
  created_at timestamptz default now()
);

alter table public.known_items enable row level security;

create policy "Public read access"
  on public.known_items for select
  using (true);

create policy "Authenticated insert access"
  on public.known_items for insert
  with check (true); -- In production, you might want to restrict this
