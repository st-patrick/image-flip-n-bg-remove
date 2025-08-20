import type { VercelRequest, VercelResponse } from '@vercel/node';
import sharp from 'sharp';
import { put, del, list } from '@vercel/blob';
import crypto from 'node:crypto';

const REMOVE_BG_API_KEY = process.env.REMOVE_BG_API_KEY!;

function setAnonCookie(req: VercelRequest, res: VercelResponse) {
  let uid = (req as any).cookies?.uid as string | undefined;
  // Fallback parse if req.cookies not populated
  if (!uid && req.headers.cookie) {
    const m = req.headers.cookie.split(';').map(v => v.trim().split('='));
    const found = m.find(([k]) => k === 'uid');
    uid = found?.[1];
  }
  if (!uid) {
    uid = crypto.randomUUID();
    const cookie = `uid=${uid}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`;
    res.setHeader('Set-Cookie', cookie);
  }
  return uid!;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const method = req.method || 'GET';
  const action = (req.query.action as string) || (method === 'POST' ? 'upload' : method === 'DELETE' ? 'delete' : 'list');
  const uid = setAnonCookie(req, res);

  try {
    if (action === 'upload' && method === 'POST') {
      // Expect JSON: { fileB64: string }
      const { fileB64 } = (req.body || {}) as { fileB64?: string };
      if (!fileB64) return res.status(400).json({ error: 'fileB64 required (base64 encoded image bytes)' });

      const inputBuf = Buffer.from(fileB64, 'base64');

      // 1) Background removal via remove.bg
      const params = new URLSearchParams();
      params.set('image_file_b64', inputBuf.toString('base64'));
      params.set('size', 'auto');

      const r = await fetch('https://api.remove.bg/v1.0/removebg', {
        method: 'POST',
        headers: { 'X-Api-Key': REMOVE_BG_API_KEY },
        body: params,
      });
      if (!r.ok) {
        const txt = await r.text();
        return res.status(502).json({ error: 'remove.bg failed', details: txt });
      }
      const bgRemoved = Buffer.from(await r.arrayBuffer());

      // 2) Horizontal flip (flop) with sharp
      const flipped = await sharp(bgRemoved).flop().png().toBuffer();

      // 3) Store result in Vercel Blob (public URL)
      const key = `images/${uid}/${Date.now()}-${Math.random().toString(36).slice(2)}.png`;
      const { url, pathname } = await put(key, flipped, { access: 'public' });

      return res.status(200).json({ url, pathname });
    }

    if (action === 'list' && method === 'GET') {
        try {
            const resp = await list({ prefix: `images/${uid}/` });
            return res.status(200).json({ items: resp.blobs });
        } catch (e: any) {
            console.error('Blob list failed', e);
            return res.status(500).json({ error: 'Blob list failed', details: e.message });
        }
    }

    if (action === 'delete' && method === 'DELETE') {
      // Accept either ?pathname=images/uid/... or ?url=https://.../images/uid/...
      const { pathname, url } = req.query as { pathname?: string; url?: string };
      const target = pathname || url;
      if (!target) return res.status(400).json({ error: 'pathname or url required' });

      // Normalize to path-only and enforce ownership via prefix check
      const pathOnly = target.includes('/images/') ? target.slice(target.indexOf('images/')) : target;
      if (!pathOnly.startsWith(`images/${uid}/`)) {
        return res.status(403).json({ error: 'Not your file' });
      }

      await del(pathOnly);
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Unsupported method/action' });
  } catch (e: any) {
    console.error(e);
    return res.status(500).json({ error: 'Server error', details: e?.message || String(e) });
  }
}