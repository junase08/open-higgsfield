#!/usr/bin/env node
// Standalone CLI that talks to the Higgsfield platform API the same way
// src/generation/{platform,to-platform,credentials}.ts do, without going
// through the Next.js server or browser. Lets a prompt be turned into a
// finished video/image file from the command line.
//
// Usage:
//   HF_API_BASE_URL=https://platform.higgsfield.ai HF_API_KEY=id:secret \
//     node scripts/higgsfield-generate.mjs \
//       --model seedance-2 \
//       --prompt "a small red fox sitting in a snowy forest, cinematic lighting" \
//       --resolution 720p --duration 5 --aspect 16:9 \
//       [--image https://.../start-frame.jpg] [--end-image https://...] \
//       [--no-audio] [--out ./output]

import { parseArgs } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const SEEDANCE_PATHS = {
  "seedance-2": "bytedance/seedance-2.0",
  "seedance-2-fast": "bytedance/seedance-2.0/fast",
  "seedance-2-mini": "bytedance/seedance-2.0/mini",
  "seedance-2.5": "bytedance/seedance-2.5",
};

function usageError(message) {
  console.error(`Error: ${message}\n`);
  console.error("Required: --model <seedance-2|seedance-2-fast|seedance-2-mini|seedance-2.5> --prompt \"...\"");
  process.exit(1);
}

const { values: args } = parseArgs({
  options: {
    model: { type: "string", default: "seedance-2" },
    prompt: { type: "string" },
    resolution: { type: "string", default: "720p" },
    duration: { type: "string", default: "5" },
    aspect: { type: "string", default: "16:9" },
    image: { type: "string" }, // start frame -> image-to-video
    "end-image": { type: "string" },
    "no-audio": { type: "boolean", default: false },
    out: { type: "string", default: "./output" },
    "poll-seconds": { type: "string", default: "4" },
    "timeout-minutes": { type: "string", default: "10" },
  },
});

if (!args.prompt) usageError("--prompt is required");
const modelPrefix = SEEDANCE_PATHS[args.model];
if (!modelPrefix) usageError(`unknown --model "${args.model}" (known: ${Object.keys(SEEDANCE_PATHS).join(", ")})`);

const baseUrl = (process.env.HF_API_BASE_URL ?? "").replace(/\/$/, "");
const apiKey = process.env.HF_API_KEY ?? "";
if (!baseUrl) usageError("set HF_API_BASE_URL (e.g. https://platform.higgsfield.ai)");
if (!apiKey || apiKey.indexOf(":") <= 0) usageError("set HF_API_KEY as id:secret");

const auth = `Key ${apiKey}`;

async function send(method, requestPath, body) {
  const url = `${baseUrl}${requestPath}`;
  const response = await fetch(url, {
    method,
    headers: { Authorization: auth, ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const detail = payload && typeof payload === "object" ? payload.detail : undefined;
    throw new Error(`${method} ${requestPath} -> ${response.status}: ${detail ?? text}`);
  }
  return payload;
}

function buildRequest() {
  const shared = {
    prompt: args.prompt,
    resolution: args.resolution,
    generate_audio: !args["no-audio"],
    duration: Number(args.duration),
  };
  if (args.image) {
    return {
      requestPath: `/${modelPrefix}/image-to-video`,
      body: { ...shared, image_url: args.image, ...(args["end-image"] ? { end_image_url: args["end-image"] } : {}) },
    };
  }
  return {
    requestPath: `/${modelPrefix}/text-to-video`,
    body: { ...shared, aspect_ratio: args.aspect },
  };
}

async function main() {
  const { requestPath, body } = buildRequest();
  console.log(`Submitting to ${baseUrl}${requestPath}`);
  console.log(body);

  const queued = await send("POST", requestPath, body);
  const requestId = queued.request_id;
  if (!requestId) throw new Error(`Platform response missing request_id: ${JSON.stringify(queued)}`);
  console.log(`Queued: request_id=${requestId} status=${queued.status ?? "queued"}`);

  const pollMs = Number(args["poll-seconds"]) * 1000;
  const deadline = Date.now() + Number(args["timeout-minutes"]) * 60_000;
  const TERMINAL = new Set(["completed", "succeeded", "failed", "error", "canceled", "cancelled", "nsfw"]);

  let final;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    const statusPayload = await send("GET", `/requests/${encodeURIComponent(requestId)}/status`);
    console.log(`status: ${statusPayload.status}`);
    if (TERMINAL.has(statusPayload.status)) {
      final = statusPayload;
      break;
    }
  }
  if (!final) throw new Error("Timed out waiting for a terminal status");
  if (final.status !== "completed" && final.status !== "succeeded") {
    throw new Error(`Generation ended with status "${final.status}": ${JSON.stringify(final.error ?? final)}`);
  }

  const mediaUrl = final.video?.url ?? final.images?.[0]?.url;
  if (!mediaUrl) throw new Error(`No media url in final status: ${JSON.stringify(final)}`);

  await mkdir(args.out, { recursive: true });
  const ext = mediaUrl.split("?")[0].split(".").pop() || "mp4";
  const filePath = path.join(args.out, `${requestId}.${ext}`);
  const mediaResponse = await fetch(mediaUrl);
  if (!mediaResponse.ok) throw new Error(`Failed to download media: ${mediaResponse.status}`);
  await writeFile(filePath, Buffer.from(await mediaResponse.arrayBuffer()));
  console.log(`Saved: ${filePath}`);
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
