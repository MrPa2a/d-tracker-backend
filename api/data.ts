import type { VercelRequest, VercelResponse } from '@vercel/node';
import { handleItems } from '../utils/handlers/items';
import { handleCategories } from '../utils/handlers/categories';
import { handleRecipes } from '../utils/handlers/recipes';
import { handleKnownItems } from '../utils/handlers/known_items';
import { handleConsumables } from '../utils/handlers/consumables';
import { handleToolbox } from '../utils/handlers/toolbox';
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
    if (!bodyStr) return;
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

  // Parse body if JSON
  if (req.method === 'POST' || req.method === 'PUT') {
      await parseBody(req);
  }

  const { resource } = req.query;

  switch (resource) {
    case 'items':
      return handleItems(req, res);
    case 'categories':
      return handleCategories(req, res);
    case 'recipes':
      return handleRecipes(req, res);
    case 'known_items':
      return handleKnownItems(req, res);
    case 'consumables':
      return handleConsumables(req, res);
    case 'toolbox':
      return handleToolbox(req, res);
    default:
      return res.status(400).json({ error: 'Missing or invalid resource parameter' });
  }
}
