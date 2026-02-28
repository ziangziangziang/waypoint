import test from "node:test";
import assert from "node:assert/strict";
import os from "os";
import path from "path";
import { promises as fs } from "fs";
import {
  imageDataUrlFromPath,
  parseImageUnderstandingText,
} from "../src/services/imageUnderstanding";

test("imageDataUrlFromPath reads bytes and builds data URL", async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "waypoint-img-understand-"));
  const filePath = path.join(baseDir, "sample.png");
  await fs.writeFile(filePath, Buffer.from([1, 2, 3, 4]));

  const dataUrl = await imageDataUrlFromPath(filePath);
  assert.match(dataUrl, /^data:image\/png;base64,/);
});

test("parseImageUnderstandingText handles plain text fallback", () => {
  const result = parseImageUnderstandingText("A red stop sign on a city street.");
  assert.equal(result.answer, "A red stop sign on a city street.");
  assert.equal(result.objects.length, 0);
});

test("parseImageUnderstandingText handles structured json payload", () => {
  const text = JSON.stringify({
    analysis: {
      answer: "Sign with text",
      ocr_text: "STOP",
      objects: ["sign", "road"],
      scene: "urban street",
      notable_details: ["clear weather"],
      safety_notes: ["traffic nearby"],
    },
  });
  const result = parseImageUnderstandingText(text);
  assert.equal(result.answer, "Sign with text");
  assert.equal(result.ocr_text, "STOP");
  assert.deepEqual(result.objects, ["sign", "road"]);
  assert.equal(result.scene, "urban street");
  assert.deepEqual(result.notable_details, ["clear weather"]);
  assert.deepEqual(result.safety_notes, ["traffic nearby"]);
});
