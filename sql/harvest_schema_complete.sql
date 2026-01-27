-- ============================================================================
-- Harvest Route Optimizer - Schema Complet (V2)
-- ============================================================================
-- 
-- Ce fichier regroupe :
--   1. Le schéma initial (tables de référence + routes utilisateur)
--   2. La table map_resources pour les quantités exactes par map
--
-- Usage: Exécuter dans Supabase SQL Editor
-- ============================================================================

-- ============================================================================
-- PARTIE 1: Reference Data (cached from DofusDB)
-- ============================================================================

CREATE TABLE IF NOT EXISTS harvest_jobs (
    id INTEGER PRIMARY KEY,
    name_fr TEXT NOT NULL,
    name_en TEXT,
    icon_id INTEGER,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS harvest_resources (
    id INTEGER PRIMARY KEY,           -- Item ID
    job_id INTEGER REFERENCES harvest_jobs(id),
    skill_id INTEGER NOT NULL,
    name_fr TEXT NOT NULL,
    name_en TEXT,
    level_min INTEGER NOT NULL,
    icon_url TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Areas (regions grouping subareas)
CREATE TABLE IF NOT EXISTS areas (
    id INTEGER PRIMARY KEY,
    name_fr TEXT NOT NULL,
    name_en TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS subareas (
    id INTEGER PRIMARY KEY,
    area_id INTEGER REFERENCES areas(id),
    name_fr TEXT NOT NULL,
    name_en TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Distribution of resources across subareas (OBSOLETE après V2, gardé pour référence)
CREATE TABLE IF NOT EXISTS resource_distribution (
    id BIGSERIAL PRIMARY KEY,
    resource_id INTEGER REFERENCES harvest_resources(id) ON DELETE CASCADE,
    subarea_id INTEGER NOT NULL,
    count INTEGER NOT NULL,
    UNIQUE(resource_id, subarea_id)
);

-- Map positions (only Monde des Douze - worldMap = 1)
CREATE TABLE IF NOT EXISTS map_positions (
    map_id BIGINT PRIMARY KEY,
    pos_x INTEGER NOT NULL,
    pos_y INTEGER NOT NULL,
    subarea_id INTEGER REFERENCES subareas(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================================
-- PARTIE 2: Quantités exactes par map (V2 - source: /recoltables2)
-- ============================================================================

CREATE TABLE IF NOT EXISTS map_resources (
    map_id BIGINT NOT NULL REFERENCES map_positions(map_id) ON DELETE CASCADE,
    resource_id INTEGER NOT NULL REFERENCES harvest_resources(id) ON DELETE CASCADE,
    quantity SMALLINT NOT NULL DEFAULT 1,
    PRIMARY KEY (map_id, resource_id)
);

COMMENT ON TABLE map_resources IS 'Quantités exactes de ressources par map (source: /recoltables2)';
COMMENT ON COLUMN map_resources.quantity IS 'Nombre d''occurrences de cette ressource sur la map';

-- ============================================================================
-- PARTIE 3: Indexes pour performance
-- ============================================================================

-- Resource distribution (obsolète mais gardé)
CREATE INDEX IF NOT EXISTS idx_resource_distribution_resource
    ON resource_distribution(resource_id);

CREATE INDEX IF NOT EXISTS idx_resource_distribution_subarea
    ON resource_distribution(subarea_id);

-- Map positions
CREATE INDEX IF NOT EXISTS idx_map_positions_subarea
    ON map_positions(subarea_id);

CREATE INDEX IF NOT EXISTS idx_map_positions_coords
    ON map_positions(pos_x, pos_y);

-- Subareas
CREATE INDEX IF NOT EXISTS idx_subareas_area
    ON subareas(area_id);

-- Map resources (V2)
CREATE INDEX IF NOT EXISTS idx_map_resources_resource_id 
    ON map_resources(resource_id);

CREATE INDEX IF NOT EXISTS idx_map_resources_map_id 
    ON map_resources(map_id);

-- ============================================================================
-- PARTIE 4: User Routes
-- ============================================================================

CREATE TABLE IF NOT EXISTS harvest_routes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    target_job_ids INTEGER[] NOT NULL,
    target_resource_ids INTEGER[] NOT NULL,
    route_data JSONB NOT NULL,
    is_public BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_harvest_routes_user
    ON harvest_routes(user_id);

CREATE INDEX IF NOT EXISTS idx_harvest_routes_public
    ON harvest_routes(is_public) WHERE is_public = TRUE;

CREATE INDEX IF NOT EXISTS idx_harvest_routes_jobs
    ON harvest_routes USING GIN(target_job_ids);

-- ============================================================================
-- FIN - Toutes les tables sont créées
-- Prochaine étape: exécuter scripts/ingest_harvest_data_v2.ts
-- ============================================================================
