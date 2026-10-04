// One-shot bucket preparation for the opt-in `offline` Compose profile (research D4).
// Creates the bucket if missing and applies an anonymous-read policy so Instagram/Threads
// can fetch media by public URL. Idempotent; never logs credentials.
import { pathToFileURL } from "node:url";
import { CreateBucketCommand, PutBucketPolicyCommand, S3Client } from "@aws-sdk/client-s3";

const ALREADY_EXISTS = new Set(["BucketAlreadyOwnedByYou", "BucketAlreadyExists"]);

export function publicReadPolicy(bucket) {
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: "*",
        Action: ["s3:GetObject"],
        Resource: [`arn:aws:s3:::${bucket}/*`],
      },
    ],
  });
}

/** Creates `bucket` if missing and applies the anonymous-read policy. Safe to run repeatedly. */
export async function ensureBucket({ client, bucket, log = console.log }) {
  try {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
    log(`Docket: created bucket ${bucket}`);
  } catch (e) {
    const name = e && typeof e === "object" ? (e.name ?? e.Code) : undefined;
    if (!ALREADY_EXISTS.has(name)) throw e;
    log(`Docket: bucket ${bucket} already exists`);
  }
  await client.send(new PutBucketPolicyCommand({ Bucket: bucket, Policy: publicReadPolicy(bucket) }));
  log(`Docket: anonymous-read policy applied to ${bucket}`);
}

export function clientFromEnv(env) {
  return new S3Client({
    region: env.S3_REGION || "us-east-1",
    endpoint: env.S3_ENDPOINT || undefined,
    forcePathStyle: env.S3_FORCE_PATH_STYLE === "true",
    credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY },
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY } = process.env;
  if (!S3_BUCKET || !S3_ACCESS_KEY_ID || !S3_SECRET_ACCESS_KEY) {
    console.error("Docket: storage-init needs S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY");
    process.exit(1);
  }
  try {
    await ensureBucket({ client: clientFromEnv(process.env), bucket: S3_BUCKET });
  } catch (e) {
    const name = e && typeof e === "object" ? e.name : undefined;
    console.error(`Docket: storage-init failed${name ? ` (${name})` : ""}`);
    process.exit(1);
  }
}
