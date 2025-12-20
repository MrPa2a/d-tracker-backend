-- Fix missing descriptions for Unity/New effects

-- 2800: Dommages mêlée
UPDATE item_effects
SET formatted_description = 
    CASE 
        WHEN min_value = max_value THEN REPLACE('#1% Dommages mêlée', '#1', min_value::text)
        ELSE REPLACE(REPLACE('#1% à #2% Dommages mêlée', '#1', min_value::text), '#2', max_value::text)
    END
WHERE effect_id = 2800;

-- 2801: Dommages mêlée (Negative)
UPDATE item_effects
SET formatted_description = 
    CASE 
        WHEN min_value = max_value THEN REPLACE('#1% Dommages mêlée', '#1', min_value::text)
        ELSE REPLACE(REPLACE('#1% à #2% Dommages mêlée', '#1', min_value::text), '#2', max_value::text)
    END
WHERE effect_id = 2801;

-- 2802: Résistance mêlée (Negative)
UPDATE item_effects
SET formatted_description = 
    CASE 
        WHEN min_value = max_value THEN REPLACE('#1% Résistance mêlée', '#1', min_value::text)
        ELSE REPLACE(REPLACE('#1% à #2% Résistance mêlée', '#1', min_value::text), '#2', max_value::text)
    END
WHERE effect_id = 2802;

-- 2803: Résistance mêlée
UPDATE item_effects
SET formatted_description = 
    CASE 
        WHEN min_value = max_value THEN REPLACE('#1% Résistance mêlée', '#1', min_value::text)
        ELSE REPLACE(REPLACE('#1% à #2% Résistance mêlée', '#1', min_value::text), '#2', max_value::text)
    END
WHERE effect_id = 2803;

-- 2804: Dommages distance
UPDATE item_effects
SET formatted_description = 
    CASE 
        WHEN min_value = max_value THEN REPLACE('#1% Dommages distance', '#1', min_value::text)
        ELSE REPLACE(REPLACE('#1% à #2% Dommages distance', '#1', min_value::text), '#2', max_value::text)
    END
WHERE effect_id = 2804;

-- 2805: Dommages distance (Negative)
UPDATE item_effects
SET formatted_description = 
    CASE 
        WHEN min_value = max_value THEN REPLACE('#1% Dommages distance', '#1', min_value::text)
        ELSE REPLACE(REPLACE('#1% à #2% Dommages distance', '#1', min_value::text), '#2', max_value::text)
    END
WHERE effect_id = 2805;

-- 2806: Résistance distance (Negative)
UPDATE item_effects
SET formatted_description = 
    CASE 
        WHEN min_value = max_value THEN REPLACE('#1% Résistance distance', '#1', min_value::text)
        ELSE REPLACE(REPLACE('#1% à #2% Résistance distance', '#1', min_value::text), '#2', max_value::text)
    END
WHERE effect_id = 2806;

-- 2807: Résistance distance
UPDATE item_effects
SET formatted_description = 
    CASE 
        WHEN min_value = max_value THEN REPLACE('#1% Résistance distance', '#1', min_value::text)
        ELSE REPLACE(REPLACE('#1% à #2% Résistance distance', '#1', min_value::text), '#2', max_value::text)
    END
WHERE effect_id = 2807;

-- 2808: Dommages d'armes
UPDATE item_effects
SET formatted_description = 
    CASE 
        WHEN min_value = max_value THEN REPLACE('#1% Dommages d''armes', '#1', min_value::text)
        ELSE REPLACE(REPLACE('#1% à #2% Dommages d''armes', '#1', min_value::text), '#2', max_value::text)
    END
WHERE effect_id = 2808;

-- 2809: Dommages d'armes (Negative)
UPDATE item_effects
SET formatted_description = 
    CASE 
        WHEN min_value = max_value THEN REPLACE('#1% Dommages d''armes', '#1', min_value::text)
        ELSE REPLACE(REPLACE('#1% à #2% Dommages d''armes', '#1', min_value::text), '#2', max_value::text)
    END
WHERE effect_id = 2809;

-- 2812: Dommages aux sorts
UPDATE item_effects
SET formatted_description = 
    CASE 
        WHEN min_value = max_value THEN REPLACE('#1% Dommages aux sorts', '#1', min_value::text)
        ELSE REPLACE(REPLACE('#1% à #2% Dommages aux sorts', '#1', min_value::text), '#2', max_value::text)
    END
WHERE effect_id = 2812;

-- 2813: Dommages aux sorts (Negative)
UPDATE item_effects
SET formatted_description = 
    CASE 
        WHEN min_value = max_value THEN REPLACE('#1% Dommages aux sorts', '#1', min_value::text)
        ELSE REPLACE(REPLACE('#1% à #2% Dommages aux sorts', '#1', min_value::text), '#2', max_value::text)
    END
WHERE effect_id = 2813;
