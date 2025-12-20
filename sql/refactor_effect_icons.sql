-- Create table for effect icons
CREATE TABLE IF NOT EXISTS effect_icons (
    effect_id INTEGER PRIMARY KEY,
    icon_url TEXT NOT NULL
);

-- Insert known icons
INSERT INTO effect_icons (effect_id, icon_url) VALUES
(125, 'https://dofusdb.fr/icons/effects/pv.png'), -- Vitality
(110, 'https://dofusdb.fr/icons/effects/pv.png'), -- Life
(118, 'https://dofusdb.fr/icons/effects/terre.png'), -- Strength
(126, 'https://dofusdb.fr/icons/effects/feu.png'), -- Intelligence
(123, 'https://dofusdb.fr/icons/effects/eau.png'), -- Chance
(119, 'https://dofusdb.fr/icons/effects/air.png'), -- Agility
(124, 'https://dofusdb.fr/icons/effects/sagesse.png'), -- Wisdom
(111, 'https://dofusdb.fr/icons/effects/pa.png'), -- AP
(128, 'https://dofusdb.fr/icons/effects/pm.png'), -- MP
(117, 'https://dofusdb.fr/icons/effects/po.png'), -- Range
(115, 'https://dofusdb.fr/icons/effects/critique.png'), -- Critical Hit
(112, 'https://dofusdb.fr/icons/effects/dommages.png'), -- Damage
(138, 'https://dofusdb.fr/icons/effects/puissance.png'), -- Power
(174, 'https://dofusdb.fr/icons/effects/initiative.png'), -- Initiative
(178, 'https://dofusdb.fr/icons/effects/soin.png'), -- Heals
(210, 'https://dofusdb.fr/icons/effects/terre.png'), -- % Earth Res
(211, 'https://dofusdb.fr/icons/effects/eau.png'), -- % Water Res
(212, 'https://dofusdb.fr/icons/effects/air.png'), -- % Air Res
(213, 'https://dofusdb.fr/icons/effects/feu.png'), -- % Fire Res
(214, 'https://dofusdb.fr/icons/effects/neutre.png') -- % Neutral Res
ON CONFLICT (effect_id) DO UPDATE SET icon_url = EXCLUDED.icon_url;

-- Remove icon_url from item_effects as we now use the join/lookup
ALTER TABLE item_effects DROP COLUMN IF EXISTS icon_url;
