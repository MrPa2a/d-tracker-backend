-- Correction de l'inversion des noms pour les Runes Astrales
-- BUT : Échanger les noms associés aux IDs 21968 et 21969.
-- IMPORTANT : On ne touche PAS aux IDs (ankama_id) ni aux clés primaires (id).
-- L'historique des observations (lié à l'id de l'item) restera donc attaché au bon GID.

BEGIN;

-- État actuel supposé :
-- ankama_id=21968 a le nom 'Rune astrale merveilleuse' (FAUX)
-- ankama_id=21969 a le nom 'Rune astrale légendaire' (FAUX)

-- 1. On renomme temporairement l'item 21968 pour libérer le nom "Rune astrale merveilleuse"
-- Cela évite l'erreur de contrainte d'unicité sur le nom.
UPDATE public.items 
SET name = 'Rune astrale légendaire_TEMP' 
WHERE ankama_id = 21968;

-- 2. On donne le bon nom à l'item 21969
-- Il s'appelait "Rune astrale légendaire", il devient "Rune astrale merveilleuse"
UPDATE public.items 
SET name = 'Rune astrale merveilleuse' 
WHERE ankama_id = 21969;

-- 3. On donne le bon nom à l'item 21968 (qui est en TEMP)
-- Il devient "Rune astrale légendaire"
UPDATE public.items 
SET name = 'Rune astrale légendaire' 
WHERE name = 'Rune astrale légendaire_TEMP';

COMMIT;
