// api/extract.ts
// Vercel Serverless Function - POST body: { doc_id: "<uuid>" }
// Supports: .pdf, .docx/.doc (mammoth), .pptx (JSZip + fast-xml-parser), fallback utf8 text

import { createClient } from "@supabase/supabase-js";
import pdfParse from "pdf-parse";
import mammoth from "mammoth";
import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";

type VercelReq = any;
type VercelRes = any;

async function extractFromPptx(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    removeNSPrefix: true,
  });

  const slideFiles = Object.keys(zip.files).filter((p) => p.startsWith("ppt/slides/slide") && p.endsWith(".xml"));
  slideFiles.sort();

  const slideTexts: string[] = [];
  for (const sPath of slideFiles) {
    const file = zip.file(sPath);
    if (!file) continue;
    const xmlText = await file.async("text");
    const xmlObj = parser.parse(xmlText);
    // collect text nodes
    const texts: string[] = [];
    const collectText = (node: any) => {
      if (!node || typeof node !== "object") return;
      if ("t" in node) {
        const t = node["t"];
        if (typeof t === "string") texts.push(t);
        else if (typeof t === "object" && t["#text"]) texts.push(t["#text"]);
      }
      for (const k of Object.keys(node)) {
        const child = node[k];
        if (Array.isArray(child)) child.forEach(collectText);
        else if (typeof child === "object") collectText(child);
      }
    };
    collectText(xmlObj);
    const slideText = texts.join(" ").replace(/\s+/g, " ").trim();
    if (slideText) slideTexts.push(slideText);
  }

  // notes (optional)
  const notesFiles = Object.keys(zip.files).filter((p) => p.startsWith("ppt/notesSlides/notesSlide") && p.endsWith(".xml"));
  notesFiles.sort();
  const notesTexts: string[] = [];
  for (const nPath of notesFiles) {
    const file = zip.file(nPath);
    if (!file) continue;
    const xmlText = await file.async("text");
    const xmlObj = parser.parse(xmlText);
    const texts: string[] = [];
    const collectText = (node: any) => {
      if (!node || typeof node !== "object") return;
      if ("t" in node) {
        const t = node["t"];
        if (typeof t === "string") texts.push(t);
        else if (typeof t === "object" && t["#text"]) texts.push(t["#text"]);
      }
      for (const k of Object.keys(node)) {
        const child = node[k];
        if (Array.isArray(child)) child.forEach(collectText);
        else if (typeof child === "object") collectText(child);
      }
    };
    collectText(xmlObj);
    const noteText = texts.join(" ").replace(/\s+/g, " ").trim();
    if (noteText) notesTexts.push(noteText);
  }

  const combined = [
    slideTexts.map((t, i) => `Slide ${i + 1}:\n${t}`).join("\n\n"),
    notesTexts.length ? "\n\nNotes:\n" + notesTexts.join("\n\n") : "",
  ].join("");

  return combined.trim();
}

export default async function handler(req: VercelReq, res: VercelRes) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Use POST" });
    return;
  }

  try {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
    if (!SUPABASE_URL || !SERVICE_ROLE) {
      res.status(500).json({ error: "Missing server env vars" });
      return;
    }

    const { doc_id } = req.body || {};
    if (!doc_id) {
      res.status(400).json({ error: "Missing doc_id" });
      return;
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

    // 1) fetch doc row
    const { data: docRow, error: docErr } = await supabase
      .from("doc_files")
      .select("id, storage_path, filename, mime, status")
      .eq("id", doc_id)
      .single();

    if (docErr || !docRow) {
      res.status(404).json({ error: `doc not found: ${docErr?.message || "missing"}` });
      return;
    }

    // 2) download file from private storage
    const { data: download, error: dlErr } = await supabase.storage.from("docs").download(docRow.storage_path);

    if (dlErr || !download) {
      res.status(500).json({ error: `storage download failed: ${dlErr?.message || "no data"}` });
      return;
    }

    const arrayBuffer = await download.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    let extractedText = "";

    const mime = (docRow.mime || "").toLowerCase();
    const filename = (docRow.filename || "").toLowerCase();

    // PDF
  import { getDocument, GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.js";
  
  // If you want you can point the workerSrc to a CDN path; in Node this isn't needed but set to empty.
  GlobalWorkerOptions.workerSrc = "";
  
  if (mime.includes("pdf") || filename.endsWith(".pdf")) {
    try {
      // pdfjs expects a Uint8Array
      const uint8 = new Uint8Array(buffer);
  
      // load the document
      const loadingTask = getDocument({ data: uint8 });
      const pdf = await loadingTask.promise;
  
      const numPages = pdf.numPages || 0;
      const pages: string[] = [];
  
      for (let i = 1; i <= numPages; i++) {
        try {
          const page = await pdf.getPage(i);
          const textContent = await page.getTextContent();
          const strings = textContent.items?.map((it: any) => ("str" in it ? it.str : "")).filter(Boolean) || [];
          pages.push(strings.join(" "));
        } catch (pageErr) {
          console.error(`pdfjs page ${i} err`, pageErr);
        }
      }
  
      extractedText = pages.join("\n\n").trim();
    } catch (e: any) {
      console.error("pdfjs extract err", e);
      extractedText = "";
    }
  }

      // DOCX / DOC (mammoth)
    } else if (mime.includes("word") || filename.endsWith(".docx") || filename.endsWith(".doc")) {
      try {
        const m = await mammoth.extractRawText({ buffer });
        extractedText = (m?.value || "").trim();
      } catch (e: any) {
        console.error("mammoth err", e);
        extractedText = "";
      }

      // PPTX
    } else if (mime.includes("presentation") || filename.endsWith(".pptx")) {
      try {
        extractedText = await extractFromPptx(buffer);
      } catch (e: any) {
        console.error("pptx parse err", e);
        extractedText = "";
      }

      // fallback: interpret as UTF-8
    } else {
      try {
        extractedText = buffer.toString("utf8").trim();
      } catch {
        extractedText = "";
      }
    }

    // 4) Update row
    const { error: upErr } = await supabase
      .from("doc_files")
      .update({
        extracted_text: extractedText || null,
        status: extractedText ? "processed" : "error",
      })
      .eq("id", doc_id);

    if (upErr) {
      res.status(500).json({ error: `DB update failed: ${upErr.message}` });
      return;
    }

    res.status(200).json({ doc_id, status: extractedText ? "processed" : "error", extracted_text_length: extractedText?.length || 0 });
  } catch (e: any) {
    console.error(e);
    res.status(500).json({ error: e?.message || "server error" });
  }
}
