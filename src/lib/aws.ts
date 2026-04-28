import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { RekognitionClient } from "@aws-sdk/client-rekognition";
import { S3Client } from "@aws-sdk/client-s3";
import { requiredEnv } from "@/lib/env";

const region = requiredEnv("AWS_REGION");

export const s3 = new S3Client({ region });
export const rekognition = new RekognitionClient({ region });
export const bedrock = new BedrockRuntimeClient({ region });

