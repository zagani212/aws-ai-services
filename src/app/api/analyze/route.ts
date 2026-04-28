import { InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { DetectLabelsCommand, DetectModerationLabelsCommand } from "@aws-sdk/client-rekognition";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { bedrock, rekognition, s3 } from "@/lib/aws";
import { optionalEnv, requiredEnv } from "@/lib/env";
import crypto from "node:crypto";

export const runtime = "nodejs";

const MAX_BYTES = 5 * 1024 * 1024; // 5MB
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

function jsonError(error: string, status = 400) {
  return Response.json({ error }, { status });
}

function guessExtension(mime: string) {
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/png") return "png";
  if (mime === "image/webp") return "webp";
  return "bin";
}

async function readFileFromFormData(fd: FormData, field: string) {
  const v = fd.get(field);
  if (!v) return null;
  if (typeof v === "string") return null;
  return v as File;
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
  const bucket = requiredEnv("S3_BUCKET_NAME");
  const prefix = optionalEnv("S3_KEY_PREFIX", "uploads")?.replace(/^\/+|\/+$/g, "") || "uploads";
  const modelId = requiredEnv("BEDROCK_MODEL_ID");

  const ct = req.headers.get("content-type") || "";
  if (!ct.toLowerCase().includes("multipart/form-data")) {
    return jsonError("Expected multipart/form-data.", 415);
  }

  const fd = await req.formData();
  const serviceRaw = fd.get("service");
  const service = serviceRaw === "safety" || serviceRaw === "advisor" ? serviceRaw : "advisor";

  const commentRaw = fd.get("comment");
  const comment = typeof commentRaw === "string" ? commentRaw.trim() : "";
  if (service === "advisor" && !comment) return jsonError("Missing comment.");

  const image = await readFileFromFormData(fd, "image");
  if (!image) return jsonError("Missing image file.");

  if (!ALLOWED_TYPES.has(image.type)) {
    return jsonError(`Unsupported image type "${image.type || "unknown"}". Allowed: image/jpeg, image/png, image/webp.`);
  }
  if (image.size > MAX_BYTES) {
    return jsonError(`Image too large. Max is ${MAX_BYTES} bytes.`);
  }

  const bytes = Buffer.from(await image.arrayBuffer());
  if (bytes.length !== image.size) {
    return jsonError("Upload corrupted (size mismatch).", 400);
  }

  const sha = crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  const ext = guessExtension(image.type);
  const objectKey = `${prefix}/${Date.now()}-${sha}.${ext}`;

  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: objectKey,
      Body: bytes,
      ContentType: image.type,
      Metadata: {
        ...(comment ? { comment } : {})
      }
    })
  );

  // Presigned URL used to fetch the image securely without making the object public.
  const presignedGetUrl = await getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: bucket,
      Key: objectKey
    }),
    { expiresIn: 60 * 10 }
  );

  // Rekognition does not accept HTTP URLs; provide S3 object reference (no download needed).
  const labelsResp = await rekognition.send(
    new DetectLabelsCommand({
      Image: { S3Object: { Bucket: bucket, Name: objectKey } },
      MaxLabels: 15,
      MinConfidence: 70
    })
  );

  const moderationResp = await rekognition.send(
    new DetectModerationLabelsCommand({
      Image: { S3Object: { Bucket: bucket, Name: objectKey } },
      MinConfidence: 60
    })
  );

  const labelItems = (labelsResp.Labels ?? []) as Array<{
    Name?: string;
    Confidence?: number;
    Parents?: Array<{ Name?: string }>;
  }>;

  const labels = labelItems.map((l) => ({
    name: l.Name ?? "",
    confidence: l.Confidence ?? 0,
    parents: (l.Parents ?? []).map((p) => p.Name ?? "").filter(Boolean)
  }));

  const moderationItems = (moderationResp.ModerationLabels ?? []) as Array<{
    Name?: string;
    ParentName?: string;
    Confidence?: number;
  }>;

  const moderationLabels = moderationItems.map((m) => ({
    name: m.Name ?? "",
    parentName: m.ParentName ?? "",
    confidence: m.Confidence ?? 0
  }));

  // Bedrock: explain safety concerns based on Rekognition moderation labels.
  const safetyPrompt = `You are a content safety assistant for an e-commerce app.

Given the moderation labels detected in an image, decide if it should be flagged.

Return STRICT JSON:
{
  "flagged": boolean,
  "severity": "LOW"|"MEDIUM"|"HIGH",
  "message": string
}

Rules:
- If labels indicate violence/weapons, explicit nudity, sexual content, self-harm, drugs, hate symbols, or graphic content => flagged=true.
- The message must be short and actionable, like:
  "This image may contain violence due to detected weapons. Consider restricting visibility."

Moderation labels JSON:
${JSON.stringify(moderationLabels, null, 2)}
`;

  const safetyBody = JSON.stringify({
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: 220,
    temperature: 0,
    messages: [{ role: "user", content: [{ type: "text", text: safetyPrompt }] }]
  });

  const safetyInvoke = await bedrock.send(
    new InvokeModelCommand({
      modelId,
      contentType: "application/json",
      accept: "application/json",
      body: safetyBody
    })
  );

  const safetyRaw = new TextDecoder().decode(safetyInvoke.body);
  const safetyParsed = safeJson<any>(safetyRaw);
  const safetyText = extractFirstTextFromBedrockResponse(safetyParsed);
  const safetyJson = safetyText ? safeJson<any>(safetyText) : null;

  if (service === "safety") {
    return Response.json({
      service,
      s3: { bucket, key: objectKey },
      presignedGetUrlExpiresInSeconds: 600,
      moderation: { labels: moderationLabels },
      safety: safetyJson ?? safetyText ?? safetyParsed
    });
  }

  // Advisor service: Bedrock extracts text signals from the user's comment.
  const textSignalsPrompt = `Extract structured NLP signals from the following product comment.

Return STRICT JSON:
{
  "language": string,
  "sentiment": { "label": "POSITIVE"|"NEUTRAL"|"NEGATIVE"|"MIXED"|"UNKNOWN", "confidence": number },
  "key_phrases": string[],
  "entities": { "text": string, "type": string }[]
}

Comment:
${JSON.stringify(comment)}
`;

  const textSignalsBody = JSON.stringify({
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: 400,
    temperature: 0,
    messages: [{ role: "user", content: [{ type: "text", text: textSignalsPrompt }] }]
  });

  const textSignalsInvoke = await bedrock.send(
    new InvokeModelCommand({
      modelId,
      contentType: "application/json",
      accept: "application/json",
      body: textSignalsBody
    })
  );

  const textSignalsRaw = new TextDecoder().decode(textSignalsInvoke.body);
  const textSignalsParsed = safeJson<any>(textSignalsRaw);
  const textSignalsText = extractFirstTextFromBedrockResponse(textSignalsParsed);
  const textSignals = textSignalsText ? safeJson<any>(textSignalsText) : null;

  // Bedrock: ask for business advice based on all signals.
  const bedrockInput = {
    comment,
    image: {
      contentType: image.type,
      sizeBytes: image.size,
      s3: { bucket, key: objectKey }
    },
    rekognition: { labels },
    rekognition_moderation: moderationLabels,
    bedrock_text_signals: textSignals ?? textSignalsText ?? textSignalsParsed
  };

  const prompt = `You are a product strategy expert. Given the following JSON signals about a product image and a user comment, provide concise business advice.

Return STRICT JSON with this schema:
{
  "product_summary": string,
  "target_customer": string,
  "positioning": string,
  "pricing_hint": string,
  "key_benefits": string[],
  "risks": string[],
  "improvements": string[],
  "marketing_angles": string[],
  "next_steps": string[]
}

Signals JSON:
${JSON.stringify(bedrockInput, null, 2)}
`;

  const body = JSON.stringify({
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: 700,
    temperature: 0.4,
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
  const modelText = extractFirstTextFromBedrockResponse(parsed);
  const adviceJson = modelText ? safeJson<any>(modelText) : null;

  return Response.json({
    service,
    s3: { bucket, key: objectKey },
    presignedGetUrlExpiresInSeconds: 600,
    rekognition: { labels },
    moderation: { labels: moderationLabels },
    safety: safetyJson ?? safetyText ?? safetyParsed,
    textSignals: textSignals ?? textSignalsText ?? textSignalsParsed,
    bedrock: {
      modelId,
      rawResponse: parsed,
      advice: adviceJson ?? modelText
    }
  });
}

