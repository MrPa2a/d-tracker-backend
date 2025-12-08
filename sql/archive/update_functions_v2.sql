-- Index optimization (Run this once)
CREATE INDEX IF NOT EXISTS idx_market_observations_server_captured_at 
ON market_observations (server, captured_at);

-- Function to get movers with optional item filter
CREATE OR REPLACE FUNCTION get_movers_v2(
    p_server TEXT,
    p_from DATE,
    p_to DATE,
    p_limit INT,
    p_min_price NUMERIC DEFAULT NULL,
    p_max_price NUMERIC DEFAULT NULL,
    p_filter_items TEXT[] DEFAULT NULL
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
      mo.item_name,
      mo.server,
      date_trunc('day', mo.captured_at) as day,
      avg(mo.price_unit_avg) as avg_price
    from market_observations mo
    where mo.server = p_server
      and mo.captured_at >= p_from::timestamptz
      and mo.captured_at < (p_to + interval '1 day')::timestamptz
      AND (p_filter_items IS NULL OR mo.item_name = ANY(p_filter_items))
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
        else round(((fl.last_avg - fl.first_avg) / fl.first_avg * 100)::numeric, 2)
      end as pct_change
  from first_last fl
  where 
    (p_min_price IS NULL OR fl.last_avg >= p_min_price)
    AND (p_max_price IS NULL OR fl.last_avg <= p_max_price)
  order by abs(
      case 
        when fl.first_avg = 0 then 0
        else ((fl.last_avg - fl.first_avg) / fl.first_avg * 100)
      end
  ) desc
  limit p_limit;
$$;

-- Function to get volatility rankings with optional item filter
CREATE OR REPLACE FUNCTION get_volatility_rankings_v2(
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
      mo.item_name,
      DATE(mo.captured_at) AS day,
      AVG(mo.price_unit_avg) AS avg_price
    FROM public.market_observations mo
    WHERE 
      mo.server = p_server
      AND mo.captured_at >= p_from::timestamptz
      AND mo.captured_at < (p_to + interval '1 day')::timestamptz
      AND (p_filter_items IS NULL OR mo.item_name = ANY(p_filter_items))
    GROUP BY mo.item_name, DATE(mo.captured_at)
  ),
  daily_changes AS (
    SELECT 
      item_name,
      day,
      avg_price,
      COALESCE(
        (avg_price - LAG(avg_price) OVER (PARTITION BY item_name ORDER BY day))
        / NULLIF(LAG(avg_price) OVER (PARTITION BY item_name ORDER BY day), 0) * 100
      , 0) AS pct_change
    FROM daily
  ),
  item_volatility AS (
    SELECT 
      dc.item_name,
      STDDEV(dc.pct_change) AS volatility_calc,
      COUNT(DISTINCT dc.day) AS obs_count,
      (SELECT d2.avg_price FROM daily d2 WHERE d2.item_name = dc.item_name ORDER BY day DESC LIMIT 1) AS latest_price
    FROM daily_changes dc
    GROUP BY dc.item_name
    HAVING COUNT(DISTINCT dc.day) >= 2
  )
  SELECT 
    iv.item_name,
    p_server AS server,
    ROUND(COALESCE(iv.volatility_calc, 0), 2) AS volatility,
    ROUND(iv.latest_price, 0) AS last_price,
    0::NUMERIC AS pct_change,
    iv.obs_count
  FROM item_volatility iv
  WHERE 
    (p_min_price IS NULL OR iv.latest_price >= p_min_price)
    AND (p_max_price IS NULL OR iv.latest_price <= p_max_price)
  ORDER BY 
    CASE WHEN p_order = 'asc' THEN iv.volatility_calc END ASC,
    CASE WHEN p_order = 'desc' THEN iv.volatility_calc END DESC
  LIMIT p_limit;
$$;

-- Fonction SQL pour identifier les opportunités d'investissement (Buy Signal) avec filtre
CREATE OR REPLACE FUNCTION investment_opportunities_v2(
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
      mo.item_name,
      DATE(mo.captured_at) AS day,
      AVG(mo.price_unit_avg) AS avg_price
    FROM public.market_observations mo
    WHERE 
      mo.server = p_server
      AND mo.captured_at >= p_from::timestamptz
      AND mo.captured_at < (p_to + interval '1 day')::timestamptz
      AND (p_filter_items IS NULL OR mo.item_name = ANY(p_filter_items))
    GROUP BY mo.item_name, DATE(mo.captured_at)
  ),
  daily_changes AS (
    SELECT 
      item_name,
      day,
      avg_price,
      COALESCE(
        (avg_price - LAG(avg_price) OVER (PARTITION BY item_name ORDER BY day))
        / NULLIF(LAG(avg_price) OVER (PARTITION BY item_name ORDER BY day), 0) * 100
      , 0) AS pct_change
    FROM daily
  ),
  item_stats AS (
    SELECT 
      dc.item_name,
      STDDEV(dc.pct_change) AS volatility_calc,
      (SELECT d2.avg_price FROM daily d2 WHERE d2.item_name = dc.item_name ORDER BY day DESC LIMIT 1) AS latest_price,
      AVG(dc.avg_price) FILTER (WHERE dc.day >= (SELECT MAX(d3.day) FROM daily d3 WHERE d3.item_name = dc.item_name) - INTERVAL '6 days') AS ma7_calc
    FROM daily_changes dc
    GROUP BY dc.item_name
    HAVING COUNT(DISTINCT dc.day) >= 3 -- Au moins 3 jours de données pour être pertinent
  )
  SELECT 
    ist.item_name,
    p_server AS server,
    ROUND(ist.latest_price, 0) AS current_price,
    ROUND(ist.ma7_calc, 0) AS ma7,
    ROUND(COALESCE(ist.volatility_calc, 0), 2) AS volatility,
    ROUND(ist.ma7_calc * (1 - COALESCE(ist.volatility_calc, 0)/100), 0) AS target_price,
    ROUND(
      ((ist.ma7_calc * (1 - COALESCE(ist.volatility_calc, 0)/100) - ist.latest_price) 
       / NULLIF(ist.ma7_calc * (1 - COALESCE(ist.volatility_calc, 0)/100), 0)) * 100
    , 2) AS discount_pct
  FROM item_stats ist
  WHERE 
    ist.latest_price IS NOT NULL 
    AND ist.ma7_calc IS NOT NULL
    AND ist.volatility_calc IS NOT NULL
    AND ist.latest_price < (ist.ma7_calc * (1 - ist.volatility_calc/100)) -- Signal d'achat
    AND (p_min_price IS NULL OR ist.latest_price >= p_min_price)
    AND (p_max_price IS NULL OR ist.latest_price <= p_max_price)
  ORDER BY discount_pct DESC
  LIMIT p_limit;
$$;

-- Fonction SQL pour identifier les opportunités de vente (Sell Signal) avec filtre
CREATE OR REPLACE FUNCTION sell_opportunities_v2(
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
      mo.item_name,
      DATE(mo.captured_at) AS day,
      AVG(mo.price_unit_avg) AS avg_price
    FROM public.market_observations mo
    WHERE 
      mo.server = p_server
      AND mo.captured_at >= p_from::timestamptz
      AND mo.captured_at < (p_to + interval '1 day')::timestamptz
      AND (p_filter_items IS NULL OR mo.item_name = ANY(p_filter_items))
    GROUP BY mo.item_name, DATE(mo.captured_at)
  ),
  daily_changes AS (
    SELECT 
      item_name,
      day,
      avg_price,
      COALESCE(
        (avg_price - LAG(avg_price) OVER (PARTITION BY item_name ORDER BY day))
        / NULLIF(LAG(avg_price) OVER (PARTITION BY item_name ORDER BY day), 0) * 100
      , 0) AS pct_change
    FROM daily
  ),
  item_stats AS (
    SELECT 
      dc.item_name,
      STDDEV(dc.pct_change) AS volatility_calc,
      (SELECT d2.avg_price FROM daily d2 WHERE d2.item_name = dc.item_name ORDER BY day DESC LIMIT 1) AS latest_price,
      AVG(dc.avg_price) FILTER (WHERE dc.day >= (SELECT MAX(d3.day) FROM daily d3 WHERE d3.item_name = dc.item_name) - INTERVAL '6 days') AS ma7_calc
    FROM daily_changes dc
    GROUP BY dc.item_name
    HAVING COUNT(DISTINCT dc.day) >= 3 -- Au moins 3 jours de données pour être pertinent
  )
  SELECT 
    ist.item_name,
    p_server AS server,
    ROUND(ist.latest_price, 0) AS current_price,
    ROUND(ist.ma7_calc, 0) AS ma7,
    ROUND(COALESCE(ist.volatility_calc, 0), 2) AS volatility,
    ROUND(ist.ma7_calc * (1 + COALESCE(ist.volatility_calc, 0)/100), 0) AS target_price,
    ROUND(
      ((ist.latest_price - (ist.ma7_calc * (1 + COALESCE(ist.volatility_calc, 0)/100))) 
       / NULLIF(ist.ma7_calc * (1 + COALESCE(ist.volatility_calc, 0)/100), 0)) * 100
    , 2) AS premium_pct
  FROM item_stats ist
  WHERE 
    ist.latest_price IS NOT NULL 
    AND ist.ma7_calc IS NOT NULL
    AND ist.volatility_calc IS NOT NULL
    AND ist.latest_price > (ist.ma7_calc * (1 + ist.volatility_calc/100)) -- Signal de vente
    AND (p_min_price IS NULL OR ist.latest_price >= p_min_price)
    AND (p_max_price IS NULL OR ist.latest_price <= p_max_price)
  ORDER BY premium_pct DESC
  LIMIT p_limit;
$$;

-- Fonction SQL pour calculer l'indice HDV avec filtre
CREATE OR REPLACE FUNCTION market_index_v2(
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
      mo.item_name,
      DATE(mo.captured_at) AS day,
      AVG(mo.price_unit_avg) AS avg_price
    FROM market_observations mo
    WHERE 
      mo.server = p_server
      AND mo.captured_at >= p_from::timestamptz
      AND mo.captured_at < (p_to + interval '1 day')::timestamptz
      AND (p_filter_items IS NULL OR mo.item_name = ANY(p_filter_items))
    GROUP BY mo.item_name, DATE(mo.captured_at)
  ),
  first_last AS (
    SELECT 
      d.item_name,
      (array_agg(d.avg_price ORDER BY d.day ASC))[1] AS first_price,
      (array_agg(d.avg_price ORDER BY d.day DESC))[1] AS last_price,
      COUNT(DISTINCT d.day) AS obs_count
    FROM daily d
    GROUP BY d.item_name
    HAVING COUNT(DISTINCT d.day) >= 2
  ),
  weighted_changes AS (
    SELECT 
      item_name,
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
