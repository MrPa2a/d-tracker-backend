import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { setCors } from '../cors';

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

export const handleMessages = async (req: VercelRequest, res: VercelResponse) => {
  setCors(req, res);

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const { mode } = req.query;

  // =============================================
  // MODE: unread-count - Compte les messages non lus
  // =============================================
  if (mode === 'unread-count') {
    if (req.method !== 'GET') {
      return res.status(405).json({ error: 'method_not_allowed' });
    }

    const { readerProfileId } = req.query;

    if (!readerProfileId || typeof readerProfileId !== 'string') {
      return res.status(400).json({ error: 'invalid_input', message: 'readerProfileId is required' });
    }

    // Compter manuellement les messages non lus (plus fiable que la requête imbriquée)
    const { data: allMessages, error: msgError } = await supabase
      .from('messages')
      .select('id')
      .neq('profile_id', readerProfileId);

    if (msgError) {
      console.error('Error fetching messages:', msgError);
      return res.status(500).json({ error: 'database_error', message: msgError.message });
    }

    const { data: readMessages, error: readError } = await supabase
      .from('message_reads')
      .select('message_id')
      .eq('profile_id', readerProfileId);

    if (readError) {
      console.error('Error fetching read messages:', readError);
      return res.status(500).json({ error: 'database_error', message: readError.message });
    }

    const readIds = new Set(readMessages?.map(r => r.message_id) || []);
    const unreadCount = allMessages?.filter(m => !readIds.has(m.id)).length || 0;

    return res.status(200).json({ count: unreadCount });
  }

  // =============================================
  // MODE: mark-read - Marquer des messages comme lus
  // =============================================
  if (mode === 'mark-read') {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'method_not_allowed' });
    }

    const { readerProfileId, messageIds } = req.body;

    if (!readerProfileId || typeof readerProfileId !== 'string') {
      return res.status(400).json({ error: 'invalid_input', message: 'readerProfileId is required' });
    }

    if (!messageIds || !Array.isArray(messageIds) || messageIds.length === 0) {
      return res.status(400).json({ error: 'invalid_input', message: 'messageIds array is required' });
    }

    // Insérer les entrées de lecture (ignorer les doublons)
    const readEntries = messageIds.map((messageId: string) => ({
      message_id: messageId,
      profile_id: readerProfileId,
    }));

    const { error } = await supabase
      .from('message_reads')
      .upsert(readEntries, { onConflict: 'message_id,profile_id', ignoreDuplicates: true });

    if (error) {
      console.error('Error marking messages as read:', error);
      return res.status(500).json({ error: 'database_error', message: error.message });
    }

    return res.status(200).json({ message: 'Messages marked as read' });
  }

  // =============================================
  // MODE: mark-all-read - Marquer tous les messages comme lus
  // =============================================
  if (mode === 'mark-all-read') {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'method_not_allowed' });
    }

    const { readerProfileId } = req.body;

    if (!readerProfileId || typeof readerProfileId !== 'string') {
      return res.status(400).json({ error: 'invalid_input', message: 'readerProfileId is required' });
    }

    // Récupérer tous les messages non lus (excluant les siens)
    const { data: unreadMessages, error: fetchError } = await supabase
      .from('messages')
      .select('id')
      .neq('profile_id', readerProfileId);

    if (fetchError) {
      console.error('Error fetching messages:', fetchError);
      return res.status(500).json({ error: 'database_error', message: fetchError.message });
    }

    if (!unreadMessages || unreadMessages.length === 0) {
      return res.status(200).json({ message: 'No messages to mark as read' });
    }

    // Insérer les entrées de lecture pour tous
    const readEntries = unreadMessages.map((msg) => ({
      message_id: msg.id,
      profile_id: readerProfileId,
    }));

    const { error } = await supabase
      .from('message_reads')
      .upsert(readEntries, { onConflict: 'message_id,profile_id', ignoreDuplicates: true });

    if (error) {
      console.error('Error marking all messages as read:', error);
      return res.status(500).json({ error: 'database_error', message: error.message });
    }

    return res.status(200).json({ message: 'All messages marked as read', count: unreadMessages.length });
  }

  // =============================================
  // Standard CRUD operations
  // =============================================

  // --- GET: Fetch all messages (avec statut lu/non-lu optionnel) ---
  if (req.method === 'GET') {
    const { profileId, readerProfileId, limit = '50', offset = '0' } = req.query;

    let query = supabase
      .from('messages')
      .select(`
        id,
        content,
        created_at,
        updated_at,
        profile_id,
        profiles:profile_id(id, name)
      `)
      .order('created_at', { ascending: false })
      .range(parseInt(offset as string), parseInt(offset as string) + parseInt(limit as string) - 1);

    // Optional: filter by author profile
    if (profileId && typeof profileId === 'string') {
      query = query.eq('profile_id', profileId);
    }

    const { data, error } = await query;

    if (error) {
      console.error('Error fetching messages:', error);
      return res.status(500).json({ error: 'database_error', message: error.message });
    }

    // Si readerProfileId est fourni, récupérer les IDs des messages lus
    let readMessageIds: Set<string> = new Set();
    if (readerProfileId && typeof readerProfileId === 'string') {
      const { data: readData } = await supabase
        .from('message_reads')
        .select('message_id')
        .eq('profile_id', readerProfileId);

      if (readData) {
        readMessageIds = new Set(readData.map(r => r.message_id));
      }
    }

    // Transform data to flatten profile info and add isRead status
    const messages = data.map((msg: any) => ({
      id: msg.id,
      content: msg.content,
      createdAt: msg.created_at,
      updatedAt: msg.updated_at,
      author: {
        id: msg.profiles.id,
        name: msg.profiles.name,
      },
      // Un message est considéré comme "lu" si :
      // - C'est son propre message (profile_id === readerProfileId)
      // - Ou il a une entrée dans message_reads
      isRead: readerProfileId 
        ? (msg.profile_id === readerProfileId || readMessageIds.has(msg.id))
        : undefined,
    }));

    return res.status(200).json(messages);
  }

  // --- POST: Create a new message ---
  if (req.method === 'POST') {
    const { profileId, content } = req.body;

    if (!profileId || typeof profileId !== 'string') {
      return res.status(400).json({ error: 'invalid_input', message: 'profileId is required' });
    }

    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      return res.status(400).json({ error: 'invalid_input', message: 'content is required and cannot be empty' });
    }

    // Validate content length (max 2000 characters)
    if (content.length > 2000) {
      return res.status(400).json({ error: 'invalid_input', message: 'content exceeds maximum length of 2000 characters' });
    }

    const { data, error } = await supabase
      .from('messages')
      .insert([{ profile_id: profileId, content: content.trim() }])
      .select(`
        id,
        content,
        created_at,
        updated_at,
        profiles:profile_id(id, name)
      `)
      .single();

    if (error) {
      console.error('Error creating message:', error);
      return res.status(500).json({ error: 'database_error', message: error.message });
    }

    const profile = data.profiles as unknown as { id: string; name: string };
    return res.status(201).json({
      id: data.id,
      content: data.content,
      createdAt: data.created_at,
      updatedAt: data.updated_at,
      author: {
        id: profile.id,
        name: profile.name,
      },
    });
  }

  // --- PUT: Update a message ---
  if (req.method === 'PUT') {
    const { id, profileId, content } = req.body;

    if (!id || typeof id !== 'string') {
      return res.status(400).json({ error: 'invalid_input', message: 'id is required' });
    }

    if (!profileId || typeof profileId !== 'string') {
      return res.status(400).json({ error: 'invalid_input', message: 'profileId is required' });
    }

    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      return res.status(400).json({ error: 'invalid_input', message: 'content is required and cannot be empty' });
    }

    if (content.length > 2000) {
      return res.status(400).json({ error: 'invalid_input', message: 'content exceeds maximum length of 2000 characters' });
    }

    // Verify the message belongs to the profile before updating
    const { data: existingMessage, error: fetchError } = await supabase
      .from('messages')
      .select('profile_id')
      .eq('id', id)
      .single();

    if (fetchError || !existingMessage) {
      return res.status(404).json({ error: 'not_found', message: 'Message not found' });
    }

    if (existingMessage.profile_id !== profileId) {
      return res.status(403).json({ error: 'forbidden', message: 'You can only edit your own messages' });
    }

    const { data, error } = await supabase
      .from('messages')
      .update({ content: content.trim() })
      .eq('id', id)
      .select(`
        id,
        content,
        created_at,
        updated_at,
        profiles:profile_id(id, name)
      `)
      .single();

    if (error) {
      console.error('Error updating message:', error);
      return res.status(500).json({ error: 'database_error', message: error.message });
    }

    const profile = data.profiles as unknown as { id: string; name: string };
    return res.status(200).json({
      id: data.id,
      content: data.content,
      createdAt: data.created_at,
      updatedAt: data.updated_at,
      author: {
        id: profile.id,
        name: profile.name,
      },
    });
  }

  // --- DELETE: Delete a message ---
  if (req.method === 'DELETE') {
    const { id, profileId } = req.query;

    if (!id || typeof id !== 'string') {
      return res.status(400).json({ error: 'invalid_input', message: 'id is required' });
    }

    if (!profileId || typeof profileId !== 'string') {
      return res.status(400).json({ error: 'invalid_input', message: 'profileId is required' });
    }

    // Verify the message belongs to the profile before deleting
    const { data: existingMessage, error: fetchError } = await supabase
      .from('messages')
      .select('profile_id')
      .eq('id', id)
      .single();

    if (fetchError || !existingMessage) {
      return res.status(404).json({ error: 'not_found', message: 'Message not found' });
    }

    if (existingMessage.profile_id !== profileId) {
      return res.status(403).json({ error: 'forbidden', message: 'You can only delete your own messages' });
    }

    const { error } = await supabase
      .from('messages')
      .delete()
      .eq('id', id);

    if (error) {
      console.error('Error deleting message:', error);
      return res.status(500).json({ error: 'database_error', message: error.message });
    }

    return res.status(200).json({ message: 'Message deleted successfully' });
  }

  return res.status(405).json({ error: 'method_not_allowed' });
};
