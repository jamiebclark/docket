# LLM providers and S3-compatible storage: research notes

Researched 2026-10-03. Sources are official docs, GitHub repos and the npm registry only. Anything not confirmed is marked **UNVERIFIED**.
Target: Node 24 TypeScript server, Zod-validated structured JSON, optional image input, provider-agnostic interface, model names from env.

## 1. OpenAI Node SDK (`openai`)

- **Version**: 7.27.0 (npm `latest`). Node engine `>=22.0.0`. Optional peer dep `zod` `^3.25 || ^4.0`. Source: https://registry.npmjs.org/openai/latest
- **Responses vs Chat Completions**
  - Responses is recommended for all new projects. Chat Completions is not deprecated and remains supported. Source: https://developers.openai.com/api/docs/guides/migrate-to-responses
  - Structured output parameter: Chat Completions uses `response_format`; Responses uses `text.format`. Same source.
  - The structured outputs guide recommends the Responses API for structuring model output. Source: https://developers.openai.com/api/docs/guides/structured-outputs
  - The README also recommends Responses for text generation. Source: https://github.com/openai/openai-node
- **Structured outputs (raw JSON schema)**
  - Form: `text: { format: { type: "json_schema", strict: true, schema: {...} } }`. Source: https://developers.openai.com/api/docs/guides/structured-outputs
  - Constraints: all fields required, `additionalProperties: false`. Same source.
  - Refusals appear as a distinct `refusal` field. Incomplete responses (max tokens) must be handled. Same source.
- **Zod helper**
  - Import `zodTextFormat` from `openai/helpers/zod`, then call `client.responses.parse({ model, input, text: { format: zodTextFormat(Schema, "name") } })`. The validated value is `response.output_parsed`. Source: https://developers.openai.com/api/docs/guides/structured-outputs
  - `zodResponseFormat` is the Chat Completions counterpart. The docs page I fetched shows no Chat Completions example. I take the name from my own knowledge of the SDK. **UNVERIFIED**
  - **Zod 4: yes.** The helpers accept schemas imported from `zod/v3`, `zod/v4` and `zod/v4-mini`; use the import matching your app's Zod. Source: https://github.com/openai/openai-node/blob/main/docs/structured-outputs.md
  - Earlier zodTextFormat breakage with Zod 4 is tracked in https://github.com/openai/openai-node/issues/1602. The search summary says it is fixed; I did not confirm the fix against the issue itself. **UNVERIFIED**
  - Caveats: object properties must be required. Use `.nullable()`, not `.optional()`, for absent values. Refinements, transforms, pipelines, `Date`, `BigInt`, `Map`, `Set` cannot be represented. Source: https://github.com/openai/openai-node/blob/main/docs/structured-outputs.md
  - Always re-validate with your own Zod schema anyway. The provider-agnostic layer needs this for Anthropic, where the schema is lossy (see section 2).
- **Image input (Responses API)**
  - Three forms: fully qualified URL, Base64 data URL, or a Files API file ID. Source: https://developers.openai.com/api/docs/guides/images-vision
  - Content part shape: `{ type: "input_image", image_url: "https://..." | "data:image/png;base64,..." }`. This shape comes from my own knowledge, not the fetched page. **UNVERIFIED**
  - Formats: PNG, JPEG, WEBP, non-animated GIF. Source: https://developers.openai.com/api/docs/guides/images-vision
  - Limits: up to 512 MB total payload per request, up to 1,500 images per request. Same source.
  - Images over 30,000 patches after processing are rejected. Same source.
  - `detail`: `low`, `high`, `original` or `auto` (default `auto`). Same source.
  - A per-image byte limit was not stated on the fetched page. **UNVERIFIED**
  - Whether OpenAI fetches the URL server-side, and any rules on URL reachability, are not stated on the fetched page. **UNVERIFIED**
- **Client options**
  - Timeout default is 10 minutes; set with the `timeout` option on the client or per request. Source: https://github.com/openai/openai-node
  - `maxRetries` defaults to 2, with short exponential backoff. Retried: connection errors, 408, 429, 5xx. Same source.
- **Error classes** (from the README; other statuses not enumerated there)
  - 400 `BadRequestError`
  - 401 `AuthenticationError`
  - 429 `RateLimitError`
  - 5xx `InternalServerError`
  - Base class `APIError`. Source: https://github.com/openai/openai-node
  - Likely `PermissionDeniedError`, `NotFoundError`, `UnprocessableEntityError`, `APIConnectionError` and `APIConnectionTimeoutError` also exist, mirroring the Anthropic SDK. Not confirmed from the OpenAI source. **UNVERIFIED**
- **Current flagship model IDs** (listed only; from the models page). Source: https://developers.openai.com/api/docs/models
  - `gpt-6-astra`
  - `gpt-6.1-sol`
  - `gpt-6-luna`
  - The SDK structured-outputs doc example uses `gpt-5.5`, which may be an older model. Source: https://github.com/openai/openai-node/blob/main/docs/structured-outputs.md
  - The models page was summarised by the fetch tool; check exact IDs and the full list before hardcoding anything. **UNVERIFIED** (partially)

## 2. Anthropic TypeScript SDK (`@anthropic-ai/sdk`)

- **Version**: 0.131.0 (npm `latest`). Optional peer dep `zod` `^3.25.0 || ^4.0.0`. No `engines` field surfaced. Source: https://registry.npmjs.org/@anthropic-ai/sdk/latest
- **Runtime**: Node.js 20 LTS or later, TypeScript >= 5.0. Source: https://platform.claude.com/docs/en/api/sdks/typescript
- **Messages API**: `client.messages.create({ model, max_tokens, messages })`. `max_tokens` is required. Source: same page.
- **Structured outputs: native JSON schema exists.**
  - Parameter is `output_config: { format: { type: "json_schema", schema } }`. The older `output_format` parameter is deprecated and needs the beta header `structured-outputs-2025-11-13`. Source: https://platform.claude.com/docs/en/build-with-claude/structured-outputs
  - Strict tool use (`strict: true` on tools) is the alternative. Same source.
  - Supported models listed there include the Opus 5.x, Sonnet 5.x, Haiku 4.5 and Fable/Mythos families. Same source.
  - Tool-use forcing with `tool_choice` still works as a fallback for models without native support. **UNVERIFIED** (not on the page I fetched).
  - Schema limits:
    - No recursive schemas.
    - No `minimum`/`maximum`/`multipleOf`.
    - No `minLength`/`maxLength`.
    - `minItems` only 0 or 1.
    - No external `$ref`.
    - Supported: `enum`, `const`, `anyOf`, `allOf`, `$ref`, string formats.
  - Complexity limits: 20 strict tools per request, 24 optional parameters total, 16 parameters with union types. Same source.
  - First request compiles a grammar (extra latency); grammars are cached for 24 hours. Schema tokens count as input. Same source.
  - `stop_reason: "refusal"` means output may not match the schema. Same source.
  - Because of the schema limits above, keep a Zod `.parse()` on the result for constraints the schema cannot express.
- **Zod helper**
  - `import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod"`.
  - Usage: `client.messages.parse({ ..., output_config: { format: zodOutputFormat(Schema) } })`. The result is `response.parsed_output`. Source: https://platform.claude.com/docs/en/build-with-claude/structured-outputs
  - Zod 4 support: the peer range includes `^4.0.0` (registry source above). Whether the helper handles v4 schemas well was not tested. **UNVERIFIED**
  - Separate tool helper `betaZodTool` lives in `@anthropic-ai/sdk/helpers/beta/zod`. Source: https://platform.claude.com/docs/en/api/sdks/typescript
- **Image input**
  - Block: `{ type: "image", source: ... }`. Source types are `base64` (`media_type` + `data`), `url` (`url`) and `file` (`file_id`, Files API). Source: https://platform.claude.com/docs/en/build-with-claude/vision
  - Formats: JPEG, PNG, GIF, WebP (`image/jpeg`, `image/png`, `image/gif`, `image/webp`). Animated GIFs use the first frame only. Same source.
  - Max 10 MB per image (base64-encoded) on the direct API. 5 MB on Bedrock and Google Cloud. Max 8000x8000 px. Same source.
  - Per-request image count: 100 for models with a 200k context window, 600 for all others. Above 20 images per request, a stricter per-image dimension limit applies; keep each image under 2000 px or the request at 20 images or fewer. Same source.
  - Request size limit is 32 MB for standard endpoints. Same source.
  - On Bedrock and Google Cloud only base64 sources are available. Same source.
  - Recommendation: put images before text. Same source.
  - Whether Anthropic's URL fetch has additional constraints (redirects, auth, content-type checks) is not stated on the fetched page. **UNVERIFIED**
- **Retries and timeouts** (source: https://platform.claude.com/docs/en/api/sdks/typescript)
  - `maxRetries` default is 2. Retried: connection errors, 408, 409, 429, >=500.
  - `timeout` default is 10 minutes. For non-streaming requests with a large `max_tokens`, the default is computed dynamically, up to 60 minutes.
  - The SDK throws if a non-streaming request is expected to exceed roughly 10 minutes.
  - Configure per client (`new Anthropic({ timeout, maxRetries })`) or per request (second argument).
  - Timeouts throw `APIConnectionTimeoutError` and are retried.
- **Error classes** (same source)
  - Base class `Anthropic.APIError`.
  - 400 `BadRequestError`
  - 401 `AuthenticationError`
  - 403 `PermissionDeniedError`
  - 404 `NotFoundError`
  - 409 `ConflictError`
  - 422 `UnprocessableEntityError`
  - 429 `RateLimitError`
  - >=500 `InternalServerError`
  - N/A `APIConnectionError`
  - `_request_id` is available on responses.
- **Current model IDs** (listed only). Source: https://platform.claude.com/docs/en/about-claude/models/overview
  - `claude-fable-5-1`
  - `claude-opus-5-5`
  - `claude-sonnet-5-5`
  - `claude-haiku-4-5-20251001` (alias `claude-haiku-4-5`)
  - Legacy but available: Fable 5, Opus 5, Opus 4.8/4.7/4.6/4.5, Sonnet 5, Sonnet 4.6.
  - The structured-outputs page also names `claude-mythos-5-1`. Source: https://platform.claude.com/docs/en/build-with-claude/structured-outputs
  - The overview page says Haiku 4.5 retirement is "not sooner than October 15, 2026". Same overview page.

## 3. S3-compatible storage (AWS SDK v3)

- **Versions** (npm `latest`):
  - `@aws-sdk/client-s3` 3.1146.0, Node `>=20`. Source: https://registry.npmjs.org/@aws-sdk/client-s3/latest
  - `@aws-sdk/s3-request-presigner` 3.1146.0. Source: https://registry.npmjs.org/@aws-sdk/s3-request-presigner/latest
  - Keep the two on the same version.
- **Cloudflare R2 client config** (source: https://developers.cloudflare.com/r2/examples/aws/aws-sdk-js-v3/)
  ```ts
  new S3Client({
    region: "auto",
    endpoint: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
  ```
  - The `auto` region is required by the SDK but unused by R2. R2 also treats an empty region or `us-east-1` as `auto`. Source: https://developers.cloudflare.com/r2/api/s3/api/
  - `forcePathStyle` is not mentioned on the Cloudflare SDK page. **Verified 2026-10-04** against a real R2 bucket: with `forcePathStyle: false` (virtual-host style, `<bucket>.<ACCOUNT_ID>.r2.cloudflarestorage.com`) and the `WHEN_REQUIRED` checksum settings below, PutObject, DeleteObject and ListObjectsV2 all succeeded, and the object was served publicly with HTTP 200 from the bucket's custom domain.
- **PutObject on R2**
  - Supported headers: Content-Type, Cache-Control, Content-Disposition, Content-Encoding, Content-Language, Expires, Content-MD5.
  - Storage classes: STANDARD and STANDARD_IA.
  - Unsupported: object lock, tagging, ACL headers, website redirect, SSE-KMS key id. SSE-C is supported. Source: https://developers.cloudflare.com/r2/api/s3/api/
  - Do not send `ACL: "public-read"`; public access is configured on the bucket instead.
- **Presigned URLs** (source: https://developers.cloudflare.com/r2/api/s3/presigned-urls/)
  - GET, HEAD, PUT and DELETE are supported. POST (multipart form upload) is not.
  - Expiry from 1 second to 7 days (604,800 s).
  - Works only on the S3 API domain `<ACCOUNT_ID>.r2.cloudflarestorage.com`, not on custom domains.
  - Cloudflare advises restricting `ContentType` on PUT presigns and configuring CORS if browsers use the URLs.
  - SDK usage: `getSignedUrl(client, new GetObjectCommand({ Bucket, Key }), { expiresIn: 3600 })`. Source: https://developers.cloudflare.com/r2/examples/aws/aws-sdk-js-v3/
- **Checksum issue: real and documented**
  - From `@aws-sdk/client-s3` v3.729.0 the default changed: checksums on Put calls and validation on Get calls (`requestChecksumCalculation` / `responseChecksumValidation` default `WHEN_SUPPORTED`). Setting both to `WHEN_REQUIRED` opts out. Source: https://github.com/aws/aws-sdk-js-v3/issues/6810
  - Cloudflare's R2 SDK page says 3.729.0 introduced a default checksum change that is incompatible with R2. The fix is to add both settings to the S3Client config, or pin 3.726.1. Source: search summary of https://developers.cloudflare.com/r2/examples/aws/aws-sdk-js-v3/. The fetched page body did not contain these words, so I could not confirm the wording on the page itself. **UNVERIFIED**
  - Presigned PutObject URLs may embed an empty-body CRC32 checksum, which breaks the real upload. Evidence is third-party GitHub PRs and issues only, not official docs. **UNVERIFIED**
  - Recommended config for R2 and MinIO:
    ```ts
    new S3Client({
      region: "auto",
      endpoint,
      credentials,
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
    ```
  - The option and env-var names for the shared-config route are in https://docs.aws.amazon.com/sdkref/latest/guide/feature-dataintegrity.html (linked from issue 6810; not fetched).
- **MinIO**
  - `forcePathStyle: true` is the standard setting, so bucket names are not resolved as subdomains. I could not confirm this from official MinIO docs; the MinIO page fetched covers only the MinIO JS client. **UNVERIFIED**
  - Use any region string (for example `us-east-1`) and your MinIO endpoint URL.
  - Older MinIO releases may reject the default checksums; use the same `WHEN_REQUIRED` settings. Third-party reports only. **UNVERIFIED**
- **Making R2 objects publicly fetchable** (source: https://developers.cloudflare.com/r2/buckets/public-buckets/)
  - r2.dev managed subdomain:
    - Enable in bucket Settings, under Public Development URL, then type `allow`.
    - Rate-limited and meant for development only.
  - Custom domain (recommended for production):
    - The domain must be a zone on Cloudflare. Add it under Custom Domains in bucket Settings and wait for status Active.
    - It supports caching, WAF and Bot Management.
    - By default only certain file types are cached; a Cache Everything rule is needed to cache all objects.
  - Presigned URLs do not work on custom domains (see above). Use a public custom domain for stable public image URLs. Use presigned GET on the S3 domain only for time-limited private links.
  - Meta fetching specifics are out of scope here and not researched. **UNVERIFIED** whether Meta accepts r2.dev URLs, rate-limits them, or needs particular headers.
  - Confirm that public URLs return a correct `Content-Type` (set it on PutObject), and that they are reachable without redirects.

## Open items

- OpenAI per-image byte limit, URL-fetch constraints and the full error class list were not confirmed.
- Anthropic `zodOutputFormat` behaviour with Zod 4 schemas was not tested; check by trying it with the installed `zod` version.
- MinIO `forcePathStyle` and checksum behaviour need a quick integration test. (R2 was verified on 2026-10-04; see above.)
- The OpenAI models page was summarised by the fetch tool; recheck exact IDs before use.
