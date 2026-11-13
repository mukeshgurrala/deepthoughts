create table if not exists public.course_purchases (
  id uuid primary key default gen_random_uuid(),
  razorpay_order_id text not null,
  razorpay_payment_id text not null unique,
  amount_paise integer,
  currency text not null default 'INR',
  status text not null default 'paid',
  access_token_hash text not null,
  access_expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists course_purchases_access_token_hash_idx
  on public.course_purchases (access_token_hash);

alter table public.course_purchases enable row level security;
