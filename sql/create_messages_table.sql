-- Create messages table (bulletin board / posts system)
CREATE TABLE IF NOT EXISTS messages (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    profile_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create index for efficient queries by profile
CREATE INDEX IF NOT EXISTS idx_messages_profile_id ON messages(profile_id);

-- Create index for ordering by date
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at DESC);

-- Enable RLS (Row Level Security)
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

-- Create policies to allow public access (since auth is not required yet)
CREATE POLICY "Allow public read access on messages" ON messages FOR SELECT USING (true);
CREATE POLICY "Allow public insert access on messages" ON messages FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow public update access on messages" ON messages FOR UPDATE USING (true);
CREATE POLICY "Allow public delete access on messages" ON messages FOR DELETE USING (true);

-- Function to auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION update_messages_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to auto-update updated_at on row update
DROP TRIGGER IF EXISTS trigger_messages_updated_at ON messages;
CREATE TRIGGER trigger_messages_updated_at
    BEFORE UPDATE ON messages
    FOR EACH ROW
    EXECUTE FUNCTION update_messages_updated_at();

-- =============================================
-- Table pour le système lu/non-lu
-- =============================================

-- Create message_reads table (tracks which messages have been read by which profiles)
CREATE TABLE IF NOT EXISTS message_reads (
    message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    profile_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    read_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (message_id, profile_id)
);

-- Create index for efficient queries
CREATE INDEX IF NOT EXISTS idx_message_reads_profile_id ON message_reads(profile_id);
CREATE INDEX IF NOT EXISTS idx_message_reads_message_id ON message_reads(message_id);

-- Enable RLS
ALTER TABLE message_reads ENABLE ROW LEVEL SECURITY;

-- Create policies for message_reads
CREATE POLICY "Allow public read access on message_reads" ON message_reads FOR SELECT USING (true);
CREATE POLICY "Allow public insert access on message_reads" ON message_reads FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow public delete access on message_reads" ON message_reads FOR DELETE USING (true);
