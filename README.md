# AWS AI Services

Three AWS-powered services in one small Next.js app:

## Services

### 1) Business advisor

- Upload **image + comment**
- **S3** stores image
- **Rekognition** detects labels (objects/scenes)
- **Bedrock** extracts text signals from the comment (sentiment / entities / key phrases)
- **Bedrock** generates business advice (product summary + next steps)

### 2) Safety scan

- Upload **image only**
- **S3** stores image
- **Rekognition** detects **moderation labels**
- **Bedrock** converts those labels into a short, actionable message, e.g.  
  “This image may contain violence due to detected weapons. Consider restricting visibility.”

### 3) Visual search + chat

- Upload **image once**
- **Rekognition** detects labels (and moderation labels)
- Then you can **chat** about the image; each user question is sent to **Bedrock** with the Rekognition signals as context

## UI

Open `http://localhost:3000` and select a service from the **left panel**:

- **Business advisor**
- **Safety scan**
- **Visual chat**

## Setup

1) Create an S3 bucket (private is fine).

2) Copy env file and fill values:

```bash
cp .env.example .env
```

3) Install & run:

```bash
npm install
npm run dev
```

Then open `http://localhost:3000`.

## AWS permissions

The runtime principal (env creds, AWS profile, or IAM role) needs:

- `s3:PutObject` and `s3:GetObject` on your bucket (and prefix if you use one)
- `rekognition:DetectLabels`
- `rekognition:DetectModerationLabels`
- `bedrock:InvokeModel` for the model configured in `BEDROCK_MODEL_ID`

## Notes

- Allowed image types: **JPEG, PNG, WEBP**
- Max upload size: **5MB**
- The image object is **not made public**; the backend uses a short-lived presigned GET URL.
- Rekognition/Bedrock are **not available in every AWS region**. If you see errors like `ENOTFOUND rekognition.<region>.amazonaws.com`, switch `AWS_REGION` to a supported region (commonly `eu-west-1` or `us-east-1`).

