-- Edgebook account storage. Run the whole file in Supabase → SQL Editor.
-- All app data is scoped to auth.uid(); never put a service_role key in the website.

create table if not exists public.trades (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  symbol text not null,
  side text not null check (side in ('Long', 'Short')),
  setup text not null default '',
  trade_date date not null,
  entry_price numeric,
  exit_price numeric,
  size numeric,
  pnl_usd numeric not null default 0,
  risk_usd numeric,
  status text not null default 'closed' check (status in ('open', 'closed')),
  plan text not null default 'na' check (plan in ('yes', 'no', 'na')),
  emotion text not null default '',
  notes text not null default '',
  is_sample boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id)
);

create index if not exists trades_user_date_idx on public.trades (user_id, trade_date desc);

alter table public.trades enable row level security;
revoke all on table public.trades from anon;
grant select, insert, update, delete on table public.trades to authenticated;

drop policy if exists "Users read their own trades" on public.trades;
create policy "Users read their own trades" on public.trades
  for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists "Users create their own trades" on public.trades;
create policy "Users create their own trades" on public.trades
  for insert to authenticated with check ((select auth.uid()) = user_id);
drop policy if exists "Users update their own trades" on public.trades;
create policy "Users update their own trades" on public.trades
  for update to authenticated using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
drop policy if exists "Users delete their own trades" on public.trades;
create policy "Users delete their own trades" on public.trades
  for delete to authenticated using ((select auth.uid()) = user_id);

create table if not exists public.trade_screenshots (
  id uuid primary key default gen_random_uuid(),
  trade_id uuid not null,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  storage_path text not null unique,
  file_name text not null default 'screenshot.jpg',
  created_at timestamptz not null default now(),
  foreign key (trade_id, user_id) references public.trades(id, user_id) on delete cascade
);

create index if not exists trade_screenshots_owner_idx on public.trade_screenshots (user_id, trade_id);
alter table public.trade_screenshots enable row level security;
revoke all on table public.trade_screenshots from anon;
grant select, insert, delete on table public.trade_screenshots to authenticated;

drop policy if exists "Users read their own screenshots" on public.trade_screenshots;
create policy "Users read their own screenshots" on public.trade_screenshots
  for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists "Users add screenshots to their own trades" on public.trade_screenshots;
create policy "Users add screenshots to their own trades" on public.trade_screenshots
  for insert to authenticated with check ((select auth.uid()) = user_id);
drop policy if exists "Users remove their own screenshots" on public.trade_screenshots;
create policy "Users remove their own screenshots" on public.trade_screenshots
  for delete to authenticated using ((select auth.uid()) = user_id);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('trade-screenshots', 'trade-screenshots', false, 10485760, array['image/jpeg'])
on conflict (id) do update set public = false, file_size_limit = 10485760, allowed_mime_types = array['image/jpeg'];

drop policy if exists "Users read their own trade images" on storage.objects;
create policy "Users read their own trade images" on storage.objects
  for select to authenticated using (
    bucket_id = 'trade-screenshots' and (storage.foldername(name))[1] = (select auth.uid())::text
  );
drop policy if exists "Users upload their own trade images" on storage.objects;
create policy "Users upload their own trade images" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'trade-screenshots' and (storage.foldername(name))[1] = (select auth.uid())::text
  );
drop policy if exists "Users delete their own trade images" on storage.objects;
create policy "Users delete their own trade images" on storage.objects
  for delete to authenticated using (
    bucket_id = 'trade-screenshots' and (storage.foldername(name))[1] = (select auth.uid())::text
  );
