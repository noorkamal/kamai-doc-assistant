// api/extract.ts
// POST body: { doc_id: "<uuid>" }
// Uses SUPABASE_URL + SUPABASE_SERVICE_ROLE (server only)

import { createClient } from '@supabase/supabase-js';
import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Use POST' });
    return;
  }

  try {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
    if (!SUPABASE_URL || !SERVICE_ROLE) {
      res.status(500).json({ error: 'Missing server env vars' });
      return;
    }
    const { doc_id } = req.body || {};
    if (!doc_id) {
      res.status(400).json({ error: 'Missing doc_id' });
      return;
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

    // 1) Look up the doc row
    const { data: docRow, error: docErr } = await supabase
      .from('doc_files')
      .select('id, storage_path, filename, mime, status')
      .eq('id', doc_id)
      .single();

    if (docErr || !docRow) {
      res.status(404).json({ error: `doc not found: ${docErr?.message || 'missing'}` });
      return;
    }

    // 2) Download the file bytes from Storage
    const { data: download, error: dlErr } = await supabase
      .storage
      .from('docs')
      .download(docRow.storage_path);

    if (dlErr || !download) {
      res.status(500).json({ error: `storage download failed: ${dlErr?.message || 'no data'}` });
      return;
    }

    // Read stream/buffer
    const arrayBuffer = await download.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    let extractedText = '';

    // 3) Branch by mime or filename
    const mime = (docRow.mime || '').toLowerCase();
    const filename = (docRow.filename || '').toLowerCase();

    if (mime.includes('pdf') || filename.endsWith('.pdf')) {
      // pdf-parse
      try {
        const pdfRes = await pdfParse(buffer);
        extractedText = (pdfRes?.text || '').trim();
      } catch (e: any) {
        console.error('pdf parse err', e);
        extractedText = '';
      }
    } else if (
      mime.includes('word') ||
      filename.endsWith('.docx') ||
      filename.endsWith('.doc')
    ) {
      // mammoth for docx (doc may not be supported)
      try {
        const m = await mammoth.extractRawText({ buffer });
        extractedText = (m?.value || '').trim();
      } catch (e: any) {
        console.error('mammoth err', e);
        extractedText = '';
      }
    } else {
      // fallback: try to interpret as UTF-8 text
      try {
        extractedText = buffer.toString('utf8').trim();
      } catch {
        extractedText = '';
      }
    }

    // 4) Update the row (extracted_text + status)
    const { error: upErr } = await supabase
      .from('doc_files')
      .update({
        extracted_text: extractedText || null,
        status: extractedText ? 'processed' : 'error'
      })
      .eq('id', doc_id);

    if (upErr) {
      res.status(500).json({ error: `DB update failed: ${upErr.message}` });
      return;
    }

    res.status(200).json({ doc_id, status: extractedText ? 'processed' : 'error', extracted_text_length: extractedText?.length || 0 });
  } catch (e: any) {
    console.error(e);
    res.status(500).json({ error: e?.message || 'server error' });
  }
}
