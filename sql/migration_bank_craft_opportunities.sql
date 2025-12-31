-- ============================================================================
-- Migration: Bank Craft Opportunities
-- Description: Fonctions RPC pour identifier les recettes craftables 
--              à partir du contenu de la banque du joueur
-- Date: 2025-12-31
-- ============================================================================

-- ============================================================================
-- Fonction 1: get_bank_craft_opportunities
-- Récupère les opportunités de craft depuis la banque avec filtres et calculs
-- ============================================================================

CREATE OR REPLACE FUNCTION get_bank_craft_opportunities(
    p_server TEXT,
    p_profile_id UUID DEFAULT NULL,
    p_max_missing INTEGER DEFAULT 0,      -- 0 = crafts complets uniquement
    p_min_level INTEGER DEFAULT 0,
    p_max_level INTEGER DEFAULT 200,
    p_job_id INTEGER DEFAULT NULL,
    p_min_roi NUMERIC DEFAULT NULL,
    p_limit INTEGER DEFAULT 50,
    p_offset INTEGER DEFAULT 0,
    p_sort_by TEXT DEFAULT 'completeness_desc', -- 'completeness_desc', 'margin_desc', 'roi_desc'
    p_name_search TEXT DEFAULT NULL
)
RETURNS TABLE (
    recipe_id INTEGER,
    result_item_id INTEGER,
    result_item_name TEXT,
    result_item_icon TEXT,
    job_id INTEGER,
    job_name TEXT,
    job_icon_id INTEGER,
    level INTEGER,
    
    -- Complétude
    total_ingredients INTEGER,
    owned_ingredients INTEGER,
    missing_ingredients INTEGER,
    completeness_pct NUMERIC,
    
    -- Quantités craftables
    max_craftable INTEGER,
    
    -- Coûts
    owned_value NUMERIC,
    missing_cost NUMERIC,
    total_craft_cost NUMERIC,
    
    -- Profit
    sell_price NUMERIC,
    margin NUMERIC,
    roi NUMERIC,
    
    -- Métadonnées
    result_item_last_update TIMESTAMPTZ
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    WITH 
    -- Derniers prix du marché (une seule observation par item)
    latest_prices AS (
        SELECT DISTINCT ON (item_id) 
            item_id, 
            price_unit_avg as price,
            captured_at
        FROM observations
        WHERE server = p_server
        ORDER BY item_id, captured_at DESC
    ),
    
    -- Contenu de la banque (agrégé par item)
    bank_stock AS (
        SELECT 
            bi.item_id,
            SUM(bi.quantity)::INTEGER as total_qty
        FROM bank_items bi
        WHERE bi.server = p_server
          AND (p_profile_id IS NULL OR bi.profile_id = p_profile_id OR bi.profile_id IS NULL)
        GROUP BY bi.item_id
    ),
    
    -- Analyse des recettes avec stock
    recipe_analysis AS (
        SELECT 
            r.id as recipe_id,
            r.result_item_id,
            r.job_id,
            r.level,
            
            -- Compter les ingrédients par statut
            COUNT(*)::INTEGER as total_ingredients,
            COUNT(*) FILTER (WHERE COALESCE(bs.total_qty, 0) >= ri.quantity)::INTEGER as owned_ingredients,
            COUNT(*) FILTER (WHERE COALESCE(bs.total_qty, 0) < ri.quantity)::INTEGER as missing_ingredients,
            
            -- Calcul du nombre de crafts possibles (minimum des ratios)
            COALESCE(
                MIN(
                    CASE 
                        WHEN ri.quantity > 0 THEN FLOOR(COALESCE(bs.total_qty, 0)::NUMERIC / ri.quantity)
                        ELSE 0 
                    END
                )::INTEGER,
                0
            ) as max_craftable,
            
            -- Valeur des ingrédients possédés (limité à la quantité requise)
            COALESCE(SUM(
                LEAST(COALESCE(bs.total_qty, 0), ri.quantity) * COALESCE(lp.price, 0)
            ), 0) as owned_value,
            
            -- Coût des ingrédients manquants
            COALESCE(SUM(
                GREATEST(0, ri.quantity - COALESCE(bs.total_qty, 0)) * COALESCE(lp.price, 0)
            ), 0) as missing_cost,
            
            -- Coût total de la recette
            COALESCE(SUM(ri.quantity * COALESCE(lp.price, 0)), 0) as total_craft_cost
            
        FROM recipes r
        JOIN recipe_ingredients ri ON r.id = ri.recipe_id
        LEFT JOIN bank_stock bs ON ri.item_id = bs.item_id
        LEFT JOIN latest_prices lp ON ri.item_id = lp.item_id
        WHERE r.level BETWEEN p_min_level AND p_max_level
          AND (p_job_id IS NULL OR r.job_id = p_job_id)
        GROUP BY r.id, r.result_item_id, r.job_id, r.level
    )
    
    SELECT 
        ra.recipe_id,
        i.id as result_item_id,
        i.name as result_item_name,
        i.icon_url as result_item_icon,
        j.id as job_id,
        j.name as job_name,
        j.icon_id as job_icon_id,
        ra.level,
        
        ra.total_ingredients,
        ra.owned_ingredients,
        ra.missing_ingredients,
        ROUND((ra.owned_ingredients::NUMERIC / NULLIF(ra.total_ingredients, 0)) * 100, 1) as completeness_pct,
        
        ra.max_craftable,
        
        ra.owned_value,
        ra.missing_cost,
        ra.total_craft_cost,
        
        COALESCE(lp.price, 0) as sell_price,
        (COALESCE(lp.price, 0) - ra.total_craft_cost) as margin,
        CASE 
            WHEN ra.total_craft_cost > 0 
            THEN ROUND(((COALESCE(lp.price, 0) - ra.total_craft_cost) / ra.total_craft_cost) * 100, 2)
            ELSE 0 
        END as roi,
        
        lp.captured_at as result_item_last_update
        
    FROM recipe_analysis ra
    JOIN items i ON ra.result_item_id = i.id
    JOIN jobs j ON ra.job_id = j.id
    LEFT JOIN latest_prices lp ON ra.result_item_id = lp.item_id
    
    WHERE ra.missing_ingredients <= p_max_missing
      AND (p_name_search IS NULL OR i.name ILIKE '%' || p_name_search || '%')
      AND (
          p_min_roi IS NULL 
          OR (
              ra.total_craft_cost > 0 
              AND ((COALESCE(lp.price, 0) - ra.total_craft_cost) / ra.total_craft_cost) * 100 >= p_min_roi
          )
      )
    
    ORDER BY
        CASE WHEN p_sort_by = 'completeness_desc' THEN ra.owned_ingredients END DESC NULLS LAST,
        CASE WHEN p_sort_by = 'margin_desc' THEN (COALESCE(lp.price, 0) - ra.total_craft_cost) END DESC NULLS LAST,
        CASE WHEN p_sort_by = 'roi_desc' THEN 
            CASE WHEN ra.total_craft_cost > 0 
            THEN ((COALESCE(lp.price, 0) - ra.total_craft_cost) / ra.total_craft_cost) * 100 
            ELSE 0 END 
        END DESC NULLS LAST,
        ra.missing_ingredients ASC,
        ra.level DESC
    
    LIMIT p_limit OFFSET p_offset;
END;
$$;

-- ============================================================================
-- Fonction 2: get_craft_ingredients_with_stock
-- Obtient le détail des ingrédients d'une recette avec statut de possession
-- ============================================================================

-- Drop existing function first (return type changed)
DROP FUNCTION IF EXISTS get_craft_ingredients_with_stock(INTEGER, TEXT, UUID);

CREATE OR REPLACE FUNCTION get_craft_ingredients_with_stock(
    p_recipe_id INTEGER,
    p_server TEXT,
    p_profile_id UUID DEFAULT NULL
)
RETURNS TABLE (
    item_id INTEGER,
    name TEXT,
    icon_url TEXT,
    required_quantity INTEGER,
    owned_quantity INTEGER,
    missing_quantity INTEGER,
    unit_price NUMERIC,
    owned_value NUMERIC,
    missing_cost NUMERIC,
    status TEXT,  -- 'complete', 'partial', 'missing'
    ingredient_recipe_id INTEGER  -- ID de la recette si l'ingrédient est craftable
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    WITH bank_stock AS (
        SELECT 
            bi.item_id,
            SUM(bi.quantity)::INTEGER as total_qty
        FROM bank_items bi
        WHERE bi.server = p_server
          AND (p_profile_id IS NULL OR bi.profile_id = p_profile_id OR bi.profile_id IS NULL)
        GROUP BY bi.item_id
    ),
    latest_prices AS (
        SELECT DISTINCT ON (o.item_id) 
            o.item_id, 
            o.price_unit_avg as price
        FROM observations o
        WHERE o.server = p_server
        ORDER BY o.item_id, o.captured_at DESC
    )
    SELECT 
        i.id as item_id,
        i.name,
        i.icon_url,
        ri.quantity as required_quantity,
        COALESCE(bs.total_qty, 0)::INTEGER as owned_quantity,
        GREATEST(0, ri.quantity - COALESCE(bs.total_qty, 0))::INTEGER as missing_quantity,
        COALESCE(lp.price, 0) as unit_price,
        (LEAST(COALESCE(bs.total_qty, 0), ri.quantity) * COALESCE(lp.price, 0)) as owned_value,
        (GREATEST(0, ri.quantity - COALESCE(bs.total_qty, 0)) * COALESCE(lp.price, 0)) as missing_cost,
        CASE 
            WHEN COALESCE(bs.total_qty, 0) >= ri.quantity THEN 'complete'
            WHEN COALESCE(bs.total_qty, 0) > 0 THEN 'partial'
            ELSE 'missing'
        END as status,
        sub_r.id as ingredient_recipe_id
    FROM recipe_ingredients ri
    JOIN items i ON ri.item_id = i.id
    LEFT JOIN bank_stock bs ON ri.item_id = bs.item_id
    LEFT JOIN latest_prices lp ON ri.item_id = lp.item_id
    LEFT JOIN recipes sub_r ON sub_r.result_item_id = ri.item_id
    WHERE ri.recipe_id = p_recipe_id
    ORDER BY 
        CASE 
            WHEN COALESCE(bs.total_qty, 0) >= ri.quantity THEN 0
            WHEN COALESCE(bs.total_qty, 0) > 0 THEN 1
            ELSE 2
        END,
        i.name;
END;
$$;

-- ============================================================================
-- Commentaires pour documentation
-- ============================================================================

COMMENT ON FUNCTION get_bank_craft_opportunities IS 
'Récupère les opportunités de craft depuis la banque du joueur.
Paramètres:
  - p_server: Serveur de jeu (obligatoire)
  - p_profile_id: UUID du profil (optionnel, NULL = tous les profils)
  - p_max_missing: Nombre max d''ingrédients manquants acceptés (0 = craft complet)
  - p_min_level / p_max_level: Plage de niveau des recettes
  - p_job_id: Filtrer par métier (NULL = tous)
  - p_min_roi: ROI minimum en % (NULL = pas de filtre)
  - p_limit / p_offset: Pagination
  - p_sort_by: Tri (completeness_desc, margin_desc, roi_desc)
  - p_name_search: Recherche par nom d''item';

COMMENT ON FUNCTION get_craft_ingredients_with_stock IS 
'Récupère le détail des ingrédients d''une recette avec le statut de possession.
Retourne pour chaque ingrédient:
  - Quantité requise vs possédée
  - Prix unitaire et coûts
  - Statut: complete (assez en stock), partial (stock insuffisant), missing (aucun stock)';
