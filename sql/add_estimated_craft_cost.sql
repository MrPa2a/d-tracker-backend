-- Migration: Ajout du calcul du coût estimé via sub-craft avec cascade récursive
-- Ce script ajoute une nouvelle version de get_recipes_with_stats qui calcule
-- le coût estimé en utilisant le craft_cost des ingrédients sans prix de marché
-- de manière RECURSIVE (descend autant de niveaux que nécessaire)

-- Supprime la version existante de la fonction (signature exacte de migration_recipes.sql)
DROP FUNCTION IF EXISTS get_recipes_with_stats(text,integer,integer,integer,numeric,integer,integer,text,text,integer,integer);

CREATE OR REPLACE FUNCTION get_recipes_with_stats(
    p_server TEXT,
    p_min_level INTEGER DEFAULT 0,
    p_max_level INTEGER DEFAULT 200,
    p_job_id INTEGER DEFAULT NULL,
    p_min_roi NUMERIC DEFAULT NULL,
    p_limit INTEGER DEFAULT 50,
    p_offset INTEGER DEFAULT 0,
    p_sort_by TEXT DEFAULT 'margin_desc',
    p_name_search TEXT DEFAULT NULL,
    p_recipe_id INTEGER DEFAULT NULL,
    p_result_item_id INTEGER DEFAULT NULL
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
    craft_cost NUMERIC,
    sell_price NUMERIC,
    margin NUMERIC,
    roi NUMERIC,
    ingredients_count INTEGER,
    ingredients_with_price INTEGER,
    result_item_last_update TIMESTAMPTZ,
    ingredients_last_update TIMESTAMPTZ,
    craft_xp_ratio INTEGER,
    -- Champs pour l'estimation
    estimated_craft_cost NUMERIC,
    estimated_margin NUMERIC,
    estimated_roi NUMERIC,
    has_estimation BOOLEAN,          -- true si au moins un ingrédient a été estimé via sub-craft
    estimation_incomplete BOOLEAN    -- true si certains prix n'ont pas pu être estimés (même en cascade)
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    WITH RECURSIVE
    -- Derniers prix observés pour chaque item
    latest_prices AS (
        SELECT DISTINCT ON (o.item_id) 
            o.item_id, 
            o.price_unit_avg as price,
            o.captured_at
        FROM observations o
        WHERE o.server = p_server
        ORDER BY o.item_id, o.captured_at DESC
    ),
    
    -- Niveau 0: Items avec un prix de marché connu
    item_cost_level_0 AS (
        SELECT 
            lp.item_id,
            lp.price AS effective_cost,
            FALSE AS is_estimated,
            FALSE AS is_incomplete
        FROM latest_prices lp
        WHERE lp.price IS NOT NULL AND lp.price > 0
    ),
    
    -- Niveau 1: Items sans prix mais dont TOUS les ingrédients ont un prix direct (niveau 0)
    item_cost_level_1 AS (
        SELECT 
            r.result_item_id AS item_id,
            SUM(ri.quantity * ic0.effective_cost) AS effective_cost,
            TRUE AS is_estimated,
            FALSE AS is_incomplete  -- Par construction, tous les ingrédients ont un prix
        FROM recipes r
        JOIN recipe_ingredients ri ON r.id = ri.recipe_id
        LEFT JOIN item_cost_level_0 ic0 ON ri.item_id = ic0.item_id
        WHERE NOT EXISTS (
            SELECT 1 FROM item_cost_level_0 ic WHERE ic.item_id = r.result_item_id
        )
        GROUP BY r.result_item_id
        -- TOUS les ingrédients doivent avoir un prix de niveau 0
        HAVING COUNT(*) FILTER (WHERE ic0.effective_cost IS NULL) = 0
    ),
    
    -- Niveau 2: Items dont TOUS les ingrédients ont un coût (niveau 0 ou 1)
    item_cost_level_2 AS (
        SELECT 
            r.result_item_id AS item_id,
            SUM(ri.quantity * COALESCE(ic0.effective_cost, ic1.effective_cost)) AS effective_cost,
            TRUE AS is_estimated,
            FALSE AS is_incomplete  -- Par construction, tous les ingrédients ont un coût
        FROM recipes r
        JOIN recipe_ingredients ri ON r.id = ri.recipe_id
        LEFT JOIN item_cost_level_0 ic0 ON ri.item_id = ic0.item_id
        LEFT JOIN item_cost_level_1 ic1 ON ri.item_id = ic1.item_id
        WHERE NOT EXISTS (SELECT 1 FROM item_cost_level_0 ic WHERE ic.item_id = r.result_item_id)
          AND NOT EXISTS (SELECT 1 FROM item_cost_level_1 ic WHERE ic.item_id = r.result_item_id)
        GROUP BY r.result_item_id
        -- TOUS les ingrédients doivent avoir un coût (niveau 0 ou 1)
        HAVING COUNT(*) FILTER (WHERE ic0.effective_cost IS NULL AND ic1.effective_cost IS NULL) = 0
    ),
    
    -- Niveau 3: Items dont TOUS les ingrédients ont un coût (niveau 0, 1 ou 2)
    item_cost_level_3 AS (
        SELECT 
            r.result_item_id AS item_id,
            SUM(ri.quantity * COALESCE(ic0.effective_cost, ic1.effective_cost, ic2.effective_cost)) AS effective_cost,
            TRUE AS is_estimated,
            FALSE AS is_incomplete
        FROM recipes r
        JOIN recipe_ingredients ri ON r.id = ri.recipe_id
        LEFT JOIN item_cost_level_0 ic0 ON ri.item_id = ic0.item_id
        LEFT JOIN item_cost_level_1 ic1 ON ri.item_id = ic1.item_id
        LEFT JOIN item_cost_level_2 ic2 ON ri.item_id = ic2.item_id
        WHERE NOT EXISTS (SELECT 1 FROM item_cost_level_0 ic WHERE ic.item_id = r.result_item_id)
          AND NOT EXISTS (SELECT 1 FROM item_cost_level_1 ic WHERE ic.item_id = r.result_item_id)
          AND NOT EXISTS (SELECT 1 FROM item_cost_level_2 ic WHERE ic.item_id = r.result_item_id)
        GROUP BY r.result_item_id
        HAVING COUNT(*) FILTER (WHERE ic0.effective_cost IS NULL AND ic1.effective_cost IS NULL AND ic2.effective_cost IS NULL) = 0
    ),
    
    -- Niveau 4: Items dont TOUS les ingrédients ont un coût (niveaux 0-3)
    item_cost_level_4 AS (
        SELECT 
            r.result_item_id AS item_id,
            SUM(ri.quantity * COALESCE(ic0.effective_cost, ic1.effective_cost, ic2.effective_cost, ic3.effective_cost)) AS effective_cost,
            TRUE AS is_estimated,
            FALSE AS is_incomplete
        FROM recipes r
        JOIN recipe_ingredients ri ON r.id = ri.recipe_id
        LEFT JOIN item_cost_level_0 ic0 ON ri.item_id = ic0.item_id
        LEFT JOIN item_cost_level_1 ic1 ON ri.item_id = ic1.item_id
        LEFT JOIN item_cost_level_2 ic2 ON ri.item_id = ic2.item_id
        LEFT JOIN item_cost_level_3 ic3 ON ri.item_id = ic3.item_id
        WHERE NOT EXISTS (SELECT 1 FROM item_cost_level_0 ic WHERE ic.item_id = r.result_item_id)
          AND NOT EXISTS (SELECT 1 FROM item_cost_level_1 ic WHERE ic.item_id = r.result_item_id)
          AND NOT EXISTS (SELECT 1 FROM item_cost_level_2 ic WHERE ic.item_id = r.result_item_id)
          AND NOT EXISTS (SELECT 1 FROM item_cost_level_3 ic WHERE ic.item_id = r.result_item_id)
        GROUP BY r.result_item_id
        HAVING COUNT(*) FILTER (WHERE ic0.effective_cost IS NULL AND ic1.effective_cost IS NULL AND ic2.effective_cost IS NULL AND ic3.effective_cost IS NULL) = 0
    ),
    
    -- Niveau 5: Items dont TOUS les ingrédients ont un coût (niveaux 0-4)
    item_cost_level_5 AS (
        SELECT 
            r.result_item_id AS item_id,
            SUM(ri.quantity * COALESCE(ic0.effective_cost, ic1.effective_cost, ic2.effective_cost, ic3.effective_cost, ic4.effective_cost)) AS effective_cost,
            TRUE AS is_estimated,
            FALSE AS is_incomplete
        FROM recipes r
        JOIN recipe_ingredients ri ON r.id = ri.recipe_id
        LEFT JOIN item_cost_level_0 ic0 ON ri.item_id = ic0.item_id
        LEFT JOIN item_cost_level_1 ic1 ON ri.item_id = ic1.item_id
        LEFT JOIN item_cost_level_2 ic2 ON ri.item_id = ic2.item_id
        LEFT JOIN item_cost_level_3 ic3 ON ri.item_id = ic3.item_id
        LEFT JOIN item_cost_level_4 ic4 ON ri.item_id = ic4.item_id
        WHERE NOT EXISTS (SELECT 1 FROM item_cost_level_0 ic WHERE ic.item_id = r.result_item_id)
          AND NOT EXISTS (SELECT 1 FROM item_cost_level_1 ic WHERE ic.item_id = r.result_item_id)
          AND NOT EXISTS (SELECT 1 FROM item_cost_level_2 ic WHERE ic.item_id = r.result_item_id)
          AND NOT EXISTS (SELECT 1 FROM item_cost_level_3 ic WHERE ic.item_id = r.result_item_id)
          AND NOT EXISTS (SELECT 1 FROM item_cost_level_4 ic WHERE ic.item_id = r.result_item_id)
        GROUP BY r.result_item_id
        HAVING COUNT(*) FILTER (WHERE ic0.effective_cost IS NULL AND ic1.effective_cost IS NULL AND ic2.effective_cost IS NULL AND ic3.effective_cost IS NULL AND ic4.effective_cost IS NULL) = 0
    ),
    
    -- Niveau 6 (PARTIEL): Items avec au moins un ingrédient ayant un coût, mais pas tous
    -- Ce niveau capture les items qui ne peuvent pas être entièrement estimés même après 5 niveaux
    item_cost_level_partial AS (
        SELECT 
            r.result_item_id AS item_id,
            SUM(ri.quantity * COALESCE(ic0.effective_cost, ic1.effective_cost, ic2.effective_cost, ic3.effective_cost, ic4.effective_cost, ic5.effective_cost, 0)) AS effective_cost,
            TRUE AS is_estimated,
            TRUE AS is_incomplete  -- Marqué comme incomplet
        FROM recipes r
        JOIN recipe_ingredients ri ON r.id = ri.recipe_id
        LEFT JOIN item_cost_level_0 ic0 ON ri.item_id = ic0.item_id
        LEFT JOIN item_cost_level_1 ic1 ON ri.item_id = ic1.item_id
        LEFT JOIN item_cost_level_2 ic2 ON ri.item_id = ic2.item_id
        LEFT JOIN item_cost_level_3 ic3 ON ri.item_id = ic3.item_id
        LEFT JOIN item_cost_level_4 ic4 ON ri.item_id = ic4.item_id
        LEFT JOIN item_cost_level_5 ic5 ON ri.item_id = ic5.item_id
        WHERE NOT EXISTS (SELECT 1 FROM item_cost_level_0 ic WHERE ic.item_id = r.result_item_id)
          AND NOT EXISTS (SELECT 1 FROM item_cost_level_1 ic WHERE ic.item_id = r.result_item_id)
          AND NOT EXISTS (SELECT 1 FROM item_cost_level_2 ic WHERE ic.item_id = r.result_item_id)
          AND NOT EXISTS (SELECT 1 FROM item_cost_level_3 ic WHERE ic.item_id = r.result_item_id)
          AND NOT EXISTS (SELECT 1 FROM item_cost_level_4 ic WHERE ic.item_id = r.result_item_id)
          AND NOT EXISTS (SELECT 1 FROM item_cost_level_5 ic WHERE ic.item_id = r.result_item_id)
        GROUP BY r.result_item_id
        -- Au moins un ingrédient a un coût (sinon pas d'estimation du tout)
        HAVING SUM(COALESCE(ic0.effective_cost, ic1.effective_cost, ic2.effective_cost, ic3.effective_cost, ic4.effective_cost, ic5.effective_cost, 0)) > 0
    ),
    
    -- Consolider tous les coûts (priorité: prix marché > craft niveau 1 > ... > partiel)
    all_item_costs AS (
        SELECT item_id, effective_cost, is_estimated, is_incomplete FROM item_cost_level_0
        UNION ALL
        SELECT item_id, effective_cost, is_estimated, is_incomplete FROM item_cost_level_1
        UNION ALL
        SELECT item_id, effective_cost, is_estimated, is_incomplete FROM item_cost_level_2
        UNION ALL
        SELECT item_id, effective_cost, is_estimated, is_incomplete FROM item_cost_level_3
        UNION ALL
        SELECT item_id, effective_cost, is_estimated, is_incomplete FROM item_cost_level_4
        UNION ALL
        SELECT item_id, effective_cost, is_estimated, is_incomplete FROM item_cost_level_5
        UNION ALL
        SELECT item_id, effective_cost, is_estimated, is_incomplete FROM item_cost_level_partial
    ),
    
    -- Calcul des coûts de recette avec estimation en cascade
    recipe_costs AS (
        SELECT 
            ri.recipe_id,
            -- Coût normal (prix du marché, 0 si non disponible)
            SUM(ri.quantity * COALESCE(lp.price, 0)) AS total_cost,
            -- Coût estimé en cascade
            SUM(ri.quantity * COALESCE(aic.effective_cost, 0)) AS estimated_cost,
            COUNT(*) AS total_ingredients,
            COUNT(lp.price) FILTER (WHERE lp.price > 0) AS priced_ingredients,
            MIN(lp.captured_at) AS min_captured_at,
            -- Compte le nombre d'ingrédients estimés via sub-craft
            COUNT(*) FILTER (WHERE (lp.price IS NULL OR lp.price = 0) AND aic.effective_cost > 0) AS estimated_ingredients,
            -- Détecte si l'estimation est incomplète (certains ingrédients n'ont ni prix ni estimation)
            BOOL_OR(
                (lp.price IS NULL OR lp.price = 0) 
                AND (aic.effective_cost IS NULL OR aic.effective_cost = 0)
            ) AS has_incomplete,
            -- Détecte si un sous-craft était lui-même incomplet
            BOOL_OR(aic.is_incomplete) AS sub_incomplete
        FROM recipe_ingredients ri
        LEFT JOIN latest_prices lp ON ri.item_id = lp.item_id
        LEFT JOIN all_item_costs aic ON ri.item_id = aic.item_id
        GROUP BY ri.recipe_id
    )
    SELECT 
        r.id AS recipe_id,
        i.id AS result_item_id,
        i.name AS result_item_name,
        i.icon_url AS result_item_icon,
        j.id AS job_id,
        j.name AS job_name,
        j.icon_id AS job_icon_id,
        r.level,
        rc.total_cost AS craft_cost,
        COALESCE(lp.price, 0) AS sell_price,
        (COALESCE(lp.price, 0) - rc.total_cost) AS margin,
        CASE 
            WHEN rc.total_cost > 0 THEN ((COALESCE(lp.price, 0) - rc.total_cost) / rc.total_cost) * 100
            ELSE 0 
        END AS roi,
        rc.total_ingredients::INTEGER,
        rc.priced_ingredients::INTEGER,
        lp.captured_at AS result_item_last_update,
        rc.min_captured_at AS ingredients_last_update,
        i.craft_xp_ratio,
        -- Champs estimés
        rc.estimated_cost AS estimated_craft_cost,
        (COALESCE(lp.price, 0) - rc.estimated_cost) AS estimated_margin,
        CASE 
            WHEN rc.estimated_cost > 0 THEN ((COALESCE(lp.price, 0) - rc.estimated_cost) / rc.estimated_cost) * 100
            ELSE 0 
        END AS estimated_roi,
        (rc.estimated_ingredients > 0) AS has_estimation,
        (rc.has_incomplete OR rc.sub_incomplete) AS estimation_incomplete
    FROM recipes r
    JOIN items i ON r.result_item_id = i.id
    JOIN jobs j ON r.job_id = j.id
    JOIN recipe_costs rc ON r.id = rc.recipe_id
    LEFT JOIN latest_prices lp ON r.result_item_id = lp.item_id
    WHERE 
        r.level BETWEEN p_min_level AND p_max_level
        AND (p_job_id IS NULL OR r.job_id = p_job_id)
        AND (p_name_search IS NULL OR i.name ILIKE '%' || p_name_search || '%')
        AND (p_recipe_id IS NULL OR r.id = p_recipe_id)
        AND (p_result_item_id IS NULL OR r.result_item_id = p_result_item_id)
        AND (
            p_min_roi IS NULL 
            OR (
                rc.total_cost > 0 
                AND ((COALESCE(lp.price, 0) - rc.total_cost) / rc.total_cost) * 100 >= p_min_roi
            )
        )
    ORDER BY
        CASE WHEN p_sort_by = 'margin_desc' THEN (COALESCE(lp.price, 0) - rc.total_cost) END DESC,
        CASE WHEN p_sort_by = 'roi_desc' THEN 
            CASE WHEN rc.total_cost > 0 THEN ((COALESCE(lp.price, 0) - rc.total_cost) / rc.total_cost) * 100 ELSE 0 END 
        END DESC,
        CASE WHEN p_sort_by = 'level_desc' THEN r.level END DESC,
        CASE WHEN p_sort_by = 'cost_asc' THEN rc.total_cost END ASC,
        -- Tris pour les estimations
        CASE WHEN p_sort_by = 'estimated_margin_desc' THEN (COALESCE(lp.price, 0) - rc.estimated_cost) END DESC,
        CASE WHEN p_sort_by = 'estimated_roi_desc' THEN 
            CASE WHEN rc.estimated_cost > 0 THEN ((COALESCE(lp.price, 0) - rc.estimated_cost) / rc.estimated_cost) * 100 ELSE 0 END 
        END DESC,
        r.level DESC
    LIMIT p_limit OFFSET p_offset;
END;
$$;

-- Commentaire pour documentation
COMMENT ON FUNCTION get_recipes_with_stats(text,integer,integer,integer,numeric,integer,integer,text,text,integer,integer) IS 
'Calcule les statistiques de rentabilité des recettes avec support pour l''estimation EN CASCADE via sub-craft.
La fonction descend jusqu''à 5 niveaux de profondeur pour calculer le coût des ingrédients intermédiaires.
Exemple: Jus de poisson méphitique -> Jus de poisson pestilentiel -> Poisskaille Givré en Ragoût

Logique de calcul par niveaux:
- Niveau 0: Prix de marché direct
- Niveau 1-5: Items dont TOUS les ingrédients ont un coût connu (niveaux précédents)
- Niveau partiel: Items avec au moins un ingrédient estimable mais pas tous (is_incomplete=true)

Un item n''est inclus dans un niveau que si TOUS ses ingrédients ont un coût à ce niveau.
Cela garantit des estimations précises sans sous-estimer les coûts.

Champs d''estimation:
- estimated_craft_cost: coût avec estimation en cascade des ingrédients sans prix
- estimated_margin: marge calculée avec le coût estimé
- estimated_roi: ROI calculé avec le coût estimé
- has_estimation: true si au moins un ingrédient a été estimé via sub-craft
- estimation_incomplete: true si certains prix n''ont pas pu être estimés (profondeur > 5 ou pas de recette)';
