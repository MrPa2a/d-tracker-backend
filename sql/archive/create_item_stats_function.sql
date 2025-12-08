-- Fonction SQL pour calculer les statistiques avancées d'un item
-- Retourne: volatilité, prix médian, signal trading (buy/neutral/sell)

CREATE OR REPLACE FUNCTION item_stats(
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
  current_price NUMERIC
)
LANGUAGE sql
STABLE
AS $$
  WITH daily AS (
    SELECT 
      DATE(mo.captured_at) AS day,
      AVG(mo.price_unit_avg)::numeric AS avg_price
    FROM public.market_observations mo
    WHERE 
      mo.item_name = p_item_name
      AND mo.server = p_server
      AND DATE(mo.captured_at) BETWEEN p_from AND p_to
    GROUP BY DATE(mo.captured_at)
    ORDER BY DATE(mo.captured_at)
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
    ROUND(COALESCE(stats.latest_price, 0::numeric), 0) AS current_price
  FROM stats;
$$;