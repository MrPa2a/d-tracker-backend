-- Fonction SQL pour identifier les opportunités d'investissement (Buy Signal)
-- Retourne les items dont le prix actuel est significativement inférieur à leur moyenne mobile (ajustée par la volatilité)

CREATE OR REPLACE FUNCTION investment_opportunities(
  p_server TEXT,
  p_from DATE,
  p_to DATE,
  p_limit INT DEFAULT 20
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
  ORDER BY discount_pct DESC
  LIMIT p_limit;
$$;
