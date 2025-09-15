// api/extract.ts
// Vercel Serverless Function
// POST body: { doc_id: "<uuid>" }
// Supports: .pdf (pdfjs via runtime require), .docx/.doc (mammoth), .pptx (JSZip + fast-xml-parser), fallback text

/* eslint-disable @typescript-eslint/no-explicit-any */
declare const require: any;

import { createClient } from "@supabase/supabase-js";
import * as fs from "fs"; // only for typings if needed
// mammoth, jszip, fast-xml-parser can be imported normally (we included type shims)
import mammoth from "mammoth";
import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";

type VercelReq = any;
type VercelRes = any;

// --- load pdfjs at runtime with fallbacks to avoid TS static import issues ---
let getDocument: any = null;
let GlobalWorkerOptions: any = null;

try {
  // try legacy path first
  // @ts-ignore
  const pdfjsLegacy = require("pdfjs-dist/legacy/build/pdf.js");
  if (pdfjsLegacy) {
    getDocument = pdfjsLegacy.getDocument || pdfjsLegacy.default?.getDocument;
    GlobalWorkerOptions = pdfjsLegacy.GlobalWorkerOptions || pdfjsLegacy.default?.GlobalWorkerOptions;
  }
} catch (e) {
  // ignore
}

if (!getDocument) {
  try {
    // fallback to package main (some installs expose this)
    // @ts-ignore
    const pdfjsMain = require("pdfjs-dist");
    getDocument = pdfjsMain.getDocument || pdfjsMain.default?.getDocument;
    GlobalWorkerOptions = pdfjsMain.GlobalWorkerOptions || pdfjsMain.default?.GlobalWorkerOptions;
  } catch (e) {
    // last resort leave as null; we'll guard at runtime
    getDocument = null;
    GlobalWorkerOptions = null;
  }
}

// Helper: extract text from PPTX
async function extractFromPptx(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    removeNSPrefix: true,
  });

  const slideFiles = Object.keys(zip.files)
    .filter((p) => p.startsWith("ppt/slides/slide") && p.endsWith(".xml"))
    .sort();

  const slideTexts: string[] = [];
  for (const sPath of slideFiles) {
    const file = zip.file(sPath);
    if (!file) continue;
    const xmlText = await file.async("text");
    const xmlObj = parser.parse(xmlText);
    const texts: string[] = [];

    const collectText = (node: any) => {
      if (!node || typeof node !== "object") return;
      if ("t" in node) {
        const t = node["t"];
        if (typeof t === "string") texts.push(t);
        else if (typeof t === "object" && t["#text"]) texts.push(node["#text"] || "");
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

  // notes
  const notesFiles = Object.keys(zip.files)
    .filter((p) => p.startsWith("ppt/notesSlides/notesSlide") && p.endsWith(".xml"))
    .sort();

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
        else if (typeof t === "object" && node["#text"]) texts.push(node["#text"] || "");
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

// Helper: extract text from PDF using runtime getDocument (pdfjs)
async function extractFromPdf(buffer: Buffer): Promise<string> {
  if (!getDocument) {
    console.error("pdf extraction unavailable: getDocument not found");
    return "";
  }

  try {
    // set workerSrc to empty (node environment) if available
    try {
      if (GlobalWorkerOptions) {
        GlobalWorkerOptions.workerSrc = GlobalWorkerOptions.workerSrc || "";
      }
    } catch (e) {
      // ignore
    }

    const uint8 = new Uint8Array(buffer);
    const loadingTask = getDocument({ data: uint8 });
    const pdf: any = await loadingTask.promise;
    const numPages = pdf.numPages || 0;
    const pages: string[] = [];

    for (let i = 1; i <= numPages; i++) {
      try {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        const strings = (textContent.items?.map((it: any) => ("str" in it ? it.str : "")).filter(Boolean)) || [];
        pages.push(strings.join(" "));
      } catch (pageErr) {
        console.error(`pdfjs page ${i} err`, pageErr);
      }
    }

    return pages.join("\n\n").trim();
  } catch (e: any) {
    console.error("pdfjs extract err", e);
    return "";
  }
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
      res.status(500).json({ error: "Missing server env vars (SUPABASE_URL / SUPABASE_SERVICE_ROLE)" });
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
    if (mime.includes("pdf") || filename.endsWith(".pdf")) {
      extractedText = await extractFromPdf(buffer);
    }
    // DOCX / DOC (mammoth)
    else if (mime.includes("word") || filename.endsWith(".docx") || filename.endsWith(".doc")) {
      try {
        const m = await mammoth.extractRawText({ buffer });
        extractedText = (m?.value || "").trim();
      } catch (e: any) {
        console.error("mammoth err", e);
        extractedText = "";
      }
    }
    // PPTX
    else if (mime.includes("presentation") || filename.endsWith(".pptx")) {
      try {
        extractedText = await extractFromPptx(buffer);
      } catch (e: any) {
        console.error("pptx parse err", e);
        extractedText = "";
      }
    } else {
      // fallback: try to interpret as UTF-8 text
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
      console.error("DB update failed", upErr);
      res.status(500).json({ error: `DB update failed: ${upErr.message}` });
      return;
    }

    res.status(200).json({ doc_id, status: extractedText ? "processed" : "error", extracted_text_length: extractedText?.length || 0 });
  } catch (e: any) {
    console.error("extract handler err", e);
    res.status(500).json({ error: e?.message || "server error" });
  }
}
