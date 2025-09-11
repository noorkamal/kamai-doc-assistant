import { useState } from "react";

type UploadResp = { doc_id: string; storage_path: string };

export default function App() {
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<string>("");
  const [result, setResult] = useState<UploadResp | null>(null);

  const toBase64 = (f: File) =>
    new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => {
        const s = String(r.result || "");
        // data:*/*;base64,AAAA → keep only the part after the comma
        const b64 = s.includes(",") ? s.split(",")[1] : s;
        resolve(b64);
      };
      r.onerror = reject;
      r.readAsDataURL(f);
    });

  const onUpload = async () => {
    if (!file) return;
    setStatus("Uploading…");
    setResult(null);

    try {
      if (file.size > 10 * 1024 * 1024) {
        setStatus("File too large (limit 10MB for this demo).");
        return;
      }
      const contentBase64 = await toBase64(file);
      const body = {
        filename: file.name,
        mime: file.type || "application/octet-stream",
        size: file.size,
        contentBase64,
      };

      const res = await fetch("/api/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setStatus(`Error: ${data?.error || "upload failed"}`);
        return;
      }
      setResult(data as UploadResp);
      setStatus("Uploaded!");
    } catch (e: any) {
      setStatus(`Error: ${e?.message || "unknown"}`);
    }
  };

  return (
    <div style={{ maxWidth: 720, margin: "3rem auto", fontFamily: "system-ui, sans-serif" }}>
      <h1>Kamai Document Assistant — Upload Test</h1>
      <p>Choose a small PDF/DOCX/TXT (&lt; 10MB), then click Upload.</p>

      <div style={{ display: "grid", gap: 12, marginTop: 16 }}>
        <input
          type="file"
          onChange={(e) => setFile(e.target.files?.[0] || null)}
          accept=".pdf,.docx,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain"
        />
        <button
          onClick={onUpload}
          disabled={!file}
          style={{
            padding: "10px 16px",
            borderRadius: 8,
            border: "1px solid #ccc",
            background: file ? "#2563eb" : "#94a3b8",
            color: "white",
            cursor: file ? "pointer" : "not-allowed",
            width: 160,
          }}
        >
          Upload
        </button>

        {status && <div style={{ marginTop: 8 }}>{status}</div>}

        {result && (
          <div
            style={{
              marginTop: 12,
              padding: 12,
              border: "1px solid #334155",
              borderRadius: 8,
              background: "#0f172a",
              color: "#e2e8f0",
            }}
          >
            <div><strong>doc_id:</strong> {result.doc_id}</div>
            <div><strong>storage_path:</strong> {result.storage_path}</div>
            <div style={{ marginTop: 8, fontSize: 14, opacity: 0.9 }}>
              ✔ Now check Supabase → <em>Storage / docs</em> (path starts with <code>raw/</code>) and
              Table Editor → <em>public.doc_files</em> for a new row.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
