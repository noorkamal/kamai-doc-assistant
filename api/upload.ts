// api/upload.ts
// Vercel Serverless Function - JSON body: { filename, mime, size, contentBase64 }
import { createClient } from '@supabase/supabase-js';

// Small filename sanitizer (avoid slashes etc.)
function safeName(name: string) {
  return name.replace(/[^\w.\-]+/g, '-').slice(0, 180);
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Use POST' });
    return;
  }

  try {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

    if (!SUPABASE_URL || !SERVICE_ROLE) {
      res.status(500).json({ error: 'Missing server env vars (SUPABASE_URL / SUPABASE_SERVICE_ROLE)' });
      return;
    }

    const { filename, mime, size, contentBase64 } = req.body || {};
    if (!filename || !mime || !contentBase64) {
      res.status(400).json({ error: 'Missing required fields: filename, mime, contentBase64' });
      return;
    }

    // Limit ~10MB to keep serverless happy (adjust later if needed)
    const MAX = 10 * 1024 * 1024;
    if (size && Number(size) > MAX) {
      res.status(413).json({ error: 'File too large (max 10MB for this endpoint)' });
      return;
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

    const path = `raw/${Date.now()}-${safeName(filename)}`;
    const buffer = Buffer.from(contentBase64, 'base64');

    // Upload to private bucket
    const { error: upErr } = await supabase
      .storage
      .from('docs')
      .upload(path, buffer, { contentType: mime, upsert: false });

    if (upErr) {
      res.status(500).json({ error: `Storage upload failed: ${upErr.message}` });
      return;
    }

    // Create doc_files row
    const { data, error: dbErr } = await supabase
      .from('doc_files')
      .insert({
        filename,
        mime,
        size_bytes: size ?? buffer.length,
        storage_path: path,
        status: 'uploaded'
      })
      .select('id')
      .single();

    if (dbErr) {
      res.status(500).json({ error: `DB insert failed: ${dbErr.message}` });
      return;
    }

    res.status(200).json({ doc_id: data?.id, storage_path: path });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? 'Server error' });
  }
}
