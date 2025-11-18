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
  WITH item_changes AS (
    SELECT 
      mo.item_name,
      COUNT(DISTINCT DATE(mo.captured_at)) AS obs_count,
      (
        SELECT AVG(mo2.price_unit_avg) 
        FROM market_observations mo2 
        WHERE mo2.item_name = mo.item_name 
          AND mo2.server = p_server
          AND DATE(mo2.captured_at) = p_to
      ) AS last_price,
      (
        SELECT AVG(mo2.price_unit_avg) 
        FROM market_observations mo2 
        WHERE mo2.item_name = mo.item_name 
          AND mo2.server = p_server
          AND DATE(mo2.captured_at) = p_from
      ) AS first_price
    FROM market_observations mo
    WHERE 
      mo.server = p_server
      AND DATE(mo.captured_at) BETWEEN p_from AND p_to
    GROUP BY mo.item_name
    HAVING 
      COUNT(DISTINCT DATE(mo.captured_at)) >= 2
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
    FROM item_changes
    WHERE first_price > 0 AND last_price IS NOT NULL
  )
  SELECT 
    p_server AS server,
    ROUND(SUM(weighted_pct_change) / NULLIF(SUM(weight), 0), 2) AS index_change,
    COUNT(*) AS total_items
  FROM weighted_changes;
$$;