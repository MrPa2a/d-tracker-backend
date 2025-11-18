-- sql/create_movers_function.sql
-- Run this in your Supabase SQL editor (or as a migration) to add the `movers` function

create or replace function public.movers(
  p_server text,
  p_from timestamptz,
  p_to timestamptz,
  p_limit integer default 10
)
returns table (
  item_name text,
  server text,
  last_price numeric,
  pct_change double precision
)
language sql
stable
as $$
  with daily as (
    select
      mo.item_name,
      mo.server,
      date_trunc('day', mo.captured_at) at time zone 'UTC' as day,
      avg(mo.price_unit_avg) as avg_price
    from market_observations mo
    where mo.server = p_server
      and mo.captured_at >= p_from
      and mo.captured_at <= p_to
    group by mo.item_name, mo.server, day
  ),
  first_last as (
    select
      d.item_name,
      d.server,
      (array_agg(d.avg_price order by d.day asc))[1] as first_avg,
      (array_agg(d.avg_price order by d.day desc))[1] as last_avg,
      count(distinct d.day) as num_days
    from daily d
    group by d.item_name, d.server
    having count(distinct d.day) >= 2
  )
  select
    fl.item_name,
    fl.server,
    fl.last_avg::numeric as last_price,
    case 
      when fl.first_avg = 0 then 0 
      else ((fl.last_avg - fl.first_avg) / fl.first_avg) * 100 
    end as pct_change
  from first_last fl
  order by abs(pct_change) desc
  limit p_limit;
$$;
