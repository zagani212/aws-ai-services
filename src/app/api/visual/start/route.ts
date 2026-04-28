import { DetectLabelsCommand, DetectModerationLabelsCommand } from "@aws-sdk/client-rekognition";
import { InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { PutObjectCommand } from "@aws-sdk/client-s3";
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
  if (!ct.toLowerCase().includes("multipart/form-data")) return jsonError("Expected multipart/form-data.", 415);

  const fd = await req.formData();
  const image = await readFileFromFormData(fd, "image");
  if (!image) return jsonError("Missing image file.");
  if (!ALLOWED_TYPES.has(image.type)) return jsonError(`Unsupported image type "${image.type || "unknown"}".`);
  if (image.size > MAX_BYTES) return jsonError(`Image too large. Max is ${MAX_BYTES} bytes.`);

  const bytes = Buffer.from(await image.arrayBuffer());
  const sha = crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  const ext = guessExtension(image.type);
  const objectKey = `${prefix}/${Date.now()}-${sha}.${ext}`;

  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: objectKey, Body: bytes, ContentType: image.type }));

  const [labelsResp, moderationResp] = await Promise.all([
    rekognition.send(
      new DetectLabelsCommand({
        Image: { S3Object: { Bucket: bucket, Name: objectKey } },
        MaxLabels: 20,
        MinConfidence: 70
      })
    ),
    rekognition.send(
      new DetectModerationLabelsCommand({
        Image: { S3Object: { Bucket: bucket, Name: objectKey } },
        MinConfidence: 60
      })
    )
  ]);

  const labels = (labelsResp.Labels ?? []).map((l) => ({
    name: l.Name ?? "",
    confidence: l.Confidence ?? 0
  }));

  const moderation = (moderationResp.ModerationLabels ?? []).map((m) => ({
    name: m.Name ?? "",
    parentName: m.ParentName ?? "",
    confidence: m.Confidence ?? 0
  }));

  const prompt = `You are an assistant that answers questions about an image using ONLY the provided signals (no guessing beyond them).

Return STRICT JSON:
{
  "image_understanding": string,
  "suggested_questions": string[]
}

Signals:
${JSON.stringify({ rekognition_labels: labels, moderation_labels: moderation }, null, 2)}
`;

  const body = JSON.stringify({
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: 350,
    temperature: 0.2,
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
  const text = extractFirstTextFromBedrockResponse(parsed);
  const json = text ? safeJson<any>(text) : null;

  return Response.json({
    s3: { bucket, key: objectKey },
    context: {
      rekognition: { labels },
      moderation: { labels: moderation }
    },
    bedrock: {
      imageUnderstanding: json ?? text ?? parsed
    }
  });
}

