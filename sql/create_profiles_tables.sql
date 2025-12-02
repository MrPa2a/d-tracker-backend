-- Create profiles table
CREATE TABLE IF NOT EXISTS profiles (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create profile_favorites table
CREATE TABLE IF NOT EXISTS profile_favorites (
    profile_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
    item_name TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (profile_id, item_name)
);

-- Enable RLS (Row Level Security) if needed, but for now we assume service role access or public access as per requirements "accessible par tous"
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE profile_favorites ENABLE ROW LEVEL SECURITY;

-- Create policies to allow public access (since auth is not required yet)
CREATE POLICY "Allow public read access on profiles" ON profiles FOR SELECT USING (true);
CREATE POLICY "Allow public insert access on profiles" ON profiles FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow public update access on profiles" ON profiles FOR UPDATE USING (true);
CREATE POLICY "Allow public delete access on profiles" ON profiles FOR DELETE USING (true);

CREATE POLICY "Allow public read access on profile_favorites" ON profile_favorites FOR SELECT USING (true);
CREATE POLICY "Allow public insert access on profile_favorites" ON profile_favorites FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow public delete access on profile_favorites" ON profile_favorites FOR DELETE USING (true);
