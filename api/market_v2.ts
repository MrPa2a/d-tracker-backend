import type { VercelRequest, VercelResponse } from '@vercel/node';
import { handleMarket } from '../utils/handlers/market';
import { handleAnalysis } from '../utils/handlers/analysis';
import { handleTimeseries } from '../utils/handlers/timeseries';
import { handleObservations } from '../utils/handlers/observations';
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

  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE') {
      await parseBody(req);
  }

  const { resource } = req.query;

  switch (resource) {
    case 'market':
      return handleMarket(req, res);
    case 'analysis':
      return handleAnalysis(req, res);
    case 'timeseries':
      return handleTimeseries(req, res);
    case 'observations':
      return handleObservations(req, res);
    default:
      return res.status(400).json({ error: 'Missing or invalid resource parameter' });
  }
}
