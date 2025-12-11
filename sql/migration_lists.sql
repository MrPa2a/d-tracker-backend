-- Create lists table
CREATE TABLE IF NOT EXISTS lists (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    name TEXT NOT NULL,
    scope TEXT NOT NULL CHECK (scope IN ('public', 'private')),
    profile_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Re-create list_items table to ensure correct schema (with item_id FK)
DROP TABLE IF EXISTS list_items;
CREATE TABLE list_items (
    list_id UUID REFERENCES lists(id) ON DELETE CASCADE,
    item_id INTEGER REFERENCES items(id) ON DELETE CASCADE,
    added_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (list_id, item_id)
);

-- Enable RLS
ALTER TABLE lists ENABLE ROW LEVEL SECURITY;
ALTER TABLE list_items ENABLE ROW LEVEL SECURITY;

-- Create policies
DROP POLICY IF EXISTS "Allow public read access on lists" ON lists;
CREATE POLICY "Allow public read access on lists" ON lists FOR SELECT USING (true);

DROP POLICY IF EXISTS "Allow public insert access on lists" ON lists;
CREATE POLICY "Allow public insert access on lists" ON lists FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "Allow public update access on lists" ON lists;
CREATE POLICY "Allow public update access on lists" ON lists FOR UPDATE USING (true);

DROP POLICY IF EXISTS "Allow public delete access on lists" ON lists;
CREATE POLICY "Allow public delete access on lists" ON lists FOR DELETE USING (true);

DROP POLICY IF EXISTS "Allow public read access on list_items" ON list_items;
CREATE POLICY "Allow public read access on list_items" ON list_items FOR SELECT USING (true);

DROP POLICY IF EXISTS "Allow public insert access on list_items" ON list_items;
CREATE POLICY "Allow public insert access on list_items" ON list_items FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "Allow public delete access on list_items" ON list_items;
CREATE POLICY "Allow public delete access on list_items" ON list_items FOR DELETE USING (true);
