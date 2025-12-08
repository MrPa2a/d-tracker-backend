# 🛠️ Dofus Tracker Backend

The serverless backend for the Dofus Tracker ecosystem, deployed on **Vercel** and powered by **Supabase**.

## ✨ Features

*   **Data Ingestion**: Secure endpoints to receive market data from clients.
*   **Dual Write / Migration**: Supports seamless migration to the new V3 normalized database schema.
*   **Market Analysis**: Advanced SQL RPC functions to calculate:
    *   Daily Timeseries
    *   Market Indexes
    *   Volatility Rankings
    *   Top Movers (Gainers/Losers)
    *   Investment/Selling Opportunities (Algorithm based on Moving Averages & Volatility)
*   **Profile Management**: User profiles and favorite items.

## 📂 Structure

*   `api/`: Serverless functions (Endpoints).
    *   `ingest.ts`: Receives data from the Python client.
    *   `market.ts`: Exposes analytical data (RPC calls).
    *   `items.ts`: Manages item definitions.
*   `sql/`: Database schemas and migration scripts.
    *   `migration_v3_*.sql`: Current active schema scripts.
    *   `cleanup_v2.sql`: Script to remove legacy tables.

## 🚀 Setup

1.  **Install Dependencies**:
    ```bash
    npm install
    ```

2.  **Environment Variables**:
    Create a `.env` file with:
    ```env
    SUPABASE_URL=your_supabase_url
    SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
    INGEST_API_TOKEN=your_secret_token
    ```

3.  **Run Locally**:
    ```bash
    npm run local
    ```
    (Requires Vercel CLI)

## 🗄️ Database (Supabase)

The project uses a **PostgreSQL** database with a normalized schema (V3):
*   `items`: Unique item definitions (ID, Name, Ankama ID).
*   `observations`: Price records linked to items.
*   `profiles`: User data.

Refer to the `sql/` directory for schema definitions.
