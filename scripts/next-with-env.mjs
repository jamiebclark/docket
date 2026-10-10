// Runs the Next.js CLI with .env loaded first, so PORT in .env reaches `next dev` and `next start`.
// Next reads .env itself, but only after the server has bound its port. Variables already set in
// the shell win over .env. `node --env-file` is not an option: `next dev` passes the parent's node
// flags to its child through NODE_OPTIONS, where Node rejects --env-file.
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

if (existsSync(".env")) process.loadEnvFile(".env");

const nextBin = createRequire(import.meta.url).resolve("next/dist/bin/next");
process.argv = [process.argv[0], nextBin, ...process.argv.slice(2)];
// `resolve` returns a filesystem path, and on Windows that is `C:\…`, which the ESM loader
// rejects as an unsupported URL scheme ("protocol 'c:'"). argv keeps the plain path; only the
// import needs the file:// form.
await import(pathToFileURL(nextBin).href);
