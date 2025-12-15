-- 1. Table des métiers (Référence statique)
CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY, -- On utilise l'ID Ankama directement (ex: 26 pour Alchimiste)
    name TEXT NOT NULL, -- Nom traduit (ex: "Alchimiste")
    icon_id INTEGER, -- Pour l'affichage de l'icône
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Table des recettes (Header)
CREATE TABLE IF NOT EXISTS recipes (
    id SERIAL PRIMARY KEY,
    result_item_id INTEGER NOT NULL REFERENCES items(id), -- L'objet créé.
    job_id INTEGER REFERENCES jobs(id), -- Lien vers le métier
    level INTEGER, -- Niveau du métier requis
    is_custom BOOLEAN DEFAULT FALSE, -- Si ajouté manuellement
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(result_item_id)
);

-- 3. Table des ingrédients (Lignes)
CREATE TABLE IF NOT EXISTS recipe_ingredients (
    recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
    item_id INTEGER NOT NULL REFERENCES items(id), -- L'ingrédient
    quantity INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (recipe_id, item_id)
);

-- Index pour les performances
CREATE INDEX IF NOT EXISTS idx_recipe_ingredients_item ON recipe_ingredients(item_id);

-- 4. Fonction pour calculer la rentabilité des recettes en temps réel
CREATE OR REPLACE FUNCTION get_recipes_with_stats(
    p_server TEXT,
    p_min_level INTEGER DEFAULT 0,
    p_max_level INTEGER DEFAULT 200,
    p_job_id INTEGER DEFAULT NULL,
    p_min_roi NUMERIC DEFAULT NULL,
    p_limit INTEGER DEFAULT 50,
    p_offset INTEGER DEFAULT 0,
    p_sort_by TEXT DEFAULT 'margin_desc', -- 'margin_desc', 'roi_desc', 'level_desc', 'cost_asc'
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
    ingredients_with_price INTEGER
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    WITH 
    -- 1. Latest prices for all items on the server
    -- Optimization: We could filter items here if we knew which ones are needed, but for a global view we need most of them.
    -- To optimize, we might want to materialize this or use a dedicated 'current_prices' table in the future.
    latest_prices AS (
        SELECT DISTINCT ON (item_id) 
            item_id, 
            price_unit_avg as price
        FROM observations
        WHERE server = p_server
        ORDER BY item_id, captured_at DESC
    ),
    -- 2. Calculate craft cost for each recipe
    recipe_costs AS (
        SELECT 
            ri.recipe_id,
            SUM(ri.quantity * COALESCE(lp.price, 0)) AS total_cost,
            COUNT(*) AS total_ingredients,
            COUNT(lp.price) AS priced_ingredients
        FROM recipe_ingredients ri
        LEFT JOIN latest_prices lp ON ri.item_id = lp.item_id
        GROUP BY ri.recipe_id
    )
    -- 3. Main Query
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
        rc.priced_ingredients::INTEGER
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
        -- Secondary sort
        r.level DESC
    LIMIT p_limit OFFSET p_offset;
END;
$$;

-- 5. Function to get ingredients for a recipe with their latest price on a specific server
DROP FUNCTION IF EXISTS get_recipe_ingredients(INTEGER, TEXT);

CREATE OR REPLACE FUNCTION get_recipe_ingredients(
    p_recipe_id INTEGER,
    p_server TEXT
)
RETURNS TABLE (
    item_id INTEGER,
    name TEXT,
    icon_url TEXT,
    quantity INTEGER,
    price NUMERIC,
    total_price NUMERIC,
    last_update TIMESTAMPTZ,
    ingredient_recipe_id INTEGER
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        i.id AS item_id,
        i.name,
        i.icon_url,
        ri.quantity,
        COALESCE(obs.price_unit_avg, 0) AS price,
        (ri.quantity * COALESCE(obs.price_unit_avg, 0)) AS total_price,
        obs.captured_at AS last_update,
        r_ing.id AS ingredient_recipe_id
    FROM recipe_ingredients ri
    JOIN items i ON ri.item_id = i.id
    LEFT JOIN recipes r_ing ON i.id = r_ing.result_item_id
    LEFT JOIN LATERAL (
        SELECT price_unit_avg, captured_at
        FROM observations o
        WHERE o.item_id = ri.item_id AND o.server = p_server
        ORDER BY o.captured_at DESC
        LIMIT 1
    ) obs ON TRUE
    WHERE ri.recipe_id = p_recipe_id;
END;
$$;
