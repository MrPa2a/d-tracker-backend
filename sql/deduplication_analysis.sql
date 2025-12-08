-- ANALYSE DES DOUBLONS (OCR vs SNIFFING)

-- Ce script aide à identifier les items créés par l'OCR (souvent sans ankama_id ou avec des noms mal formattés)
-- qui ont un équivalent propre créé par le Sniffing (avec ankama_id).

-- Pré-requis : Avoir l'extension pg_trgm activée pour la similarité
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 1. Vue d'ensemble des candidats à la fusion
-- On cherche les items "suspects" (bad) et on essaie de trouver leur "jumeau officiel" (good)
SELECT 
    bad.id as bad_id,
    bad.name as bad_name,
    (SELECT COUNT(*) FROM observations WHERE item_id = bad.id) as bad_obs_count,
    good.id as good_id,
    good.name as good_name,
    good.ankama_id as good_ankama_id,
    similarity(bad.name, good.name) as sim_score
FROM 
    items bad
JOIN 
    items good ON bad.id != good.id
WHERE 
    -- Critère 1 : L'item "mauvais" n'a probablement pas d'ID Ankama (ou c'est l'ancien système)
    bad.ankama_id IS NULL 
    -- Critère 2 : L'item "bon" a un ID Ankama (issu du sniffing)
    AND good.ankama_id IS NOT NULL
    -- Critère 3 : Ils se ressemblent
    AND (
        -- Casse différente (ex: "Aile de dragodinde" vs "Aile de Dragodinde")
        LOWER(bad.name) = LOWER(good.name)
        -- Problème d'encodage ou tirets (ex: "Aigue—Marine" vs "Aigue-Marine")
        OR REPLACE(bad.name, '—', '-') = good.name
        -- Similarité textuelle forte (typos OCR)
        OR similarity(bad.name, good.name) > 0.8
    )
ORDER BY 
    sim_score DESC, bad_obs_count DESC;

-- 2. Script de correction (TEMPLATE - À NE PAS EXÉCUTER AVEUGLÉMENT)
-- Une fois les paires identifiées, vous pouvez utiliser une procédure pour fusionner.

/*
DO $$ 
DECLARE
    r RECORD;
    moved_obs_count INTEGER;
BEGIN
    -- Boucle sur les paires identifiées (reprendre la logique du SELECT ci-dessus)
    FOR r IN 
        SELECT bad.id as bad_id, good.id as good_id, bad.name as bad_name, good.name as good_name
        FROM items bad
        JOIN items good ON bad.id != good.id
        WHERE bad.ankama_id IS NULL 
          AND good.ankama_id IS NOT NULL
          AND (
              LOWER(bad.name) = LOWER(good.name) 
              OR REPLACE(bad.name, '—', '-') = good.name
              OR similarity(bad.name, good.name) > 0.9
          )
    LOOP
        -- 1. Déplacer les observations
        UPDATE observations 
        SET item_id = r.good_id 
        WHERE item_id = r.bad_id;
        
        GET DIAGNOSTICS moved_obs_count = ROW_COUNT;

        RAISE NOTICE 'Fusion : "%" (ID:%) -> "%" (ID:%) [% obs déplacées]', 
                     r.bad_name, r.bad_id, r.good_name, r.good_id, moved_obs_count;

        -- 2. Migrer les favoris
        -- Cas A : Le user a le mauvais favori MAIS PAS le bon -> On renomme
        UPDATE profile_favorites
        SET item_name = r.good_name
        WHERE item_name = r.bad_name
        AND NOT EXISTS (
            SELECT 1 FROM profile_favorites pf_check
            WHERE pf_check.profile_id = profile_favorites.profile_id
            AND pf_check.item_name = r.good_name
        );

        -- Cas B : Le user a le mauvais favori ET DEJA le bon (ou vient d'être migré) -> On supprime le mauvais s'il en reste
        DELETE FROM profile_favorites 
        WHERE item_name = r.bad_name;

        -- 3. Supprimer l'ancien item
        DELETE FROM items WHERE id = r.bad_id;
        
    END LOOP;
END $$;
*/
