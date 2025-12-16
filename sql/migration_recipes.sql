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
    is_locked BOOLEAN DEFAULT FALSE, -- Si verrouillé pour empêcher la mise à jour automatique
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(result_item_id)
);

-- Migration pour les tables existantes : ajout de la colonne is_locked si elle manque
ALTER TABLE recipes ADD COLUMN IF NOT EXISTS is_locked BOOLEAN DEFAULT FALSE;

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
DROP FUNCTION IF EXISTS get_recipes_with_stats(text,integer,integer,integer,numeric,integer,integer,text,text,integer,integer);

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
    ingredients_with_price INTEGER,
    result_item_last_update TIMESTAMPTZ,
    ingredients_last_update TIMESTAMPTZ
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
            price_unit_avg as price,
            captured_at
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
            COUNT(lp.price) AS priced_ingredients,
            MIN(lp.captured_at) AS min_captured_at
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
        rc.priced_ingredients::INTEGER,
        lp.captured_at AS result_item_last_update,
        rc.min_captured_at AS ingredients_last_update
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

-- 6. Function to get recipes using a specific item (Usages)
CREATE OR REPLACE FUNCTION get_item_usages(
    p_server TEXT,
    p_item_name TEXT,
    p_limit INTEGER DEFAULT 20,
    p_offset INTEGER DEFAULT 0,
    p_search TEXT DEFAULT NULL
)
RETURNS TABLE (
    recipe_id INTEGER,
    result_item_id INTEGER,
    result_item_name TEXT,
    result_item_icon TEXT,
    job_name TEXT,
    level INTEGER,
    quantity_required INTEGER,
    craft_cost NUMERIC,
    sell_price NUMERIC,
    margin NUMERIC,
    roi NUMERIC,
    total_count BIGINT
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    WITH target_item AS (
        SELECT id FROM items WHERE name = p_item_name LIMIT 1
    ),
    -- Get all recipes using this item, with optional search filter
    relevant_recipes AS (
        SELECT r.id, ri.quantity
        FROM recipe_ingredients ri
        JOIN target_item ti ON ri.item_id = ti.id
        JOIN recipes r ON ri.recipe_id = r.id
        JOIN items i ON r.result_item_id = i.id
        WHERE (p_search IS NULL OR i.name ILIKE '%' || p_search || '%')
    ),
    -- Calculate total count of matching recipes
    total_count_cte AS (
        SELECT COUNT(*) AS count FROM relevant_recipes
    ),
    -- Calculate costs for these recipes
    recipe_costs AS (
        SELECT 
            rr.id AS recipe_id,
            SUM(ri.quantity * COALESCE(obs.price_unit_avg, 0)) AS total_cost
        FROM relevant_recipes rr
        JOIN recipe_ingredients ri ON rr.id = ri.recipe_id
        LEFT JOIN LATERAL (
            SELECT price_unit_avg 
            FROM observations o 
            WHERE o.item_id = ri.item_id AND o.server = p_server
            ORDER BY o.captured_at DESC LIMIT 1
        ) obs ON TRUE
        GROUP BY rr.id
    )
    SELECT 
        r.id AS recipe_id,
        i.id AS result_item_id,
        i.name AS result_item_name,
        i.icon_url AS result_item_icon,
        j.name AS job_name,
        r.level,
        rr.quantity AS quantity_required,
        rc.total_cost AS craft_cost,
        COALESCE(lp.price_unit_avg, 0) AS sell_price,
        (COALESCE(lp.price_unit_avg, 0) - rc.total_cost) AS margin,
        CASE 
            WHEN rc.total_cost > 0 THEN ((COALESCE(lp.price_unit_avg, 0) - rc.total_cost) / rc.total_cost) * 100
            ELSE 0 
        END AS roi,
        (SELECT count FROM total_count_cte) AS total_count
    FROM relevant_recipes rr
    JOIN recipes r ON rr.id = r.id
    JOIN items i ON r.result_item_id = i.id
    JOIN jobs j ON r.job_id = j.id
    JOIN recipe_costs rc ON r.id = rc.recipe_id
    LEFT JOIN LATERAL (
        SELECT price_unit_avg 
        FROM observations o 
        WHERE o.item_id = r.result_item_id AND o.server = p_server
        ORDER BY o.captured_at DESC LIMIT 1
    ) lp ON TRUE
    ORDER BY margin DESC
    LIMIT p_limit
    OFFSET p_offset;
END;
$$;

-- 7. Function to update recipe ingredients (and lock the recipe)
CREATE OR REPLACE FUNCTION update_recipe_ingredients(
    p_recipe_id INTEGER,
    p_ingredients JSONB -- Array of {item_id: int, quantity: int}
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
    ing JSONB;
BEGIN
    -- 1. Lock the recipe
    UPDATE recipes 
    SET is_locked = TRUE, 
        updated_at = NOW() 
    WHERE id = p_recipe_id;

    -- 2. Remove old ingredients
    DELETE FROM recipe_ingredients WHERE recipe_id = p_recipe_id;

    -- 3. Insert new ingredients
    FOR ing IN SELECT * FROM jsonb_array_elements(p_ingredients)
    LOOP
        INSERT INTO recipe_ingredients (recipe_id, item_id, quantity)
        VALUES (p_recipe_id, (ing->>'item_id')::INTEGER, (ing->>'quantity')::INTEGER);
    END LOOP;
END;
$$;

-- 8. Function to create or update a custom recipe
CREATE OR REPLACE FUNCTION create_or_update_custom_recipe(
    p_result_item_id INTEGER,
    p_job_id INTEGER, -- Can be NULL
    p_level INTEGER, -- Can be NULL
    p_ingredients JSONB -- Array of {item_id: int, quantity: int}
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
    v_recipe_id INTEGER;
    ing JSONB;
BEGIN
    -- 1. Check if recipe exists
    SELECT id INTO v_recipe_id FROM recipes WHERE result_item_id = p_result_item_id;

    IF v_recipe_id IS NOT NULL THEN
        -- Update existing recipe
        UPDATE recipes 
        SET is_custom = TRUE,
            is_locked = TRUE,
            job_id = COALESCE(p_job_id, job_id),
            level = COALESCE(p_level, level),
            updated_at = NOW() 
        WHERE id = v_recipe_id;
        
        -- Remove old ingredients
        DELETE FROM recipe_ingredients WHERE recipe_id = v_recipe_id;
    ELSE
        -- Create new recipe
        INSERT INTO recipes (result_item_id, job_id, level, is_custom, is_locked)
        VALUES (p_result_item_id, p_job_id, p_level, TRUE, TRUE)
        RETURNING id INTO v_recipe_id;
    END IF;

    -- 2. Insert new ingredients
    FOR ing IN SELECT * FROM jsonb_array_elements(p_ingredients)
    LOOP
        INSERT INTO recipe_ingredients (recipe_id, item_id, quantity)
        VALUES (v_recipe_id, (ing->>'item_id')::INTEGER, (ing->>'quantity')::INTEGER);
    END LOOP;
END;
$$;
