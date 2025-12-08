-- Fonction SQL pour calculer l'indice HDV
-- Retourne la variation moyenne pondérée par nombre d'observations

CREATE OR REPLACE FUNCTION market_index(
  p_server TEXT,
  p_from DATE,
  p_to DATE
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
      AND DATE(mo.captured_at) BETWEEN p_from AND p_to
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