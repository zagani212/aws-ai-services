# AI Product Advisor

A small full-stack Next.js app that:

- Lets a user upload a **product image** and a **comment** (frontend validates size + format)
- Uploads the image to **S3**
- Generates a **presigned GET URL** for the uploaded image
- Sends the image to **Amazon Rekognition** via the **S3 object reference** (bucket + key)
- Uses **Amazon Bedrock** to extract text signals from the comment (sentiment / entities / key phrases)
- Sends the combined signals to **Amazon Bedrock** to generate business advice

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
- `bedrock:InvokeModel` for the model configured in `BEDROCK_MODEL_ID`

## Notes

- Allowed image types: **JPEG, PNG, WEBP**
- Max upload size: **5MB**
- The image object is **not made public**; the backend uses a short-lived presigned GET URL.
- Rekognition/Bedrock are **not available in every AWS region**. If you see errors like `ENOTFOUND rekognition.<region>.amazonaws.com`, switch `AWS_REGION` to a supported region (commonly `eu-west-1` or `us-east-1`).

