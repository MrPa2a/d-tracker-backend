-- Migration: Ajout de la colonne craft_xp_ratio à la table recipes
-- Date: Janvier 2026
-- Description: Stocke le ratio d'XP de craft pour chaque recette (source: DofusDB)
--
-- Valeurs possibles:
--   > 0  : Ratio spécifique (ex: 100 = standard, 300 = trophées, 30 = alliages)
--   -1   : Pas de ratio défini, le code utilisera le fallback (100)

ALTER TABLE recipes ADD COLUMN IF NOT EXISTS craft_xp_ratio INTEGER DEFAULT -1;

-- Index optionnel pour filtrer les recettes par ratio (si besoin d'optimisation)
-- CREATE INDEX idx_recipes_craft_xp_ratio ON recipes(craft_xp_ratio);

COMMENT ON COLUMN recipes.craft_xp_ratio IS 'Ratio XP de craft depuis DofusDB. -1 = non défini (fallback 100). Formule: coeff = 20 * (ratio/100)';
