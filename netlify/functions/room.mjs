import { getStore } from '@netlify/blobs';
import { handle } from '../lib/room-core.mjs';

// POST /api/room — shared rooms for the Man-Day Estimator, stored in Netlify Blobs
export default async req => handle(req, getStore({ name: 'manday-rooms', consistency: 'strong' }));

export const config = { path: '/api/room' };
