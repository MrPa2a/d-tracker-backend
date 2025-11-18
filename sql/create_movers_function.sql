-- sql/create_movers_function.sql
-- Run this in your Supabase SQL editor (or as a migration) to add the `movers` function

CREATE OR REPLACE FUNCTION public.movers(
  p_server text,
  p_from timestamptz,
  p_to timestamptz,
  p_limit integer DEFAULT 10
) RETURNS TABLE(item_name text, server text, last_price numeric, pct_change double precision) AS $$
BEGIN
  RETURN QUERY
  WITH daily AS (
    SELECT
      item_name,
      server,
      date_trunc('day', captured_at) AT TIME ZONE 'UTC'::text AS day,
      avg(price_unit_avg) AS avg_price
    FROM public.market_observations
    WHERE server = p_server
      AND captured_at >= p_from
      AND captured_at <= p_to
    GROUP BY item_name, server, day
  ),
  first_last AS (
    SELECT
      item_name,
      server,
      (array_agg(avg_price ORDER BY day ASC))[1] AS first_avg,
      (array_agg(avg_price ORDER BY day DESC))[1] AS last_avg
    FROM daily
    GROUP BY item_name, server
    HAVING (array_length(array_agg(avg_price),1) IS NOT NULL)
  )
  SELECT
    item_name,
    server,
    last_avg::numeric AS last_price,
    CASE WHEN first_avg = 0 THEN 0 ELSE ((last_avg - first_avg)/first_avg)*100 END AS pct_change
  FROM first_last
  ORDER BY pct_change DESC
  LIMIT p_limit;
END;
$$ LANGUAGE plpgsql;
