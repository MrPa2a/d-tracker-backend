-- MIGRATION V3 RPC FUNCTIONS
-- Versions optimisées utilisant les tables relationnelles (items + observations)

-- 1. Timeseries Daily V3
CREATE OR REPLACE FUNCTION public.timeseries_daily_v3(
  p_item_name text,
  p_server text,
  p_from timestamptz,
  p_to timestamptz
)
RETURNS TABLE (
  day date,
  avg_price numeric
)
LANGUAGE sql
STABLE
AS $$
  select
    date_trunc('day', o.captured_at)::date as day,
    avg(o.price_unit_avg) as avg_price
  from observations o
  join items i on o.item_id = i.id
  where i.name = p_item_name
    and o.server = p_server
    and o.captured_at between p_from and p_to
  group by 1
  order by 1;
$$;

-- 2. Get Movers V3
CREATE OR REPLACE FUNCTION get_movers_v3(
    p_server TEXT,
    p_from DATE,
    p_to DATE,
    p_limit INT,
    p_min_price NUMERIC DEFAULT NULL,
    p_max_price NUMERIC DEFAULT NULL,
    p_filter_items TEXT[] DEFAULT NULL,
    p_order TEXT DEFAULT 'abs'
)
RETURNS TABLE (
    item_name TEXT,
    server TEXT,
    last_price NUMERIC,
    pct_change NUMERIC
)
LANGUAGE sql
STABLE
AS $$
  with daily as (
    select
      o.item_id,
      o.server,
      date_trunc('day', o.captured_at)::date as day,
      avg(o.price_unit_avg) as avg_price
    from observations o
    where o.server = p_server
      and o.captured_at >= p_from::timestamptz
      and o.captured_at < (p_to + interval '1 day')::timestamptz
      AND (p_filter_items IS NULL OR o.item_id IN (SELECT id FROM items WHERE name = ANY(p_filter_items)))
    group by o.item_id, o.server, day
  ),
  first_last as (
    select
      d.item_id,
      d.server,
      (array_agg(d.avg_price order by d.day asc))[1] as first_avg,
      (array_agg(d.avg_price order by d.day desc))[1] as last_avg,
      count(distinct d.day) as num_days
    from daily d
    group by d.item_id, d.server
    having count(distinct d.day) >= 2
  )
  select 
      i.name as item_name,
      fl.server,
      fl.last_avg::numeric as last_price,
      case 
        when fl.first_avg = 0 then 0
        else round(((fl.last_avg - fl.first_avg) / fl.first_avg * 100)::numeric, 2)
      end as pct_change
  from first_last fl
  join items i on fl.item_id = i.id
  where 
    (p_min_price IS NULL OR fl.last_avg >= p_min_price)
    AND (p_max_price IS NULL OR fl.last_avg <= p_max_price)
  order by 
      CASE WHEN p_order = 'asc' THEN 
        (case when fl.first_avg = 0 then 0 else ((fl.last_avg - fl.first_avg) / fl.first_avg * 100) end) 
      END ASC,
      CASE WHEN p_order = 'desc' THEN 
        (case when fl.first_avg = 0 then 0 else ((fl.last_avg - fl.first_avg) / fl.first_avg * 100) end) 
      END DESC,
      CASE WHEN p_order = 'abs' THEN 
        ABS(case when fl.first_avg = 0 then 0 else ((fl.last_avg - fl.first_avg) / fl.first_avg * 100) end) 
      END DESC
  limit p_limit;
$$;

-- 3. Get Volatility Rankings V3
CREATE OR REPLACE FUNCTION get_volatility_rankings_v3(
    p_server TEXT,
    p_from DATE,
    p_to DATE,
    p_limit INT,
    p_order TEXT DEFAULT 'desc',
    p_min_price NUMERIC DEFAULT NULL,
    p_max_price NUMERIC DEFAULT NULL,
    p_filter_items TEXT[] DEFAULT NULL
)
RETURNS TABLE (
    item_name TEXT,
    server TEXT,
    volatility NUMERIC,
    last_price NUMERIC,
    pct_change NUMERIC,
    obs_count BIGINT
)
LANGUAGE sql
STABLE
AS $$
  WITH daily AS (
    SELECT 
      o.item_id,
      date_trunc('day', o.captured_at)::date AS day,
      AVG(o.price_unit_avg) AS avg_price
    FROM observations o
    WHERE 
      o.server = p_server
      AND o.captured_at >= p_from::timestamptz
      AND o.captured_at < (p_to + interval '1 day')::timestamptz
      AND (p_filter_items IS NULL OR o.item_id IN (SELECT id FROM items WHERE name = ANY(p_filter_items)))
    GROUP BY o.item_id, 2
  ),
  daily_changes AS (
    SELECT 
      item_id,
      day,
      avg_price,
      CASE 
        WHEN LAG(avg_price) OVER (PARTITION BY item_id ORDER BY day) IS NOT NULL 
        THEN (((avg_price - LAG(avg_price) OVER (PARTITION BY item_id ORDER BY day)) / LAG(avg_price) OVER (PARTITION BY item_id ORDER BY day)) * 100)::numeric
        ELSE 0::numeric
      END AS pct_change
    FROM daily
  ),
  stats AS (
    SELECT 
      item_id,
      STDDEV(pct_change)::numeric AS volatility_calc,
      (array_agg(avg_price ORDER BY day DESC))[1] AS last_price,
      (array_agg(avg_price ORDER BY day ASC))[1] AS first_price,
      COUNT(*) AS obs_count
    FROM daily_changes
    GROUP BY item_id
    HAVING COUNT(*) >= 2
  )
  SELECT 
    i.name as item_name,
    p_server AS server,
    ROUND(COALESCE(s.volatility_calc, 0), 2) AS volatility,
    ROUND(s.last_price, 0) AS last_price,
    CASE 
        WHEN s.first_price = 0 THEN 0
        ELSE ROUND(((s.last_price - s.first_price) / s.first_price * 100)::numeric, 2)
    END AS pct_change,
    s.obs_count
  FROM stats s
  JOIN items i ON s.item_id = i.id
  WHERE 
    (p_min_price IS NULL OR s.last_price >= p_min_price)
    AND (p_max_price IS NULL OR s.last_price <= p_max_price)
  ORDER BY 
    CASE WHEN p_order = 'asc' THEN s.volatility_calc END ASC,
    CASE WHEN p_order = 'desc' THEN s.volatility_calc END DESC
  LIMIT p_limit;
$$;

-- 4. Item Stats V3
DROP FUNCTION IF EXISTS public.item_stats_v3(text, text, date, date);

CREATE OR REPLACE FUNCTION item_stats_v3(
  p_item_name TEXT,
  p_server TEXT,
  p_from DATE,
  p_to DATE
)
RETURNS TABLE (
  item_name TEXT,
  server TEXT,
  volatility NUMERIC,
  median_price NUMERIC,
  signal TEXT,
  ma7 NUMERIC,
  current_price NUMERIC,
  category TEXT
)
LANGUAGE sql
STABLE
AS $$
  WITH daily AS (
    SELECT 
      DATE(o.captured_at) AS day,
      AVG(o.price_unit_avg)::numeric AS avg_price
    FROM observations o
    JOIN items i ON o.item_id = i.id
    WHERE 
      i.name = p_item_name
      AND o.server = p_server
      AND DATE(o.captured_at) BETWEEN p_from AND p_to
    GROUP BY DATE(o.captured_at)
    ORDER BY DATE(o.captured_at)
  ),
  daily_changes AS (
    SELECT 
      day,
      avg_price,
      (avg_price - LAG(avg_price) OVER (ORDER BY day))::numeric AS price_change,
      CASE 
        WHEN LAG(avg_price) OVER (ORDER BY day) IS NOT NULL 
        THEN (((avg_price - LAG(avg_price) OVER (ORDER BY day)) / LAG(avg_price) OVER (ORDER BY day)) * 100)::numeric
        ELSE 0::numeric
      END AS pct_change
    FROM daily
  ),
  stats AS (
    SELECT 
      STDDEV(pct_change)::numeric AS volatility_calc,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY avg_price)::numeric AS median_calc,
      (SELECT avg_price FROM daily ORDER BY day DESC LIMIT 1)::numeric AS latest_price,
      AVG(avg_price) FILTER (WHERE day >= (SELECT MAX(day) FROM daily) - INTERVAL '6 days')::numeric AS ma7_calc
    FROM daily_changes
  ),
  item_info AS (
    SELECT c.name as category_name
    FROM items i
    LEFT JOIN categories c ON i.category_id = c.id
    WHERE i.name = p_item_name
    LIMIT 1
  )
  SELECT 
    p_item_name AS item_name,
    p_server AS server,
    ROUND(COALESCE(stats.volatility_calc, 0::numeric), 2) AS volatility,
    ROUND(COALESCE(stats.median_calc, 0::numeric), 0) AS median_price,
    CASE 
      WHEN stats.latest_price IS NULL OR stats.ma7_calc IS NULL OR stats.volatility_calc IS NULL THEN 'neutral'
      WHEN stats.latest_price < stats.ma7_calc - stats.volatility_calc * stats.ma7_calc / 100 THEN 'buy'
      WHEN stats.latest_price > stats.ma7_calc + stats.volatility_calc * stats.ma7_calc / 100 THEN 'sell'
      ELSE 'neutral'
    END AS signal,
    ROUND(COALESCE(stats.ma7_calc, 0::numeric), 0) AS ma7,
    ROUND(COALESCE(stats.latest_price, 0::numeric), 0) AS current_price,
    item_info.category_name AS category
  FROM stats, item_info;
$$;

-- 5. Market Index V3
CREATE OR REPLACE FUNCTION market_index_v3(
  p_server TEXT,
  p_from DATE,
  p_to DATE,
  p_filter_items TEXT[] DEFAULT NULL
)
RETURNS TABLE (
  server TEXT,
  index_change NUMERIC,
  total_items BIGINT
)
LANGUAGE sql
STABLE
AS $$
  WITH daily AS (
    SELECT 
      o.item_id,
      date_trunc('day', o.captured_at)::date AS day,
      AVG(o.price_unit_avg) AS avg_price
    FROM observations o
    WHERE 
      o.server = p_server
      AND o.captured_at >= p_from::timestamptz
      AND o.captured_at < (p_to + interval '1 day')::timestamptz
      AND (p_filter_items IS NULL OR o.item_id IN (SELECT id FROM items WHERE name = ANY(p_filter_items)))
    GROUP BY o.item_id, 2
  ),
  first_last AS (
    SELECT 
      d.item_id,
      (array_agg(d.avg_price ORDER BY d.day ASC))[1] AS first_price,
      (array_agg(d.avg_price ORDER BY d.day DESC))[1] AS last_price,
      COUNT(DISTINCT d.day) AS obs_count
    FROM daily d
    GROUP BY d.item_id
    HAVING COUNT(DISTINCT d.day) >= 2
  ),
  weighted_changes AS (
    SELECT 
      item_id,
      obs_count,
      CASE 
        WHEN first_price > 0 AND last_price IS NOT NULL
        THEN ((last_price - first_price) / first_price) * 100 * obs_count
        ELSE 0
      END AS weighted_pct_change,
      obs_count AS weight
    FROM first_last
    WHERE first_price > 0 AND last_price IS NOT NULL
  )
  SELECT 
    p_server AS server,
    ROUND(COALESCE(SUM(weighted_pct_change) / NULLIF(SUM(weight), 0), 0), 2) AS index_change,
    COUNT(*)::BIGINT AS total_items
  FROM weighted_changes;
$$;

-- 6. Investment Opportunities V3
CREATE OR REPLACE FUNCTION investment_opportunities_v3(
  p_server TEXT,
  p_from DATE,
  p_to DATE,
  p_limit INT DEFAULT 20,
  p_min_price NUMERIC DEFAULT NULL,
  p_max_price NUMERIC DEFAULT NULL,
  p_filter_items TEXT[] DEFAULT NULL
)
RETURNS TABLE (
  item_name TEXT,
  server TEXT,
  current_price NUMERIC,
  ma7 NUMERIC,
  volatility NUMERIC,
  target_price NUMERIC,
  discount_pct NUMERIC
)
LANGUAGE sql
STABLE
AS $$
  WITH daily AS (
    SELECT 
      o.item_id,
      date_trunc('day', o.captured_at)::date AS day,
      AVG(o.price_unit_avg) AS avg_price
    FROM observations o
    WHERE 
      o.server = p_server
      AND o.captured_at >= p_from::timestamptz
      AND o.captured_at < (p_to + interval '1 day')::timestamptz
      AND (p_filter_items IS NULL OR o.item_id IN (SELECT id FROM items WHERE name = ANY(p_filter_items)))
    GROUP BY o.item_id, 2
  ),
  daily_stats AS (
      SELECT
          item_id,
          day,
          avg_price,
          -- PCT Change for Volatility
          COALESCE(
            (avg_price - LAG(avg_price) OVER (PARTITION BY item_id ORDER BY day))
            / NULLIF(LAG(avg_price) OVER (PARTITION BY item_id ORDER BY day), 0) * 100
          , 0) AS pct_change,
          -- MA7 (Rolling)
          AVG(avg_price) OVER (PARTITION BY item_id ORDER BY day ROWS BETWEEN 6 PRECEDING AND CURRENT ROW) as ma7_rolling,
          -- Rank to identify the last day
          ROW_NUMBER() OVER (PARTITION BY item_id ORDER BY day DESC) as rn
      FROM daily
  ),
  aggregated_stats AS (
      SELECT
          item_id,
          -- Volatility over the whole period
          STDDEV(pct_change) as volatility_calc,
          -- Latest price (from the row with rn=1)
          MAX(CASE WHEN rn = 1 THEN avg_price END) as latest_price,
          -- MA7 (from the row with rn=1)
          MAX(CASE WHEN rn = 1 THEN ma7_rolling END) as ma7_calc
      FROM daily_stats
      GROUP BY item_id
      HAVING COUNT(*) >= 3 -- Ensure enough data points
  )
  SELECT 
    i.name as item_name,
    p_server AS server,
    ROUND(s.latest_price, 0) AS current_price,
    ROUND(s.ma7_calc, 0) AS ma7,
    ROUND(COALESCE(s.volatility_calc, 0), 2) AS volatility,
    ROUND(s.ma7_calc * (1 - COALESCE(s.volatility_calc, 0)/100), 0) AS target_price,
    ROUND(
      ((s.ma7_calc * (1 - COALESCE(s.volatility_calc, 0)/100) - s.latest_price) 
       / NULLIF(s.ma7_calc * (1 - COALESCE(s.volatility_calc, 0)/100), 0)) * 100
    , 2) AS discount_pct
  FROM aggregated_stats s
  JOIN items i ON s.item_id = i.id
  WHERE 
    s.latest_price IS NOT NULL 
    AND s.ma7_calc IS NOT NULL
    AND s.volatility_calc IS NOT NULL
    AND s.latest_price < (s.ma7_calc * (1 - s.volatility_calc/100))
    AND (p_min_price IS NULL OR s.latest_price >= p_min_price)
    AND (p_max_price IS NULL OR s.latest_price <= p_max_price)
  ORDER BY discount_pct DESC
  LIMIT p_limit;
$$;

-- 7. Sell Opportunities V3
CREATE OR REPLACE FUNCTION sell_opportunities_v3(
  p_server TEXT,
  p_from DATE,
  p_to DATE,
  p_limit INT DEFAULT 20,
  p_min_price NUMERIC DEFAULT NULL,
  p_max_price NUMERIC DEFAULT NULL,
  p_filter_items TEXT[] DEFAULT NULL
)
RETURNS TABLE (
  item_name TEXT,
  server TEXT,
  current_price NUMERIC,
  ma7 NUMERIC,
  volatility NUMERIC,
  target_price NUMERIC,
  premium_pct NUMERIC
)
LANGUAGE sql
STABLE
AS $$
  WITH daily AS (
    SELECT 
      o.item_id,
      date_trunc('day', o.captured_at)::date AS day,
      AVG(o.price_unit_avg) AS avg_price
    FROM observations o
    WHERE 
      o.server = p_server
      AND o.captured_at >= p_from::timestamptz
      AND o.captured_at < (p_to + interval '1 day')::timestamptz
      AND (p_filter_items IS NULL OR o.item_id IN (SELECT id FROM items WHERE name = ANY(p_filter_items)))
    GROUP BY o.item_id, 2
  ),
  daily_stats AS (
      SELECT
          item_id,
          day,
          avg_price,
          -- PCT Change for Volatility
          COALESCE(
            (avg_price - LAG(avg_price) OVER (PARTITION BY item_id ORDER BY day))
            / NULLIF(LAG(avg_price) OVER (PARTITION BY item_id ORDER BY day), 0) * 100
          , 0) AS pct_change,
          -- MA7 (Rolling)
          AVG(avg_price) OVER (PARTITION BY item_id ORDER BY day ROWS BETWEEN 6 PRECEDING AND CURRENT ROW) as ma7_rolling,
          -- Rank to identify the last day
          ROW_NUMBER() OVER (PARTITION BY item_id ORDER BY day DESC) as rn
      FROM daily
  ),
  aggregated_stats AS (
      SELECT
          item_id,
          -- Volatility over the whole period
          STDDEV(pct_change) as volatility_calc,
          -- Latest price (from the row with rn=1)
          MAX(CASE WHEN rn = 1 THEN avg_price END) as latest_price,
          -- MA7 (from the row with rn=1)
          MAX(CASE WHEN rn = 1 THEN ma7_rolling END) as ma7_calc
      FROM daily_stats
      GROUP BY item_id
      HAVING COUNT(*) >= 3 -- Ensure enough data points
  )
  SELECT 
    i.name as item_name,
    p_server AS server,
    ROUND(s.latest_price, 0) AS current_price,
    ROUND(s.ma7_calc, 0) AS ma7,
    ROUND(COALESCE(s.volatility_calc, 0), 2) AS volatility,
    ROUND(s.ma7_calc * (1 + COALESCE(s.volatility_calc, 0)/100), 0) AS target_price,
    ROUND(
      ((s.latest_price - (s.ma7_calc * (1 + COALESCE(s.volatility_calc, 0)/100))) 
       / NULLIF(s.ma7_calc * (1 + COALESCE(s.volatility_calc, 0)/100), 0)) * 100
    , 2) AS premium_pct
  FROM aggregated_stats s
  JOIN items i ON s.item_id = i.id
  WHERE 
    s.latest_price IS NOT NULL 
    AND s.ma7_calc IS NOT NULL
    AND s.volatility_calc IS NOT NULL
    AND s.latest_price > (s.ma7_calc * (1 + s.volatility_calc/100))
    AND (p_min_price IS NULL OR s.latest_price >= p_min_price)
    AND (p_max_price IS NULL OR s.latest_price <= p_max_price)
  ORDER BY premium_pct DESC
  LIMIT p_limit;
$$;

-- 8. Items With Latest Stats V3
DROP FUNCTION IF EXISTS public.items_with_latest_stats_v3();

CREATE OR REPLACE FUNCTION public.items_with_latest_stats_v3()
RETURNS TABLE (
  item_name text,
  server text,
  last_observation_at timestamptz,
  last_price numeric,
  category text,
  average_price numeric,
  normalized_name text
)
LANGUAGE sql
STABLE
AS $$
  WITH latest_obs AS (
    SELECT DISTINCT ON (o.item_id, o.server)
      o.item_id,
      o.server,
      o.captured_at,
      o.price_unit_avg
    FROM observations o
    ORDER BY o.item_id, o.server, o.captured_at DESC
  ),
  avg_obs AS (
    SELECT 
      item_id,
      server,
      AVG(price_unit_avg) as average_price
    FROM observations
    WHERE captured_at >= NOW() - INTERVAL '30 days'
    GROUP BY item_id, server
  )
  SELECT
    i.name AS item_name,
    lo.server,
    lo.captured_at AS last_observation_at,
    lo.price_unit_avg AS last_price,
    c.name AS category,
    ROUND(COALESCE(ao.average_price, lo.price_unit_avg), 0) as average_price,
    unaccent(lower(i.name)) AS normalized_name
  FROM latest_obs lo
  JOIN items i ON lo.item_id = i.id
  LEFT JOIN categories c ON i.category_id = c.id
  LEFT JOIN avg_obs ao ON lo.item_id = ao.item_id AND lo.server = ao.server
  ORDER BY i.name, lo.server;
$$;

-- 9. Get Unique Servers V3
CREATE OR REPLACE FUNCTION public.get_unique_servers_v3()
RETURNS TABLE (server text)
LANGUAGE sql
STABLE
AS $$
  SELECT DISTINCT server FROM observations ORDER BY server;
$$;


