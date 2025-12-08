create or replace function public.items_with_latest_stats()
returns table (
  item_name text,
  server text,
  last_observation_at timestamptz,
  last_price numeric
)
language sql
stable
as $$
  select
    mo.item_name,
    mo.server,
    max(mo.captured_at) as last_observation_at,
    (
      select price_unit_avg
      from market_observations mo2
      where mo2.item_name = mo.item_name
        and mo2.server = mo.server
      order by mo2.captured_at desc
      limit 1
    ) as last_price
  from market_observations mo
  group by mo.item_name, mo.server
  order by mo.item_name, mo.server;
$$;