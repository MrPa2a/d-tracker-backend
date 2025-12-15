-- MIGRATION SCANNER V3 (UPDATE)
-- Ajout du support pour la période variable et le filtrage par liste d'items (Favoris)

DROP FUNCTION IF EXISTS market_scanner_v3;

CREATE OR REPLACE FUNCTION market_scanner_v3(
  p_server TEXT,
  p_min_price NUMERIC DEFAULT NULL,
  p_max_price NUMERIC DEFAULT NULL,
  p_min_profit NUMERIC DEFAULT NULL,
  p_min_margin NUMERIC DEFAULT NULL,
  p_freshness_hours INT DEFAULT NULL,
  p_min_volatility NUMERIC DEFAULT NULL,
  p_max_volatility NUMERIC DEFAULT NULL,
  p_categories TEXT[] DEFAULT NULL,
  p_limit INT DEFAULT 50,
  p_period_days INT DEFAULT 7,
  p_filter_items TEXT[] DEFAULT NULL
)
RETURNS TABLE (
  item_name TEXT,
  server TEXT,
  category TEXT,
  current_price NUMERIC,
  avg_price NUMERIC,
  profit NUMERIC,
  margin NUMERIC,
  volatility NUMERIC,
  last_seen_at TIMESTAMPTZ,
  days_seen BIGINT,
  icon_url TEXT
)
LANGUAGE sql
STABLE
AS $$
  WITH 
  -- 1. Define the period for stats based on p_period_days
  period_params AS (
    SELECT 
      (NOW() - (p_period_days || ' days')::interval)::date as start_date,
      NOW()::date as end_date
  ),
  -- 2. Get daily averages for the period
  daily AS (
    SELECT 
      o.item_id,
      date_trunc('day', o.captured_at)::date AS day,
      AVG(o.price_unit_avg) AS avg_price
    FROM observations o, period_params pp
    WHERE 
      o.server = p_server
      AND o.captured_at >= pp.start_date::timestamptz
      -- Optimization: Filter items early if p_filter_items is provided
      AND (p_filter_items IS NULL OR o.item_id IN (SELECT id FROM items WHERE name = ANY(p_filter_items)))
    GROUP BY o.item_id, 2
  ),
  -- 3. Calculate daily changes for volatility
  daily_stats AS (
      SELECT
          item_id,
          day,
          avg_price,
          COALESCE(
            (avg_price - LAG(avg_price) OVER (PARTITION BY item_id ORDER BY day))
            / NULLIF(LAG(avg_price) OVER (PARTITION BY item_id ORDER BY day), 0) * 100
          , 0) AS pct_change,
          COUNT(*) OVER (PARTITION BY item_id) as days_count
      FROM daily
  ),
  -- 4. Aggregate stats per item
  aggregated_stats AS (
      SELECT
          item_id,
          STDDEV(pct_change) as volatility_calc,
          AVG(avg_price) as period_avg_price,
          MAX(days_count) as days_seen
      FROM daily_stats
      GROUP BY item_id
  ),
  -- 5. Get the absolute latest observation
  latest_obs AS (
      SELECT DISTINCT ON (o.item_id)
          o.item_id,
          o.price_unit_avg as current_price,
          o.captured_at as last_seen_at
      FROM observations o
      WHERE o.server = p_server
      AND (p_filter_items IS NULL OR o.item_id IN (SELECT id FROM items WHERE name = ANY(p_filter_items)))
      ORDER BY o.item_id, o.captured_at DESC
  )
  SELECT 
    i.name as item_name,
    p_server AS server,
    c.name as category,
    ROUND(lo.current_price, 0) AS current_price,
    ROUND(s.period_avg_price, 0) AS avg_price,
    ROUND(s.period_avg_price - lo.current_price, 0) AS profit,
    ROUND(((s.period_avg_price - lo.current_price) / NULLIF(s.period_avg_price, 0)) * 100, 2) AS margin,
    ROUND(COALESCE(s.volatility_calc, 0), 2) AS volatility,
    lo.last_seen_at,
    s.days_seen,
    i.icon_url
  FROM aggregated_stats s
  JOIN latest_obs lo ON s.item_id = lo.item_id
  JOIN items i ON s.item_id = i.id
  LEFT JOIN categories c ON i.category_id = c.id
  WHERE 
    -- Budget
    (p_min_price IS NULL OR lo.current_price >= p_min_price)
    AND (p_max_price IS NULL OR lo.current_price <= p_max_price)
    -- Profit
    AND (p_min_profit IS NULL OR (s.period_avg_price - lo.current_price) >= p_min_profit)
    -- Margin
    AND (p_min_margin IS NULL OR ((s.period_avg_price - lo.current_price) / NULLIF(s.period_avg_price, 0) * 100) >= p_min_margin)
    -- Freshness
    AND (p_freshness_hours IS NULL OR lo.last_seen_at >= NOW() - (p_freshness_hours || ' hours')::interval)
    -- Stability
    AND (p_min_volatility IS NULL OR COALESCE(s.volatility_calc, 0) >= p_min_volatility)
    AND (p_max_volatility IS NULL OR COALESCE(s.volatility_calc, 0) <= p_max_volatility)
    -- Categories
    AND (p_categories IS NULL OR c.name = ANY(p_categories))
  ORDER BY profit DESC
  LIMIT p_limit;
$$;
