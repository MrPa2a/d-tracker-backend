-- MIGRATION V3 SCHEMA
-- A exécuter pour initialiser la nouvelle structure relationnelle

-- Enable pg_trgm extension for fuzzy search (Required for gin_trgm_ops)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 1. Table de référence des catégories
CREATE TABLE IF NOT EXISTS public.categories (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    slug TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Table de référence des items
CREATE TABLE IF NOT EXISTS public.items (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT, -- Pour URLs futures (ex: 'coiffe-bouftou')
    ankama_id INTEGER, -- ID officiel du jeu (GID)
    is_manually_added BOOLEAN DEFAULT FALSE, -- Flag pour identifier les items ajoutés via le fallback manuel
    category_id INTEGER REFERENCES public.categories(id), -- Lien vers la catégorie
    icon_url TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT items_name_key UNIQUE (name),
    CONSTRAINT items_slug_key UNIQUE (slug),
    CONSTRAINT items_ankama_id_key UNIQUE (ankama_id) -- Unicité du GID
);

CREATE INDEX IF NOT EXISTS idx_items_name_trgm ON public.items USING GIN (name gin_trgm_ops); -- Pour recherche floue rapide
CREATE INDEX IF NOT EXISTS idx_items_ankama_id ON public.items (ankama_id); -- Pour lookup rapide par GID
CREATE INDEX IF NOT EXISTS idx_items_category_id ON public.items (category_id); -- Pour filtrer par catégorie

-- 3. Table des observations normalisée
CREATE TABLE IF NOT EXISTS public.observations (
    id BIGSERIAL PRIMARY KEY,
    item_id INTEGER NOT NULL REFERENCES public.items(id),
    server TEXT NOT NULL,
    price_unit_avg NUMERIC NOT NULL,
    nb_lots INTEGER,
    captured_at TIMESTAMPTZ NOT NULL,
    source_client TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index performants sur des entiers
CREATE INDEX IF NOT EXISTS idx_observations_item_server_date ON public.observations (item_id, server, captured_at);
CREATE INDEX IF NOT EXISTS idx_observations_captured_at ON public.observations (captured_at);
