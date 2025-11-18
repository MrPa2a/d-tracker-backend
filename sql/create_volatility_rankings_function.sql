-- Fonction SQL pour obtenir les items les plus/moins volatils
-- Retourne top items par volatilité avec stats de base

CREATE OR REPLACE FUNCTION volatility_rankings(
  p_server TEXT,
  p_from DATE,
  p_to DATE,
  p_limit INT DEFAULT 10,
  p_order TEXT DEFAULT 'desc'
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
      AND DATE(mo.captured_at) BETWEEN p_from AND p_to
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
      (SELECT d2.avg_price FROM daily d2 WHERE d2.item_name = dc.item_name ORDER BY day DESC LIMIT 1) AS latest_price,
      (SELECT d2.avg_price FROM daily d2 WHERE d2.item_name = dc.item_name ORDER BY day ASC  LIMIT 1) AS first_price
    FROM daily_changes dc
    GROUP BY dc.item_name
    HAVING COUNT(DISTINCT dc.day) >= 2
  )
  SELECT 
    iv.item_name,
    p_server AS server,
    ROUND(COALESCE(iv.volatility_calc, 0), 2) AS volatility,
    ROUND(iv.latest_price, 0) AS last_price,
    ROUND(((iv.latest_price - iv.first_price) / NULLIF(iv.first_price, 0)) * 100, 1) AS pct_change,
    iv.obs_count
  FROM item_volatility iv
  WHERE iv.volatility_calc IS NOT NULL
  ORDER BY 
    CASE WHEN p_order = 'desc' THEN iv.volatility_calc END DESC,
    CASE WHEN p_order = 'asc'  THEN iv.volatility_calc END ASC
  LIMIT p_limit;
$$;
