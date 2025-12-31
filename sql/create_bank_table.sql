-- =====================================================
-- MIGRATION: Création de la table bank_items
-- Feature: Suivi du contenu de la banque des joueurs
-- Date: Janvier 2025
-- =====================================================

-- Table pour stocker le contenu actuel de la banque de chaque profil/serveur
CREATE TABLE IF NOT EXISTS bank_items (
    id BIGSERIAL PRIMARY KEY,
    
    -- Identification
    profile_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
    server VARCHAR(50) NOT NULL,  -- Serveur de jeu (ex: "Echo")
    
    -- Données de l'item
    item_id INTEGER NOT NULL REFERENCES items(id),  -- FK vers items (resolved from GID)
    ankama_id INTEGER NOT NULL,  -- GID direct pour backup/debug
    quantity INTEGER NOT NULL DEFAULT 1,
    
    -- Métadonnées
    captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index pour recherche rapide par serveur (mode anonyme)
CREATE INDEX IF NOT EXISTS idx_bank_items_server ON bank_items(server);

-- Index pour recherche par profil
CREATE INDEX IF NOT EXISTS idx_bank_items_profile_id ON bank_items(profile_id);

-- Index pour recherche par item
CREATE INDEX IF NOT EXISTS idx_bank_items_item_id ON bank_items(item_id);

-- Contrainte d'unicité : un seul enregistrement par (serveur, profil, item)
-- Note: profile_id peut être NULL pour mode anonyme
CREATE UNIQUE INDEX IF NOT EXISTS idx_bank_items_unique 
    ON bank_items(server, COALESCE(profile_id, '00000000-0000-0000-0000-000000000000'::uuid), item_id);

-- Enable RLS
ALTER TABLE bank_items ENABLE ROW LEVEL SECURITY;

-- Policies (accès public pour l'instant, à restreindre plus tard)
DROP POLICY IF EXISTS "Allow public read access on bank_items" ON bank_items;
CREATE POLICY "Allow public read access on bank_items" ON bank_items FOR SELECT USING (true);

DROP POLICY IF EXISTS "Allow public insert access on bank_items" ON bank_items;
CREATE POLICY "Allow public insert access on bank_items" ON bank_items FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "Allow public update access on bank_items" ON bank_items;
CREATE POLICY "Allow public update access on bank_items" ON bank_items FOR UPDATE USING (true);

DROP POLICY IF EXISTS "Allow public delete access on bank_items" ON bank_items;
CREATE POLICY "Allow public delete access on bank_items" ON bank_items FOR DELETE USING (true);

-- Function pour mettre à jour updated_at
CREATE OR REPLACE FUNCTION update_bank_items_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger pour updated_at
DROP TRIGGER IF EXISTS trigger_bank_items_updated_at ON bank_items;
CREATE TRIGGER trigger_bank_items_updated_at
    BEFORE UPDATE ON bank_items
    FOR EACH ROW
    EXECUTE FUNCTION update_bank_items_updated_at();

-- =====================================================
-- Fonction RPC pour synchroniser le contenu de la banque
-- =====================================================
CREATE OR REPLACE FUNCTION sync_bank_content(
    p_server VARCHAR(50),
    p_profile_id UUID,  -- Peut être NULL pour mode anonyme
    p_items JSONB,      -- Array de {gid: int, quantity: int}
    p_captured_at TIMESTAMPTZ DEFAULT NOW()
)
RETURNS TABLE (
    inserted INTEGER,
    updated INTEGER,
    deleted INTEGER,
    unknown_gids INTEGER[]
)
LANGUAGE plpgsql
AS $$
DECLARE
    v_inserted INTEGER := 0;
    v_updated INTEGER := 0;
    v_deleted INTEGER := 0;
    v_unknown_gids INTEGER[] := '{}';
    v_item RECORD;
    v_item_id INTEGER;
    v_existing_quantity INTEGER;
    v_processed_item_ids INTEGER[] := '{}';
BEGIN
    -- 1. Pour chaque item dans le payload
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
    LOOP
        -- Récupérer l'item_id depuis le GID (ankama_id)
        SELECT id INTO v_item_id 
        FROM items 
        WHERE ankama_id = (v_item.value->>'gid')::INTEGER;
        
        -- Si l'item n'existe pas en base, on le note
        IF v_item_id IS NULL THEN
            v_unknown_gids := array_append(v_unknown_gids, (v_item.value->>'gid')::INTEGER);
            CONTINUE;
        END IF;
        
        -- Tracker les items traités
        v_processed_item_ids := array_append(v_processed_item_ids, v_item_id);
        
        -- Vérifier si l'item existe déjà dans la banque
        SELECT quantity INTO v_existing_quantity 
        FROM bank_items 
        WHERE server = p_server 
          AND COALESCE(profile_id, '00000000-0000-0000-0000-000000000000'::uuid) = 
              COALESCE(p_profile_id, '00000000-0000-0000-0000-000000000000'::uuid)
          AND item_id = v_item_id;
        
        IF v_existing_quantity IS NULL THEN
            -- INSERT
            INSERT INTO bank_items (server, profile_id, item_id, ankama_id, quantity, captured_at)
            VALUES (p_server, p_profile_id, v_item_id, (v_item.value->>'gid')::INTEGER, 
                    (v_item.value->>'quantity')::INTEGER, p_captured_at);
            v_inserted := v_inserted + 1;
        ELSE
            -- UPDATE si quantité différente
            IF v_existing_quantity != (v_item.value->>'quantity')::INTEGER THEN
                UPDATE bank_items 
                SET quantity = (v_item.value->>'quantity')::INTEGER, 
                    captured_at = p_captured_at
                WHERE server = p_server 
                  AND COALESCE(profile_id, '00000000-0000-0000-0000-000000000000'::uuid) = 
                      COALESCE(p_profile_id, '00000000-0000-0000-0000-000000000000'::uuid)
                  AND item_id = v_item_id;
                v_updated := v_updated + 1;
            END IF;
        END IF;
    END LOOP;
    
    -- 2. Supprimer les items qui ne sont plus dans la banque
    DELETE FROM bank_items bi
    WHERE bi.server = p_server 
      AND COALESCE(bi.profile_id, '00000000-0000-0000-0000-000000000000'::uuid) = 
          COALESCE(p_profile_id, '00000000-0000-0000-0000-000000000000'::uuid)
      AND bi.item_id != ALL(v_processed_item_ids);
    
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    
    RETURN QUERY SELECT v_inserted, v_updated, v_deleted, v_unknown_gids;
END;
$$;

-- =====================================================
-- Vue pour afficher le contenu de la banque avec infos items
-- =====================================================
CREATE OR REPLACE VIEW bank_items_view AS
SELECT 
    bi.id,
    bi.server,
    bi.profile_id,
    bi.item_id,
    bi.ankama_id as gid,
    bi.quantity,
    bi.captured_at,
    i.name as item_name,
    i.icon_url,
    i.level as item_level,
    i.category_id,
    -- Dernière observation de prix pour cet item/serveur
    (
        SELECT o.price_unit_avg 
        FROM observations o 
        WHERE o.item_id = bi.item_id 
          AND o.server = bi.server 
        ORDER BY o.captured_at DESC 
        LIMIT 1
    ) as last_price
FROM bank_items bi
JOIN items i ON i.id = bi.item_id;

COMMENT ON TABLE bank_items IS 'Contenu actuel de la banque des joueurs, synchronisé via le sniffer (paquet hzm)';
COMMENT ON FUNCTION sync_bank_content IS 'Synchronise le contenu de la banque: upsert les items, supprime ceux qui ne sont plus présents';
