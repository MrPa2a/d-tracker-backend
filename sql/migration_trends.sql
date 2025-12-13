-- MIGRATION TRENDS V1
-- Fonction pour le Détecteur de Tendance (Trend Hunter)

DROP FUNCTION IF EXISTS market_trends_v1;

CREATE OR REPLACE FUNCTION market_trends_v1(
  p_server TEXT,
  p_period_days INT DEFAULT 30,
  p_min_price NUMERIC DEFAULT NULL,
  p_max_price NUMERIC DEFAULT NULL,
  p_categories TEXT[] DEFAULT NULL,
  p_trend_type TEXT DEFAULT 'bullish', -- 'bullish', 'bearish', 'rebound'
  p_limit INT DEFAULT 50,
  p_filter_items TEXT[] DEFAULT NULL
)
RETURNS TABLE (
  item_id INT,
  item_name TEXT,
  server TEXT,
  category TEXT,
  current_price NUMERIC,
  start_price NUMERIC,
  price_change_pct NUMERIC,
  trend_type TEXT,
  consecutive_days INT,
  history JSONB
)
LANGUAGE sql
STABLE
AS $$
  WITH 
  -- 1. Get daily averages for the period
  daily_prices AS (
    SELECT 
      o.item_id,
      date_trunc('day', o.captured_at)::date AS day,
      AVG(o.price_unit_avg) AS avg_price
    FROM observations o
    JOIN items i ON o.item_id = i.id
    LEFT JOIN categories c ON i.category_id = c.id
    WHERE 
      o.server = p_server
      AND o.captured_at >= (NOW() - (p_period_days || ' days')::interval)
      AND (p_categories IS NULL OR c.name = ANY(p_categories))
      AND (p_filter_items IS NULL OR i.name = ANY(p_filter_items))
    GROUP BY o.item_id, 2
  ),
  -- 2. Calculate daily changes and lag
  daily_changes AS (
    SELECT
      item_id,
      day,
      avg_price,
      LAG(avg_price) OVER (PARTITION BY item_id ORDER BY day) as prev_price,
      CASE 
        WHEN LAG(avg_price) OVER (PARTITION BY item_id ORDER BY day) IS NULL THEN 0
        WHEN avg_price > LAG(avg_price) OVER (PARTITION BY item_id ORDER BY day) THEN 1 -- Up
        WHEN avg_price < LAG(avg_price) OVER (PARTITION BY item_id ORDER BY day) THEN -1 -- Down
        ELSE 0 -- Stable
      END as direction
    FROM daily_prices
  ),
  -- 3. Analyze sequences (Gaps and Islands simplified for recent trend)
  item_trends AS (
    SELECT
      item_id,
      -- Get the last price and the price X days ago
      (ARRAY_AGG(avg_price ORDER BY day DESC))[1] as current_price,
      (ARRAY_AGG(avg_price ORDER BY day ASC))[1] as start_price,
      -- Calculate consecutive days of the *current* trend (simplified logic looking at last few days)
      -- This is a heuristic: we look at the last 3 days directions
      (ARRAY_AGG(direction ORDER BY day DESC))[1] as last_dir,
      (ARRAY_AGG(direction ORDER BY day DESC))[2] as prev_dir,
      (ARRAY_AGG(direction ORDER BY day DESC))[3] as prev_prev_dir,
      -- Full history for sparkline
      JSONB_AGG(jsonb_build_object('d', day, 'p', ROUND(avg_price, 0)) ORDER BY day) as history
    FROM daily_changes
    GROUP BY item_id
  ),
  formatted_results AS (
    SELECT 
        i.id as item_id,
        i.name as item_name,
        p_server as server,
        c.name as category,
        t.current_price,
        t.start_price,
        ROUND(((t.current_price - t.start_price) / NULLIF(t.start_price, 0) * 100), 2) as price_change_pct,
        CASE
            -- Bullish: Last 3 days were UP or Stable-UP
            WHEN t.last_dir = 1 AND t.prev_dir >= 0 THEN 'bullish'
            -- Bearish: Last 3 days were DOWN or Stable-DOWN
            WHEN t.last_dir = -1 AND t.prev_dir <= 0 THEN 'bearish'
            -- Rebound: Was DOWN, now UP
            WHEN t.last_dir = 1 AND t.prev_dir = -1 THEN 'rebound'
            ELSE 'stable'
        END as trend_type,
        CASE
            WHEN t.last_dir = 1 AND t.prev_dir = 1 AND t.prev_prev_dir = 1 THEN 3
            WHEN t.last_dir = 1 AND t.prev_dir = 1 THEN 2
            WHEN t.last_dir = -1 AND t.prev_dir = -1 AND t.prev_prev_dir = -1 THEN 3
            WHEN t.last_dir = -1 AND t.prev_dir = -1 THEN 2
            ELSE 1
        END as consecutive_days,
        t.history
    FROM item_trends t
    JOIN items i ON t.item_id = i.id
    LEFT JOIN categories c ON i.category_id = c.id
  )
  SELECT * FROM formatted_results
  WHERE
    -- Price Filter
    (p_min_price IS NULL OR current_price >= p_min_price)
    AND (p_max_price IS NULL OR current_price <= p_max_price)
    -- Trend Filter
    AND (p_trend_type IS NULL OR trend_type = p_trend_type)
  ORDER BY ABS(price_change_pct) DESC
  LIMIT p_limit;
$$;
