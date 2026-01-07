import React, { useState, useRef, useEffect } from "react";
import * as mammoth from "mammoth";

// ✅ Vite-compatible PDF.js
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf";
import "pdfjs-dist/legacy/build/pdf.worker";

const DocumentQA = () => {
  const [documents, setDocuments] = useState([]);
  const [chunks, setChunks] = useState([]);
  const [messages, setMessages] = useState([]);
  const [inputValue, setInputValue] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [isAnswering, setIsAnswering] = useState(false);
  const [uploadStatus, setUploadStatus] = useState("");
  const messagesEndRef = useRef(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  /* -------------------- PDF EXTRACTION -------------------- */
  const extractTextFromPDF = async (file) => {
    const buffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;

    let text = "";
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      text += content.items.map(item => item.str).join(" ") + "\n";
    }

    if (!/[a-zA-Z]{5,}/.test(text)) {
      throw new Error("PDF text unreadable. Use a text-based PDF.");
    }

    return text;
  };

  const extractTextFromDOCX = async (file) => {
    const buffer = await file.arrayBuffer();
    const result = await mammoth.extractRawText({ arrayBuffer: buffer });
    return result.value;
  };

  const extractTextFromTXT = async (file) => file.text();

  /* -------------------- CHUNKING (ASSIGNMENT ALIGNED) -------------------- */
  const chunkText = (text, docName, size = 500, overlap = 100) => {
    const words = text.split(/\s+/);
    const out = [];
    let id = 0;

    for (let i = 0; i < words.length; i += size - overlap) {
      const chunk = words.slice(i, i + size).join(" ");
      if (chunk.trim()) {
        out.push({
          id: `${docName}-${id}`,
          text: chunk,
          docName,
          index: id
        });
        id++;
      }
    }
    return out;
  };

  /* -------------------- SIMPLE EMBEDDING -------------------- */
  const embed = (text) => {
    const vec = new Array(256).fill(0);
    for (const c of text.toLowerCase()) {
      vec[c.charCodeAt(0) % 256] += 1;
    }
    const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
    return vec.map(v => v / mag);
  };

  const cosine = (a, b) =>
    a.reduce((s, v, i) => s + v * b[i], 0);

  /* -------------------- FILE UPLOAD -------------------- */
  const handleFileUpload = async (e) => {
    setIsProcessing(true);
    setUploadStatus("Processing documents...");

    try {
      const newDocs = [];
      const newChunks = [];

      for (const file of e.target.files) {
        let text = "";
        const ext = file.name.split(".").pop().toLowerCase();

        if (ext === "pdf") text = await extractTextFromPDF(file);
        else if (ext === "docx") text = await extractTextFromDOCX(file);
        else if (ext === "txt" || ext === "md") text = await extractTextFromTXT(file);
        else continue;

        if (text.length < 500) {
          throw new Error("Insufficient readable text.");
        }

        const doc = { id: Date.now(), name: file.name };
        const c = chunkText(text, file.name);
        c.forEach(x => x.embedding = embed(x.text));

        newDocs.push(doc);
        newChunks.push(...c);
      }

      setDocuments(prev => [...prev, ...newDocs]);
      setChunks(prev => [...prev, ...newChunks]);
      setUploadStatus("Documents processed successfully.");
    } catch (err) {
      setUploadStatus(`Error: ${err.message}`);
    }

    setIsProcessing(false);
  };

  /* -------------------- RETRIEVAL -------------------- */
  const retrieve = (q) => {
    const qv = embed(q);
    return chunks
      .map(c => ({ ...c, score: cosine(qv, c.embedding) }))
      .filter(c => c.score > 0.25)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
  };

  /* -------------------- GROQ API -------------------- */
  const callAI = async (context, question) => {
    const apiKey = import.meta.env.VITE_GROQ_API_KEY;
    if (!apiKey) throw new Error("Groq API key missing.");

    const prompt = `
Answer ONLY from the provided context.
If not found, say "I could not find this information in the document."

Context:
${context}

Question:
${question}
`;

    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: "llama-3.1-8b-instant",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.3,
        max_tokens: 1024
      })
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error?.message || "Groq API error");
    }

    const data = await res.json();
    return data.choices[0].message.content;
  };

  /* -------------------- ASK QUESTION -------------------- */
  const ask = async () => {
    if (!inputValue || !chunks.length) return;

    setMessages(m => [...m, { role: "user", content: inputValue }]);
    setIsAnswering(true);

    try {
      const rel = retrieve(inputValue);
      if (!rel.length) throw new Error("No relevant context found.");

      const ctx = rel
        .map((c, i) => `[Source ${i + 1}: ${c.docName}]\n${c.text}`)
        .join("\n\n");

      const ans = await callAI(ctx, inputValue);

      setMessages(m => [
        ...m,
        {
          role: "assistant",
          content: ans,
          sources: rel.map((c, i) => ({
            id: i + 1,
            doc: c.docName,
            section: c.index
          }))
        }
      ]);
    } catch (e) {
      setMessages(m => [...m, { role: "assistant", content: `Error: ${e.message}` }]);
    }

    setIsAnswering(false);
    setInputValue("");
  };

  /* -------------------- RESET ACTIONS -------------------- */
  const clearChat = () => setMessages([]);
  const resetKnowledgeBase = () => {
    setDocuments([]);
    setChunks([]);
    setMessages([]);
    setUploadStatus("");
  };

  /* -------------------- UI -------------------- */
  return (
    <div className="min-h-screen bg-gray-100 p-6 flex justify-center">
      <div className="w-full max-w-4xl bg-white rounded-lg shadow p-6">

        <div className="flex justify-between items-center mb-4">
          <h1 className="text-2xl font-bold">Document Q&A (RAG)</h1>
          <div className="space-x-4 text-sm">
            <button onClick={clearChat} className="text-blue-600 hover:underline">
              Clear Chat
            </button>
            <button onClick={resetKnowledgeBase} className="text-red-600 hover:underline">
              Reset Knowledge Base
            </button>
          </div>
        </div>

        <input type="file" multiple onChange={handleFileUpload} />
        <p className="text-sm text-gray-600 mt-2">{uploadStatus}</p>

        <div className="mt-6 space-y-4">
          {messages.map((m, i) => (
            <div key={i} className="border-b pb-2">
              <p><b>{m.role}:</b> {m.content}</p>

              {m.sources && (
                <div className="mt-2 text-xs text-gray-500">
                  <p className="font-semibold">Sources:</p>
                  {m.sources.map(s => (
                    <p key={s.id}>
                      [{s.id}] {s.doc} – Section {s.section}
                    </p>
                  ))}
                </div>
              )}
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>

        <div className="flex gap-2 mt-6">
          <input
            className="flex-1 border rounded px-3 py-2"
            value={inputValue}
            onChange={e => setInputValue(e.target.value)}
            onKeyDown={e => e.key === "Enter" && ask()}
            placeholder="Ask a question..."
          />
          <button
            onClick={ask}
            disabled={isAnswering}
            className="bg-blue-600 text-white px-4 py-2 rounded disabled:opacity-50"
          >
            {isAnswering ? "Thinking..." : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
};

export default DocumentQA;
