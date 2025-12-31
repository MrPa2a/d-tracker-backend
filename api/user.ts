import type { VercelRequest, VercelResponse } from '@vercel/node';
import { handleLists } from '../utils/handlers/lists';
import { handleProfiles } from '../utils/handlers/profiles';
import { handleMessages } from '../utils/handlers/messages';
import { handleBank } from '../utils/handlers/bank';
import { setCors } from '../utils/cors';

export const config = {
  api: {
    bodyParser: false,
  },
};

async function parseBody(req: VercelRequest) {
  if (req.headers['content-type']?.includes('application/json')) {
    let bodyStr = '';
    for await (const chunk of req) {
      bodyStr += chunk;
    }
    try {
      req.body = JSON.parse(bodyStr);
    } catch (e) {
      console.error('Failed to parse JSON body', e);
    }
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCors(req, res);
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE') {
      await parseBody(req);
  }

  const { resource } = req.query;

  switch (resource) {
    case 'lists':
      return handleLists(req, res);
    case 'profiles':
      return handleProfiles(req, res);
    case 'messages':
      return handleMessages(req, res);
    case 'bank':
      return handleBank(req, res);
    default:
      return res.status(400).json({ error: 'Missing or invalid resource parameter' });
  }
}
