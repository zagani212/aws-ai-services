"use client";

import { useEffect, useMemo, useRef, useState } from "react";

const MAX_BYTES = 5 * 1024 * 1024; // 5MB
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

function bytesToMb(bytes: number) {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function stripCodeFences(s: string) {
  const t = s.trim();
  if (!t.startsWith("```")) return t;
  // Remove leading ```lang and trailing ```
  return t.replace(/^```[a-zA-Z]*\n?/, "").replace(/\n?```$/, "").trim();
}

function extractLikelyJson(s: string) {
  const cleaned = stripCodeFences(s).trim();
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) return cleaned.slice(first, last + 1);
  return cleaned;
}

function tryParseJson<T>(v: unknown): T | null {
  if (typeof v !== "string") return null;
  const cleaned = extractLikelyJson(v);
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    return null;
  }
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 style={{ margin: "14px 0 8px 0", fontSize: 14, color: "rgba(255,255,255,0.9)" }}>{children}</h3>;
}

function BulletList({ items }: { items: string[] }) {
  if (!items.length) return <div style={{ color: "rgba(255,255,255,0.65)" }}>—</div>;
  return (
    <ul style={{ margin: "6px 0 0 18px", padding: 0 }}>
      {items.map((it, idx) => (
        <li key={`${idx}-${it}`} style={{ margin: "6px 0" }}>
          {it}
        </li>
      ))}
    </ul>
  );
}

export default function HomePage() {
  const [comment, setComment] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [activeService, setActiveService] = useState<"advisor" | "safety" | "visual">("advisor");
  const [chatContext, setChatContext] = useState<any>(null);
  const [chatHistory, setChatHistory] = useState<Array<{ role: "user" | "assistant"; text: string }>>([]);
  const [chatInput, setChatInput] = useState("");
  const [isChatSending, setIsChatSending] = useState(false);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const chatBottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!chatBottomRef.current) return;
    chatBottomRef.current.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [chatHistory.length, activeService]);

  const fileMeta = useMemo(() => {
    if (!file) return null;
    return {
      name: file.name,
      type: file.type || "unknown",
      size: file.size
    };
  }, [file]);

  const pretty = useMemo(() => {
    if (!result) return null;

    type Advice = {
      product_summary?: string;
      target_customer?: string;
      positioning?: string;
      pricing_hint?: string;
      key_benefits?: string[];
      risks?: string[];
      improvements?: string[];
      marketing_angles?: string[];
      next_steps?: string[];
    };

    type TextSignals = {
      language?: string;
      sentiment?: { label?: string; confidence?: number };
      key_phrases?: string[];
      entities?: Array<{ text?: string; type?: string }>;
    };

    type Safety = {
      flagged?: boolean;
      severity?: "LOW" | "MEDIUM" | "HIGH";
      message?: string;
    };

    const adviceParsed = tryParseJson<Advice>(result?.bedrock?.advice) ?? (typeof result?.bedrock?.advice === "object" ? (result.bedrock.advice as Advice) : null);
    const textParsed =
      tryParseJson<TextSignals>(result?.textSignals) ??
      (typeof result?.textSignals === "object" ? (result.textSignals as TextSignals) : null);

    const safetyParsed =
      tryParseJson<Safety>(result?.safety) ??
      (typeof result?.safety === "object" ? (result.safety as Safety) : null);

    return {
      s3: result?.s3 as { bucket?: string; key?: string } | undefined,
      rekognitionLabels: (result?.rekognition?.labels ?? []) as Array<{ name?: string; confidence?: number; parents?: string[] }>,
      textSignals: textParsed,
      safety: safetyParsed,
      advice: adviceParsed,
      rawAdvice: result?.bedrock?.advice as unknown,
      rawTextSignals: result?.textSignals as unknown
    };
  }, [result]);

  const narrative = useMemo(() => {
    if (!pretty) return null;
    const a = pretty.advice;
    const t = pretty.textSignals;
    const topLabel = pretty.rekognitionLabels?.[0]?.name;

    const lines: string[] = [];
    if (topLabel) lines.push(`Image looks like: ${topLabel}.`);
    if (t?.sentiment?.label) {
      const conf = typeof t.sentiment.confidence === "number" ? ` (~${Math.round(t.sentiment.confidence * 100)}% confidence)` : "";
      lines.push(`Comment sentiment: ${t.sentiment.label}${conf}.`);
    }
    if (t?.key_phrases?.length) lines.push(`Key phrases: ${t.key_phrases.join(", ")}.`);
    if (a?.product_summary) lines.push(`\nAdvice headline: ${a.product_summary}`);

    return lines.join("\n");
  }, [pretty]);

  function validateSelectedFile(f: File) {
    if (!ALLOWED_TYPES.has(f.type)) {
      return `Unsupported file type "${f.type || "unknown"}". Allowed: JPG, PNG, WEBP.`;
    }
    if (f.size > MAX_BYTES) {
      return `File is too large (${bytesToMb(f.size)}). Max allowed is ${bytesToMb(MAX_BYTES)}.`;
    }
    return null;
  }

  function onPickFile(next: File | null) {
    setError(null);
    setResult(null);
    setFile(next);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(next ? URL.createObjectURL(next) : null);
    setChatContext(null);
    setChatHistory([]);
  }

  async function onSubmit() {
    setError(null);
    setResult(null);

    if (!file) {
      setError("Please select an image first.");
      return;
    }
    const validationError = validateSelectedFile(file);
    if (validationError) {
      setError(validationError);
      return;
    }
    if (activeService === "advisor" && !comment.trim()) {
      setError("Please add a short comment about the product.");
      return;
    }

    setIsSubmitting(true);
    try {
      if (activeService === "visual") {
        setChatContext(null);
        setChatHistory([]);
      }

      const fd = new FormData();
      fd.set("image", file);

      const endpoint = activeService === "visual" ? "/api/visual/start" : "/api/analyze";
      if (activeService !== "visual") fd.set("service", activeService);
      if (activeService === "advisor") fd.set("comment", comment.trim());

      const res = await fetch(endpoint, { method: "POST", body: fd });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error || `Request failed with status ${res.status}.`);
        return;
      }
      setResult(data);

      if (activeService === "visual") {
        setChatContext(data?.context ?? null);
        setChatHistory([]);
      }
    } catch (e: any) {
      setError(e?.message || "Unexpected error.");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function sendChat() {
    setError(null);
    const q = chatInput.trim();
    if (!q) return;
    if (!chatContext) {
      setError("Upload an image first to start a visual chat.");
      return;
    }
    if (isSubmitting) return;
    if (isChatSending) return;

    setChatInput("");
    const nextHistory = [...chatHistory, { role: "user" as const, text: q }];
    setChatHistory(nextHistory);

    try {
      setIsChatSending(true);
      const res = await fetch("/api/visual/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: q, context: chatContext, history: nextHistory })
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error || `Chat request failed with status ${res.status}.`);
        return;
      }
      setChatHistory((h: Array<{ role: "user" | "assistant"; text: string }>) => [...h, { role: "assistant", text: data?.answer ?? "" }]);
    } catch (e: any) {
      setError(e?.message || "Unexpected error.");
    } finally {
      setIsChatSending(false);
    }
  }

  return (
    <main className="container">
      <div className="row">
        <section className="card">
          <h1 className="title">
            {activeService === "advisor" ? "Business Advisor" : activeService === "safety" ? "Safety Scan" : "Visual Search + Chat"}
          </h1>
          <p className="subtitle">
            {activeService === "advisor"
              ? "Upload a product image + a short comment. We’ll analyze image + text and return business advice."
              : activeService === "safety"
                ? "Upload a product image. We’ll scan for potentially unsafe content and explain why it was flagged."
                : "Upload an image once, then chat about what’s happening in it (grounded on Rekognition signals)."}
          </p>

          <div className="pill">Max size: 5MB • Allowed: JPG / PNG / WEBP</div>

          <label className="label">Service</label>
          <div style={{ display: "flex", gap: 10 }}>
            <button
              type="button"
              onClick={() => {
                setActiveService("advisor");
                setResult(null);
                setError(null);
              }}
              className="button"
              style={{
                marginTop: 0,
                width: "auto",
                flex: 1,
                padding: "10px 12px",
                background: activeService === "advisor" ? "linear-gradient(180deg, rgba(124, 58, 237, 0.95), rgba(124, 58, 237, 0.65))" : "rgba(0,0,0,0.18)",
                border: "1px solid rgba(255,255,255,0.16)",
                fontWeight: 800
              }}
            >
              Business advisor
            </button>
            <button
              type="button"
              onClick={() => {
                setActiveService("safety");
                setResult(null);
                setError(null);
                setChatContext(null);
                setChatHistory([]);
              }}
              className="button"
              style={{
                marginTop: 0,
                width: "auto",
                flex: 1,
                padding: "10px 12px",
                background: activeService === "safety" ? "linear-gradient(180deg, rgba(124, 58, 237, 0.95), rgba(124, 58, 237, 0.65))" : "rgba(0,0,0,0.18)",
                border: "1px solid rgba(255,255,255,0.16)",
                fontWeight: 800
              }}
            >
              Safety scan
            </button>
            <button
              type="button"
              onClick={() => {
                setActiveService("visual");
                setResult(null);
                setError(null);
                setChatContext(null);
                setChatHistory([]);
              }}
              className="button"
              style={{
                marginTop: 0,
                width: "auto",
                flex: 1,
                padding: "10px 12px",
                background: activeService === "visual" ? "linear-gradient(180deg, rgba(124, 58, 237, 0.95), rgba(124, 58, 237, 0.65))" : "rgba(0,0,0,0.18)",
                border: "1px solid rgba(255,255,255,0.16)",
                fontWeight: 800
              }}
            >
              Visual chat
            </button>
          </div>

          <label className="label" htmlFor="image">
            Product image
          </label>
          <input
            id="image"
            className="input"
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onChange={(e) => onPickFile(e.target.files?.item(0) ?? null)}
          />

          {fileMeta ? (
            <p className="hint">
              Selected: <b>{fileMeta.name}</b> ({fileMeta.type}, {bytesToMb(fileMeta.size)})
            </p>
          ) : (
            <p className="hint">Choose an image to preview and analyze.</p>
          )}

          {previewUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={previewUrl}
              alt="Preview"
              style={{
                width: "100%",
                marginTop: 14,
                borderRadius: 14,
                border: "1px solid rgba(255,255,255,0.12)"
              }}
            />
          ) : null}

          {activeService === "advisor" ? (
            <>
              <label className="label" htmlFor="comment">
                Comment (what should we know about this product?)
              </label>
              <textarea
                id="comment"
                className="textarea"
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder="Example: eco-friendly bamboo phone case for iPhone 15, target price $19.99..."
              />
              <p className="hint">Tip: include target customer, price point, differentiators, and any constraints.</p>
            </>
          ) : (
            <p className="hint" style={{ marginTop: 14 }}>
              {activeService === "safety" ? "No comment needed for safety scan." : "No comment needed. Upload an image to start chatting."}
            </p>
          )}

          {error ? (
            <div style={{ marginTop: 12 }} className="error">
              {error}
            </div>
          ) : null}

          <button className="button" onClick={onSubmit} disabled={isSubmitting}>
            {isSubmitting
              ? "Analyzing…"
              : activeService === "advisor"
                ? "Upload & get advice"
                : activeService === "safety"
                  ? "Upload & scan"
                  : "Upload & start chat"}
          </button>
        </section>

        <aside className="card">
          <h2 className="title" style={{ fontSize: 18, marginBottom: 8 }}>
            Result
          </h2>
          <p className="subtitle" style={{ fontSize: 14, marginBottom: 12 }}>
            {activeService === "advisor"
              ? "Business advisor output."
              : activeService === "safety"
                ? "Safety scan output."
                : "Chat about the uploaded image."}
          </p>

          {activeService === "visual" ? (
            <div className="card" style={{ padding: 14 }}>
              <div
                style={{
                  border: "1px solid rgba(255,255,255,0.14)",
                  borderRadius: 14,
                  padding: 12,
                  background: "rgba(0,0,0,0.18)"
                }}
              >
                <SectionTitle>Chat</SectionTitle>
                <div ref={chatScrollRef} className="card" style={{ padding: 12, maxHeight: 260, overflow: "auto" }}>
                  {chatContext ? (
                    chatHistory.length ? (
                      chatHistory.map((m: { role: "user" | "assistant"; text: string }, idx: number) => (
                        <div key={idx} style={{ marginBottom: 10, color: "rgba(255,255,255,0.9)" }}>
                          <b>{m.role === "user" ? "You" : "AI"}:</b> {m.text}
                        </div>
                      ))
                    ) : (
                      <div style={{ color: "rgba(255,255,255,0.7)" }}>
                        Ask something like “What’s happening here?” or “What objects do you see?”
                      </div>
                    )
                  ) : (
                    <div style={{ color: "rgba(255,255,255,0.7)" }}>Upload an image to start.</div>
                  )}
                  <div ref={chatBottomRef} />
                </div>

                <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
                  <input
                    className="input"
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    placeholder="Type a question…"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") sendChat();
                    }}
                    disabled={!chatContext || isSubmitting || isChatSending}
                  />
                  <button
                    className="button"
                    style={{ width: "auto", marginTop: 0 }}
                    onClick={sendChat}
                    disabled={!chatContext || isSubmitting || isChatSending}
                  >
                    {isChatSending ? "Sending…" : "Send"}
                  </button>
                </div>
                {!chatContext ? (
                  <div className="hint" style={{ marginTop: 10 }}>
                    {isSubmitting ? "Analyzing image… chat will unlock when ready." : "Upload an image to start the chat."}
                  </div>
                ) : null}

                <details style={{ marginTop: 12 }}>
                  <summary style={{ cursor: "pointer", color: "rgba(255,255,255,0.75)" }}>Show image signals</summary>
                  <div className="card resultBox" style={{ padding: 12, marginTop: 10 }}>
                    {JSON.stringify(chatContext, null, 2)}
                  </div>
                </details>
              </div>
            </div>
          ) : pretty ? (
            <div className="card" style={{ padding: 14 }}>
              {activeService === "advisor" ? (
                <div
                  style={{
                    border: "1px solid rgba(255,255,255,0.14)",
                    borderRadius: 14,
                    padding: 12,
                    background: "rgba(0,0,0,0.18)"
                  }}
                >
                  <SectionTitle>Client comment summary</SectionTitle>
                  <div style={{ color: "rgba(255,255,255,0.88)", fontSize: 13, lineHeight: 1.55, whiteSpace: "pre-wrap" }}>
                    {pretty.textSignals?.sentiment?.label
                      ? `Sentiment: ${pretty.textSignals.sentiment.label}${
                          typeof pretty.textSignals.sentiment.confidence === "number"
                            ? ` (~${Math.round(pretty.textSignals.sentiment.confidence * 100)}%)`
                            : ""
                        }\n`
                      : ""}
                    {pretty.textSignals?.key_phrases?.length ? `Key phrases: ${pretty.textSignals.key_phrases.join(", ")}\n` : ""}
                    {pretty.textSignals?.entities?.length
                      ? `Entities: ${pretty.textSignals.entities
                          .map((e: { text?: string; type?: string }) => [e.text, e.type].filter(Boolean).join(" (") + (e.type ? ")" : ""))
                          .join(", ")}\n`
                      : ""}
                    {!pretty.textSignals ? "—\n" : ""}
                  </div>

                  <SectionTitle>Business advice</SectionTitle>
                  {pretty.advice ? (
                    <div style={{ fontSize: 13, lineHeight: 1.55 }}>
                      <div style={{ color: "rgba(255,255,255,0.92)" }}>
                        <b>Advice:</b> {pretty.advice.product_summary || "—"}
                      </div>
                      <div style={{ marginTop: 10 }}>
                        <b>Next steps:</b>
                        <BulletList items={(pretty.advice.next_steps ?? []).slice(0, 4)} />
                      </div>
                    </div>
                  ) : (
                    <div className="resultBox">
                      {typeof pretty.rawAdvice === "string" ? stripCodeFences(pretty.rawAdvice) : JSON.stringify(pretty.rawAdvice, null, 2)}
                    </div>
                  )}
                </div>
              ) : (
                <div
                  style={{
                    border: "1px solid rgba(255,255,255,0.14)",
                    borderRadius: 14,
                    padding: 12,
                    background: "rgba(0,0,0,0.18)"
                  }}
                >
                  <SectionTitle>Unsafe content detection</SectionTitle>
                  <div style={{ color: "rgba(255,255,255,0.88)", fontSize: 13, lineHeight: 1.55 }}>
                    {pretty.safety ? (
                      <>
                        <div>
                          <b>Status:</b>{" "}
                          {pretty.safety.flagged ? (
                            <span style={{ color: "rgba(254,202,202,1)" }}>Flagged ({pretty.safety.severity || "—"})</span>
                          ) : (
                            <span style={{ color: "rgba(187,247,208,1)" }}>Not flagged</span>
                          )}
                        </div>
                        <div style={{ marginTop: 6 }}>
                          <b>Explanation:</b> {pretty.safety.message || "—"}
                        </div>
                      </>
                    ) : (
                      "—"
                    )}
                  </div>
                </div>
              )}

              <details style={{ marginTop: 14 }}>
                <summary style={{ cursor: "pointer", color: "rgba(255,255,255,0.75)" }}>Show raw response</summary>
                <div className="card resultBox" style={{ padding: 12, marginTop: 10 }}>
                  {JSON.stringify(result, null, 2)}
                </div>
              </details>
            </div>
          ) : (
            <div className="card" style={{ padding: 14 }}>
              {activeService === "visual" ? (
                <div
                  style={{
                    border: "1px solid rgba(255,255,255,0.14)",
                    borderRadius: 14,
                    padding: 12,
                    background: "rgba(0,0,0,0.18)"
                  }}
                >
                  <SectionTitle>Chat</SectionTitle>
                  <div style={{ color: "rgba(255,255,255,0.7)", fontSize: 13, lineHeight: 1.55 }}>
                    Upload an image to initialize context, then ask questions about it.
                  </div>
                </div>
              ) : activeService === "advisor" ? (
                <div
                  style={{
                    border: "1px solid rgba(255,255,255,0.14)",
                    borderRadius: 14,
                    padding: 12,
                    background: "rgba(0,0,0,0.18)"
                  }}
                >
                  <SectionTitle>Client comment summary</SectionTitle>
                  <div style={{ color: "rgba(255,255,255,0.7)", fontSize: 13, lineHeight: 1.55 }}>
                    Upload an image + comment to see a short summary here.
                  </div>
                  <SectionTitle>Business advice</SectionTitle>
                  <div style={{ color: "rgba(255,255,255,0.7)", fontSize: 13, lineHeight: 1.55 }}>
                    We’ll generate business advice after analysis.
                  </div>
                </div>
              ) : (
                <div
                  style={{
                    border: "1px solid rgba(255,255,255,0.14)",
                    borderRadius: 14,
                    padding: 12,
                    background: "rgba(0,0,0,0.18)"
                  }}
                >
                  <SectionTitle>Unsafe content detection</SectionTitle>
                  <div style={{ color: "rgba(255,255,255,0.7)", fontSize: 13, lineHeight: 1.55 }}>
                    Upload an image to run a safety scan. We’ll flag potentially unsafe content and explain why.
                  </div>
                </div>
              )}
            </div>
          )}
        </aside>
      </div>
    </main>
  );
}

