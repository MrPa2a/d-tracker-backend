-- Table for Almanax Calendar
CREATE TABLE IF NOT EXISTS public.almanax_calendar (
    date DATE PRIMARY KEY,
    item_id INTEGER REFERENCES public.items(id),
    quantity INTEGER DEFAULT 1,
    bonus_description TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_almanax_calendar_item_id ON public.almanax_calendar(item_id);
