-- Function to count market items with filters (bypasses PostgREST row limit)
DROP FUNCTION IF EXISTS public.count_market_items_v3(text, text, text, numeric, numeric, text[]);

CREATE OR REPLACE FUNCTION public.count_market_items_v3(
  p_server text,
  p_category text DEFAULT NULL,
  p_search text DEFAULT NULL,
  p_min_price numeric DEFAULT NULL,
  p_max_price numeric DEFAULT NULL,
  p_filter_items text[] DEFAULT NULL
)
RETURNS integer
LANGUAGE sql
STABLE
AS $$
  WITH latest_obs AS (
    SELECT DISTINCT ON (o.item_id, o.server)
      o.item_id,
      o.server,
      o.price_unit_avg AS last_price
    FROM observations o
    WHERE o.server = p_server
    ORDER BY o.item_id, o.server, o.captured_at DESC
  )
  SELECT COUNT(*)::integer
  FROM latest_obs lo
  JOIN items i ON lo.item_id = i.id
  LEFT JOIN categories c ON i.category_id = c.id
  WHERE 
    (p_category IS NULL OR c.name = p_category)
    AND (p_search IS NULL OR unaccent(lower(i.name)) ILIKE '%' || unaccent(lower(p_search)) || '%')
    AND (p_min_price IS NULL OR lo.last_price >= p_min_price)
    AND (p_max_price IS NULL OR lo.last_price <= p_max_price)
    AND (p_filter_items IS NULL OR i.name = ANY(p_filter_items));
$$;
