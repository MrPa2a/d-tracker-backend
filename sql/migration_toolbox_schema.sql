-- MIGRATION TOOLBOX SCHEMA
-- Création de la table pour stocker les effets théoriques des items (Stats)

CREATE TABLE IF NOT EXISTS public.item_effects (
    id BIGSERIAL PRIMARY KEY,
    item_id INTEGER NOT NULL REFERENCES public.items(id) ON DELETE CASCADE,
    effect_id INTEGER NOT NULL, -- ID de l'effet (ex: 110 pour Vie, 118 pour Force)
    min_value INTEGER NOT NULL, -- Valeur min (ou valeur fixe pour consommables)
    max_value INTEGER NOT NULL, -- Valeur max (si jet variable)
    formatted_description TEXT, -- Texte pré-formaté (ex: "Rend 50 à 100 PV")
    order_index INTEGER DEFAULT 0, -- Pour conserver l'ordre d'affichage des lignes
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index pour les recherches rapides
CREATE INDEX IF NOT EXISTS idx_item_effects_item_id ON public.item_effects(item_id);
CREATE INDEX IF NOT EXISTS idx_item_effects_effect_id ON public.item_effects(effect_id);

-- Commentaires pour la documentation
COMMENT ON TABLE public.item_effects IS 'Stocke les plages de statistiques théoriques des objets (Reference Data)';
COMMENT ON COLUMN public.item_effects.min_value IS 'Valeur minimale théorique du jet';
COMMENT ON COLUMN public.item_effects.max_value IS 'Valeur maximale théorique du jet. Égale à min_value si jet fixe.';
