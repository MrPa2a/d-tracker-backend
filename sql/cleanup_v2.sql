-- CLEANUP V2
-- Ce script supprime les anciennes tables et fonctions de la V2
-- ATTENTION : Assurez-vous que la migration V3 est complète et que le backend n'utilise plus ces objets.

-- 1. Supprimer l'ancienne table market_observations
DROP TABLE IF EXISTS market_observations CASCADE;

-- 2. Supprimer l'ancienne table known_items (fusionnée dans items)
DROP TABLE IF EXISTS known_items CASCADE;

-- 3. Supprimer les anciennes fonctions RPC (V2 et V1)
-- Note: On liste ici les fonctions qui n'ont pas le suffixe _v3

-- V1 Functions
DROP FUNCTION IF EXISTS timeseries_daily(text, text, timestamptz, timestamptz);
DROP FUNCTION IF EXISTS get_movers(text, date, date, int, numeric, numeric);
DROP FUNCTION IF EXISTS get_volatility_rankings(text, date, date, int, text, numeric, numeric);
DROP FUNCTION IF EXISTS item_stats(text, text, date, date);
DROP FUNCTION IF EXISTS market_index(text, date, date);
DROP FUNCTION IF EXISTS investment_opportunities(text, date, date, int, numeric, numeric);
DROP FUNCTION IF EXISTS sell_opportunities(text, date, date, int, numeric, numeric);
DROP FUNCTION IF EXISTS items_with_latest_stats();
DROP FUNCTION IF EXISTS get_unique_servers();

-- Legacy aliases found in create_*.sql files
DROP FUNCTION IF EXISTS movers(text, timestamptz, timestamptz, integer, numeric, numeric);
DROP FUNCTION IF EXISTS volatility_rankings(text, date, date, int, text, numeric, numeric);

-- V2 Functions (Intermediate versions)
DROP FUNCTION IF EXISTS get_movers_v2(text, date, date, int, numeric, numeric, text[]);
DROP FUNCTION IF EXISTS get_volatility_rankings_v2(text, date, date, int, text, numeric, numeric, text[]);
DROP FUNCTION IF EXISTS investment_opportunities_v2(text, date, date, int, numeric, numeric, text[]);
DROP FUNCTION IF EXISTS sell_opportunities_v2(text, date, date, int, numeric, numeric, text[]);
DROP FUNCTION IF EXISTS market_index_v2(text, date, date, text[]);

-- 4. Nettoyage optionnel des index orphelins (si nécessaire)
-- (PostgreSQL gère généralement cela avec le DROP TABLE CASCADE)
