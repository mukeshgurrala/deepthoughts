alter table public.course_purchases
  alter column razorpay_payment_id drop not null,
  alter column status set default 'pending';

create unique index if not exists course_purchases_razorpay_order_id_key
  on public.course_purchases (razorpay_order_id);
