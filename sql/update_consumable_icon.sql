-- Update icon for "Restore Health" (Consumables) to use the erosion icon
-- Effect ID 110: Rend #1 à #2 points de vie

INSERT INTO effect_icons (effect_id, icon_url) VALUES
(110, 'https://dofusdb.fr/icons/effects/erosion.png')
ON CONFLICT (effect_id) DO UPDATE SET icon_url = EXCLUDED.icon_url;
