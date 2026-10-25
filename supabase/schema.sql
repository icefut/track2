-- Kör i Supabase > SQL Editor. Skapar tabellen för order-uppslag.
create table if not exists public.orders (
  id               bigint generated always as identity primary key,
  order_number     text not null,
  email            text not null,
  tracking_number  text not null,
  created_at       timestamptz not null default now(),
  last_status      text,
  last_checked_at  timestamptz,
  unique (order_number, tracking_number)
);

create index if not exists orders_lookup_idx on public.orders (order_number, email);
create index if not exists orders_check_idx  on public.orders (last_checked_at);

-- Viktigt: RLS på utan policies = ingen kan läsa tabellen med den publika anon-nyckeln.
-- Våra serverfunktioner använder service_role-nyckeln (som bara finns i Vercel).
alter table public.orders enable row level security;

-- Om du redan har en gammal tabell "Orders" (stor bokstav) från tidigare kan du flytta datan:
-- insert into public.orders (order_number, email, tracking_number)
--   select order_number::text, lower(email), upper(tracking_number) from public."Orders"
--   on conflict do nothing;
