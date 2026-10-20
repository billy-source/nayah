-- Orders paid through Paystack. Written only by the `paystack` Edge Function (service role).
create table if not exists public.nayah_orders (
  id             uuid primary key default gen_random_uuid(),
  reference      text not null unique,
  customer_name  text not null,
  customer_email text not null,
  customer_phone text not null,
  items          jsonb not null,           -- [{id, name, price, qty}]
  amount         integer not null,         -- total in KSh (whole shillings)
  currency       text not null default 'KES',
  status         text not null default 'pending' check (status in ('pending', 'paid', 'failed')),
  channel        text,                     -- e.g. mobile_money, card
  paid_at        timestamptz,
  created_at     timestamptz not null default now()
);

create index if not exists nayah_orders_created_at_idx on public.nayah_orders (created_at desc);

alter table public.nayah_orders enable row level security;

-- Signed-in admins can read orders and update status (e.g. mark fulfilled manually).
-- Anonymous visitors get no access; the Edge Function bypasses RLS with the service role.
drop policy if exists "admins read orders" on public.nayah_orders;
create policy "admins read orders" on public.nayah_orders
  for select to authenticated using (true);
