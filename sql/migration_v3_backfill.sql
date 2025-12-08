-- MIGRATION V3 BACKFILL
-- Script de migration des données (A lancer en tâche de fond)

-- A. Peupler les items manquants depuis market_observations
INSERT INTO items (name)
SELECT DISTINCT item_name FROM market_observations
ON CONFLICT (name) DO NOTHING;

-- B. Migrer les observations (Par lots si la base est énorme)
-- Note: Cette requête peut être lourde. Sur une très grosse base, il faut le faire par batchs.
INSERT INTO observations (item_id, server, price_unit_avg, captured_at, nb_lots, source_client)
SELECT 
    i.id, 
    mo.server, 
    mo.price_unit_avg, 
    mo.captured_at, 
    mo.nb_lots, 
    mo.source_client
FROM market_observations mo
JOIN items i ON mo.item_name = i.name
-- Clause WHERE pour éviter les doublons si le Dual Write a déjà commencé
WHERE mo.captured_at < (SELECT MIN(captured_at) FROM observations); 

-- C. Migrer les "Known Items" (Items inconnus saisis manuellement)
-- On met à jour la table items avec les GID provenant de l'ancienne table known_items
-- ET on active le flag is_manually_added
UPDATE items i
SET 
    ankama_id = ki.gid,
    is_manually_added = TRUE
FROM known_items ki
WHERE i.name = ki.name;

-- On insère les items qui existent dans known_items mais pas encore dans items
INSERT INTO items (name, ankama_id, is_manually_added)
SELECT ki.name, ki.gid, TRUE
FROM known_items ki
LEFT JOIN items i ON ki.name = i.name
WHERE i.id IS NULL
ON CONFLICT (name) DO UPDATE SET 
    ankama_id = EXCLUDED.ankama_id,
    is_manually_added = TRUE;
