create or replace function public.timeseries_daily(
  p_item_name text,
  p_server text,
  p_from timestamptz,
  p_to timestamptz
)
returns table (
  day date,
  avg_price numeric
)
language sql
stable
as $$
  select
    date_trunc('day', captured_at)::date as day,
    avg(price_unit_avg) as avg_price
  from market_observations
  where item_name = p_item_name
    and server = p_server
    and captured_at between p_from and p_to
  group by 1
  order by 1;
$$;
