# 🛠️ Dofus Tracker Backend

> A serverless REST API for market data ingestion and advanced analytics, deployed on **Vercel** and powered by **Supabase (PostgreSQL)**. Features complex SQL analytics, schema migrations, and real-time data processing.

![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?style=flat-square&logo=typescript)
![Vercel](https://img.shields.io/badge/Vercel-Serverless-000000?style=flat-square&logo=vercel)
![Supabase](https://img.shields.io/badge/Supabase-PostgreSQL-3FCF8E?style=flat-square&logo=supabase)
![Zod](https://img.shields.io/badge/Zod-Validation-3E67B1?style=flat-square)

---

## 🎯 Project Overview

**Dofus Tracker Backend** is a serverless API that handles data ingestion from Python clients and exposes advanced market analytics through optimized SQL RPC functions. It processes thousands of price observations daily and provides real-time insights.

This project demonstrates proficiency in:
- **Serverless architecture** with Vercel Edge Functions
- **Database design** with normalized PostgreSQL schemas
- **Advanced SQL** (CTEs, window functions, aggregations, RPC functions)
- **API security** with Bearer token authentication
- **Schema migrations** for iterative database evolution
- **Input validation** with Zod for type-safe request handling
- **TypeScript** for end-to-end type safety

---

## ✨ Key Features

### 📥 Data Ingestion API
- Secure endpoints with Bearer token authentication
- Request validation with Zod schemas
- Batch insert support for high-throughput ingestion
- Automatic item creation on first observation (upsert pattern)
- Duplicate detection to prevent redundant data

### 📊 Market Analytics Engine
Advanced SQL RPC functions for real-time market intelligence:

| Function | Description |
|----------|-------------|
| `market_index_v3` | Weighted average price change across all tracked items |
| `get_movers_v3` | Top gainers/losers with configurable sorting (asc/desc/abs) |
| `get_volatility_rankings_v3` | Items ranked by price volatility (std deviation) |
| `get_opportunities_v3` | Buy signals based on moving average discount |
| `get_sell_opportunities_v3` | Sell signals when prices exceed historical average |
| `market_scanner_v3` | Multi-criteria opportunity scanner with filters |
| `market_trends_v1` | Bullish/bearish trend detection |
| `timeseries_daily_v3` | Daily price aggregation for charts |

### 🏦 Bank & Crafting Features
- Personal inventory tracking per user profile
- **Craft opportunity detection** — finds profitable recipes based on bank contents
- Ingredient stock matching with recipe requirements

### 👤 Profile Management
- Multi-profile support for different game accounts
- Favorite items tracking
- Custom watchlists

### 📋 Resource Handlers
Modular handler architecture for clean separation of concerns:
- `items` — Item definitions and search
- `categories` — Category management
- `recipes` — Crafting recipes with profitability calculations
- `bank` — User inventory and craft opportunities
- `timeseries` — Historical price data
- `analysis` — Scanner and trend analysis

---

## 🏗️ Architecture & Technical Highlights

### Project Structure
```
dofus-tracker-backend/
├── api/                    # Vercel Serverless Functions (endpoints)
│   ├── ingest.ts           # Data ingestion (POST /api/ingest)
│   ├── data.ts             # Resource router (items, categories, recipes...)
│   ├── market_v2.ts        # Market analytics router
│   ├── user.ts             # User-specific endpoints (profiles, favorites)
│   └── cron/
│       └── almanax.ts      # Scheduled job (daily)
├── utils/
│   ├── cors.ts             # CORS configuration
│   └── handlers/           # Business logic handlers
│       ├── items.ts        # Item CRUD operations
│       ├── market.ts       # Market analytics (movers, volatility, etc.)
│       ├── analysis.ts     # Scanner & trends
│       ├── bank.ts         # Bank & craft opportunities
│       ├── recipes.ts      # Recipe profitability
│       ├── timeseries.ts   # Historical data
│       └── ...
├── sql/                    # Database migrations & functions
│   ├── migration_v3_schema.sql   # Core table definitions
│   ├── migration_v3_rpc.sql      # RPC analytics functions
│   ├── migration_v3_functions.sql # Utility functions
│   ├── migration_recipes.sql     # Crafting system
│   ├── migration_scanner.sql     # Opportunity scanner
│   └── ...
└── scripts/
    └── sync_xp_ratios.ts   # XP ratio synchronization script
```

### Database Schema (V3 Normalized)

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────┐
│  categories │     │      items       │     │ observations│
├─────────────┤     ├──────────────────┤     ├─────────────┤
│ id (PK)     │◄────│ category_id (FK) │     │ id (PK)     │
│ name        │     │ id (PK)          │◄────│ item_id(FK) │
│ slug        │     │ name (UNIQUE)    │     │ server      │
└─────────────┘     │ ankama_id        │     │ price_avg   │
                    │ icon_url         │     │ captured_at │
                    │ level            │     └─────────────┘
                    └──────────────────┘
                             │
          ┌──────────────────┴──────────────────┐
          ▼                                      ▼
┌──────────────────┐                  ┌──────────────────┐
│     recipes      │                  │   bank_items     │
├──────────────────┤                  ├──────────────────┤
│ id (PK)          │                  │ profile_id (FK)  │
│ result_item_id   │                  │ item_id (FK)     │
│ job_id           │                  │ server           │
│ level            │                  │ quantity         │
└──────────────────┘                  └──────────────────┘
```

### Key Technical Decisions

| Aspect | Choice | Rationale |
|--------|--------|-----------|
| **Deployment** | Vercel Serverless | Zero-config, auto-scaling, edge network |
| **Database** | Supabase (PostgreSQL) | Managed Postgres, built-in RPC, Row Level Security |
| **Validation** | Zod | Runtime type checking, TypeScript inference |
| **Analytics** | SQL RPC Functions | Complex calculations pushed to database for performance |
| **Auth** | Bearer Token | Simple, effective for M2M communication |
| **Schema** | Normalized V3 | Eliminated data redundancy, improved query performance |

### SQL Analytics Example

```sql
-- Market Scanner: Find profitable opportunities
CREATE FUNCTION market_scanner_v3(
  p_server TEXT,
  p_min_profit NUMERIC,
  p_min_margin NUMERIC,
  p_freshness_hours INT
) RETURNS TABLE (...)
AS $$
  WITH recent_prices AS (
    SELECT item_id, AVG(price_unit_avg) as current_price
    FROM observations
    WHERE captured_at > NOW() - (p_freshness_hours || ' hours')::interval
    GROUP BY item_id
  ),
  historical AS (
    SELECT item_id, AVG(price_unit_avg) as avg_30d
    FROM observations
    WHERE captured_at > NOW() - interval '30 days'
    GROUP BY item_id
  )
  SELECT 
    i.name,
    r.current_price,
    h.avg_30d,
    (h.avg_30d - r.current_price) as potential_profit,
    ((h.avg_30d - r.current_price) / r.current_price * 100) as margin_pct
  FROM recent_prices r
  JOIN historical h USING (item_id)
  JOIN items i ON r.item_id = i.id
  WHERE (h.avg_30d - r.current_price) >= p_min_profit
    AND ((h.avg_30d - r.current_price) / r.current_price * 100) >= p_min_margin
$$;
```

---

## 🚀 Getting Started

### Prerequisites
- Node.js 18+
- Vercel CLI (for local development)
- Supabase account

### Installation

```bash
# Clone the repository
git clone https://github.com/your-username/dofus-tracker.git
cd dofus-tracker/dofus-tracker-backend

# Install dependencies
npm install

# Configure environment
cp .env.example .env.local
# Edit .env.local with your credentials
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key (server-side only) |
| `INGEST_API_TOKEN` | Bearer token for client authentication |

### Local Development

```bash
# Run with Vercel CLI
npm run local
# or
npx vercel dev
```

### Database Setup

Apply migrations in order:

```bash
# Connect to Supabase SQL Editor and run:
1. sql/migration_v3_schema.sql    # Core tables
2. sql/migration_v3_rpc.sql       # RPC functions
3. sql/migration_v3_functions.sql # Utility functions
4. sql/migration_recipes.sql      # Crafting system
5. sql/migration_scanner.sql      # Scanner features
```

### Deployment

```bash
# Deploy to Vercel
npx vercel --prod
```

---

## 📡 API Endpoints

### Ingestion
| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/ingest` | Ingest price observations (batch supported) |

### Data Resources
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/data?resource=items` | List/search items |
| `GET` | `/api/data?resource=categories` | List categories |
| `GET` | `/api/data?resource=recipes` | List recipes with profitability |
| `GET` | `/api/data?resource=consumables` | Consumable items |

### Market Analytics
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/market_v2?resource=market&type=index` | Market index |
| `GET` | `/api/market_v2?resource=market&type=movers` | Top movers |
| `GET` | `/api/market_v2?resource=market&type=volatility` | Volatility rankings |
| `GET` | `/api/market_v2?resource=market&type=opportunities` | Buy opportunities |
| `GET` | `/api/market_v2?resource=analysis&type=scanner` | Multi-criteria scanner |
| `GET` | `/api/market_v2?resource=analysis&type=trends` | Trend analysis |
| `GET` | `/api/market_v2?resource=timeseries` | Historical price data |

### User Resources
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET/POST` | `/api/user?resource=profiles` | Profile management |
| `GET/POST` | `/api/user?resource=favorites` | Favorite items |
| `GET/POST` | `/api/user?resource=lists` | Custom watchlists |
| `GET/POST` | `/api/user?resource=bank` | Bank contents & craft opportunities |

---

## 📁 SQL Migrations

| File | Purpose |
|------|---------|
| `migration_v3_schema.sql` | Core tables (items, observations, categories) |
| `migration_v3_rpc.sql` | Analytics RPC functions |
| `migration_v3_functions.sql` | Ingestion & utility functions |
| `migration_recipes.sql` | Crafting recipes system |
| `migration_scanner.sql` | Opportunity scanner |
| `migration_trends.sql` | Trend detection |
| `migration_bank_craft_opportunities.sql` | Bank-based crafting |

---

## 🔗 Related Projects

This backend is part of the **Dofus Tracker** ecosystem:

- **[Web Dashboard](https://github.com/MrPa2a/d-tracker-web)** — React frontend for data visualization
- **[Client V3](https://github.com/MrPa2a/d-tracker-client-sniffing)** — Network packet sniffer (Python, Scapy)

---

## 📄 License

This project is for educational and portfolio purposes. Dofus is a registered trademark of Ankama Games.
