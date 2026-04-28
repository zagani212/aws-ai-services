import { InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { bedrock } from "@/lib/aws";
import { requiredEnv } from "@/lib/env";

export const runtime = "nodejs";

function jsonError(error: string, status = 400) {
  return Response.json({ error }, { status });
}

function safeJson<T>(s: string): T | null {
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

function extractFirstTextFromBedrockResponse(parsed: any): string | null {
  const t1 = parsed?.content?.[0]?.text;
  if (typeof t1 === "string" && t1.trim()) return t1;
  const t2 = parsed?.output?.message?.content?.[0]?.text;
  if (typeof t2 === "string" && t2.trim()) return t2;
  return null;
}

export async function POST(req: Request) {
  const modelId = requiredEnv("BEDROCK_MODEL_ID");
  const ct = req.headers.get("content-type") || "";
  if (!ct.toLowerCase().includes("application/json")) return jsonError("Expected application/json.", 415);

  const payload = await req.json().catch(() => null) as any;
  if (!payload) return jsonError("Invalid JSON body.");

  const question = typeof payload.question === "string" ? payload.question.trim() : "";
  const context = payload.context;
  const history = Array.isArray(payload.history) ? payload.history : [];
  if (!question) return jsonError("Missing question.");
  if (!context) return jsonError("Missing context.");

  const system = `You are a helpful assistant for "visual search + chat".
You MUST answer using only the provided image signals (Rekognition labels + moderation labels).
If the question cannot be answered from signals, say what additional info is needed.
Keep answers short (1-3 sentences).`;

  const prompt = `Image signals JSON:
${JSON.stringify(context, null, 2)}

Conversation history (most recent last):
${JSON.stringify(history.slice(-8), null, 2)}

User question:
${question}
`;

  const body = JSON.stringify({
    anthropic_version: "bedrock-2023-05-31",
    system,
    max_tokens: 220,
    temperature: 0.3,
    messages: [{ role: "user", content: [{ type: "text", text: prompt }] }]
  });

  const invokeResp = await bedrock.send(
    new InvokeModelCommand({
      modelId,
      contentType: "application/json",
      accept: "application/json",
      body
    })
  );

  const raw = new TextDecoder().decode(invokeResp.body);
  const parsed = safeJson<any>(raw);
  const text = extractFirstTextFromBedrockResponse(parsed) ?? raw;

  return Response.json({ answer: text });
}

