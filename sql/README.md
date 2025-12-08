# SQL Scripts

This directory contains the SQL scripts for the Dofus Tracker database (Supabase/PostgreSQL).

## Current Schema (V3)

The database has been migrated to a normalized V3 schema.

### Active Files

- **`migration_v3_schema.sql`**: Defines the core tables (`items`, `observations`, `categories`) and indexes.
- **`migration_v3_rpc.sql`**: Defines the RPC functions used by the API (e.g., `timeseries_daily_v3`, `get_movers_v3`).
- **`migration_v3_functions.sql`**: Helper functions (e.g., `get_or_create_item_id`).
- **`create_profiles_tables.sql`**: Defines tables for user profiles and favorites.

### Maintenance

- **`cleanup_v2.sql`**: Script to remove obsolete V2 tables and functions. Run this after V3 is fully validated in production.
- **`migration_v3_backfill.sql`**: Script used to migrate data from V2 to V3.

## Archive

The `archive/` directory contains obsolete SQL scripts from V1 and V2 versions. These are kept for historical reference but should not be used.
