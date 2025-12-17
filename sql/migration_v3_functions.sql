-- MIGRATION V3 FUNCTIONS
-- Fonctions nécessaires pour l'ingestion et la gestion des items/catégories

-- Drop the ambiguous function signature if it exists (cleanup)
DROP FUNCTION IF EXISTS get_or_create_item_id(text, text);

-- Fonction RPC helper pour l'ingestion (Get or Create Item & Category)
-- Nouvelle logique (V4) : Source of Truth = DB
CREATE OR REPLACE FUNCTION get_or_create_item_id(p_name TEXT, p_ankama_id INTEGER DEFAULT NULL, p_category TEXT DEFAULT NULL)
RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE
  v_item_id INTEGER;
  v_category_id INTEGER;
  v_existing_ankama_id INTEGER;
  v_existing_category_id INTEGER;
BEGIN
  -- 1. Gestion de la catégorie (si fournie)
  -- On récupère l'ID de la catégorie entrante, ou on la crée
  IF p_category IS NOT NULL THEN
    SELECT id INTO v_category_id FROM categories WHERE name = p_category;
    IF v_category_id IS NULL THEN
      INSERT INTO categories (name) VALUES (p_category) RETURNING id INTO v_category_id;
    END IF;
  END IF;

  -- 2. Recherche de l'item
  v_item_id := NULL;

  -- A. Recherche par Ankama ID (Prioritaire)
  IF p_ankama_id IS NOT NULL THEN
    SELECT id, category_id INTO v_item_id, v_existing_category_id FROM items WHERE ankama_id = p_ankama_id;
  END IF;

  -- B. Fallback : Recherche par Nom (si pas trouvé par ID ou ID manquant)
  IF v_item_id IS NULL THEN
    SELECT id, ankama_id, category_id INTO v_item_id, v_existing_ankama_id, v_existing_category_id FROM items WHERE name = p_name;
    
    IF v_item_id IS NOT NULL THEN
        -- Vérification de conflit d'ID
        IF v_existing_ankama_id IS NOT NULL AND p_ankama_id IS NOT NULL AND v_existing_ankama_id != p_ankama_id THEN
            -- CONFLIT : Même nom, mais ID différent. Ce n'est pas le même item.
            -- On ne peut pas utiliser cet item existant.
            v_item_id := NULL; 
            -- On modifie le nom du nouvel item pour éviter la contrainte UNIQUE
            p_name := p_name || ' (' || p_ankama_id || ')';
        ELSE
            -- Pas de conflit (soit ID existant null, soit ID match, soit ID entrant null)
            -- Si ID existant est null et qu'on a un ID entrant, on met à jour l'item existant
            IF p_ankama_id IS NOT NULL AND v_existing_ankama_id IS NULL THEN
               UPDATE items SET ankama_id = p_ankama_id WHERE id = v_item_id;
            END IF;
        END IF;
    END IF;
  END IF;

  -- 3. Création ou Mise à jour mineure
  IF v_item_id IS NULL THEN
    -- CAS : Item inexistant -> Création
    INSERT INTO items (name, ankama_id, category_id) 
    VALUES (p_name, p_ankama_id, v_category_id) 
    RETURNING id INTO v_item_id;
  ELSE
    -- CAS : Item existant
    -- On ne touche PAS au nom ni à la catégorie s'ils sont déjà définis (Source of Truth = DB)
    
    -- Seule exception : Si la catégorie est manquante en base, on la remplit
    IF v_existing_category_id IS NULL AND v_category_id IS NOT NULL THEN
      UPDATE items SET category_id = v_category_id WHERE id = v_item_id;
    END IF;
  END IF;
  
  RETURN v_item_id;
END;
$$;

-- Fonction d'ingestion intelligente avec déduplication (15 min)
DROP FUNCTION IF EXISTS public.ingest_observation(text, integer, text, numeric, integer, timestamptz, text);

CREATE OR REPLACE FUNCTION ingest_observation(
  p_item_name TEXT,
  p_ankama_id INTEGER,
  p_server TEXT,
  p_price_unit_avg NUMERIC,
  p_nb_lots INTEGER,
  p_captured_at TIMESTAMPTZ,
  p_source_client TEXT,
  p_category TEXT DEFAULT NULL
)
RETURNS BIGINT
LANGUAGE plpgsql
AS $$
DECLARE
  v_item_id INTEGER;
  v_last_price NUMERIC;
  v_last_date TIMESTAMPTZ;
  v_obs_id BIGINT;
BEGIN
  -- 1. Récupérer ou créer l'item (via la fonction existante)
  v_item_id := get_or_create_item_id(p_item_name, p_ankama_id, p_category);

  -- 2. Vérifier la dernière observation pour cet item/serveur
  SELECT price_unit_avg, captured_at 
  INTO v_last_price, v_last_date
  FROM observations
  WHERE item_id = v_item_id AND server = p_server
  ORDER BY captured_at DESC
  LIMIT 1;

  -- 3. Logique de déduplication
  -- Si le prix est identique ET que l'écart de temps est < 15 minutes
  IF v_last_price IS NOT NULL 
     AND v_last_price = p_price_unit_avg 
     AND p_captured_at >= v_last_date
     AND (p_captured_at - v_last_date) < interval '15 minutes' THEN
     
     -- On retourne NULL pour signifier qu'on a rien fait (doublon ignoré)
     RETURN NULL;
  END IF;

  -- 4. Insertion
  INSERT INTO observations (item_id, server, price_unit_avg, nb_lots, captured_at, source_client)
  VALUES (v_item_id, p_server, p_price_unit_avg, p_nb_lots, p_captured_at, p_source_client)
  RETURNING id INTO v_obs_id;

  RETURN v_obs_id;
END;
$$;

-- Function to delete an item and all its related data
CREATE OR REPLACE FUNCTION delete_item_cascade(p_item_id INTEGER)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_item_name TEXT;
BEGIN
    -- Get item name for favorites deletion
    SELECT name INTO v_item_name FROM items WHERE id = p_item_id;

    IF v_item_name IS NOT NULL THEN
        -- Delete from profile_favorites
        DELETE FROM profile_favorites WHERE item_name = v_item_name;
    END IF;

    -- Delete from recipe_ingredients (where this item is an ingredient)
    DELETE FROM recipe_ingredients WHERE item_id = p_item_id;

    -- Delete from recipes (where this item is the result)
    -- Note: This will cascade to recipe_ingredients for this recipe because of ON DELETE CASCADE on recipe_ingredients.recipe_id
    DELETE FROM recipes WHERE result_item_id = p_item_id;

    -- Delete from observations
    DELETE FROM observations WHERE item_id = p_item_id;

    -- Delete from list_items (has cascade, but safe to include)
    DELETE FROM list_items WHERE item_id = p_item_id;

    -- Finally delete the item
    DELETE FROM items WHERE id = p_item_id;
END;
$$;

-- Function to get usage stats for an item before deletion
CREATE OR REPLACE FUNCTION get_item_usage_stats(p_item_id INTEGER)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_item_name TEXT;
    v_recipe_count INTEGER;
    v_ingredient_count INTEGER;
    v_list_count INTEGER;
    v_favorite_count INTEGER;
    v_observation_count INTEGER;
BEGIN
    SELECT name INTO v_item_name FROM items WHERE id = p_item_id;

    -- Count recipes where this item is the result
    SELECT COUNT(*) INTO v_recipe_count FROM recipes WHERE result_item_id = p_item_id;

    -- Count recipes where this item is an ingredient
    SELECT COUNT(*) INTO v_ingredient_count FROM recipe_ingredients WHERE item_id = p_item_id;

    -- Count lists containing this item
    SELECT COUNT(*) INTO v_list_count FROM list_items WHERE item_id = p_item_id;

    -- Count favorites (by name)
    IF v_item_name IS NOT NULL THEN
        SELECT COUNT(*) INTO v_favorite_count FROM profile_favorites WHERE item_name = v_item_name;
    ELSE
        v_favorite_count := 0;
    END IF;

    -- Count observations
    SELECT COUNT(*) INTO v_observation_count FROM observations WHERE item_id = p_item_id;

    RETURN json_build_object(
        'recipes_created', v_recipe_count,
        'recipes_used_in', v_ingredient_count,
        'lists', v_list_count,
        'favorites', v_favorite_count,
        'observations', v_observation_count
    );
END;
$$;
