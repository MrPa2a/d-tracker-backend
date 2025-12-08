-- MIGRATION V3 FUNCTIONS
-- Fonctions nécessaires pour l'ingestion et la gestion des items/catégories

-- Fonction RPC helper pour l'ingestion (Get or Create Item & Category)
CREATE OR REPLACE FUNCTION get_or_create_item_id(p_name TEXT, p_category TEXT DEFAULT NULL)
RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE
  v_item_id INTEGER;
  v_category_id INTEGER;
BEGIN
  -- 1. Gestion de la catégorie (si fournie)
  IF p_category IS NOT NULL THEN
    SELECT id INTO v_category_id FROM categories WHERE name = p_category;
    IF v_category_id IS NULL THEN
      INSERT INTO categories (name) VALUES (p_category) RETURNING id INTO v_category_id;
    END IF;
  END IF;

  -- 2. Gestion de l'item
  SELECT id INTO v_item_id FROM items WHERE name = p_name;
  
  IF v_item_id IS NULL THEN
    -- Création
    INSERT INTO items (name, category_id) VALUES (p_name, v_category_id) RETURNING id INTO v_item_id;
  ELSE
    -- Mise à jour de la catégorie si elle était manquante et qu'on vient de la recevoir
    IF v_category_id IS NOT NULL AND (SELECT category_id FROM items WHERE id = v_item_id) IS NULL THEN
      UPDATE items SET category_id = v_category_id WHERE id = v_item_id;
    END IF;
  END IF;
  
  RETURN v_item_id;
END;
$$;
