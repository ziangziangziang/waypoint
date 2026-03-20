import test from "node:test";
import assert from "node:assert/strict";
import os from "os";
import path from "path";
import { promises as fs } from "fs";
import sharp from "sharp";
import {
  buildImageGeometrySystemMessage,
  imageDataUrlFromPath,
  imageDataUrlWithGeometryFromPath,
  parseImageUnderstandingText,
} from "../src/services/imageUnderstanding";

test("imageDataUrlFromPath reads bytes and builds data URL", async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "waypoint-img-understand-"));
  const filePath = path.join(baseDir, "sample.png");
  await sharp({
    create: {
      width: 4,
      height: 4,
      channels: 3,
      background: { r: 255, g: 0, b: 0 },
    },
  })
    .png()
    .toFile(filePath);

  const dataUrl = await imageDataUrlFromPath(filePath);
  assert.match(dataUrl, /^data:image\/png;base64,/);
});

test("imageDataUrlWithGeometryFromPath preserves identity geometry for small images", async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "waypoint-img-understand-"));
  const filePath = path.join(baseDir, "small.png");
  await sharp({
    create: {
      width: 320,
      height: 240,
      channels: 3,
      background: { r: 0, g: 255, b: 0 },
    },
  })
    .png()
    .toFile(filePath);

  const resolved = await imageDataUrlWithGeometryFromPath(filePath);
  assert.match(resolved.imageUrl, /^data:image\/png;base64,/);
  assert.deepEqual(resolved.imageGeometry, {
    original_width: 320,
    original_height: 240,
    uploaded_width: 320,
    uploaded_height: 240,
    scale_x: 1,
    scale_y: 1,
    resized: false,
  });
});

test("imageDataUrlWithGeometryFromPath tracks resized upload geometry", async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "waypoint-img-understand-"));
  const filePath = path.join(baseDir, "large.png");
  await sharp({
    create: {
      width: 2000,
      height: 1200,
      channels: 3,
      background: { r: 0, g: 0, b: 255 },
    },
  })
    .png()
    .toFile(filePath);

  const resolved = await imageDataUrlWithGeometryFromPath(filePath);
  assert.match(resolved.imageUrl, /^data:image\/png;base64,/);
  assert.equal(resolved.imageGeometry?.original_width, 2000);
  assert.equal(resolved.imageGeometry?.original_height, 1200);
  assert.ok((resolved.imageGeometry?.uploaded_width ?? 0) < 2000);
  assert.ok((resolved.imageGeometry?.uploaded_height ?? 0) < 1200);
  assert.equal(resolved.imageGeometry?.resized, true);
  assert.ok((resolved.imageGeometry?.scale_x ?? 1) > 1);
  assert.ok((resolved.imageGeometry?.scale_y ?? 1) > 1);
});

test("buildImageGeometrySystemMessage describes original coordinate space", () => {
  const message = buildImageGeometrySystemMessage({
    original_width: 2000,
    original_height: 1200,
    uploaded_width: 1080,
    uploaded_height: 648,
    scale_x: 2000 / 1080,
    scale_y: 1200 / 648,
    resized: true,
  });
  assert.match(message, /original image pixel space/i);
  assert.match(message, /Original image size: 2000x1200/);
  assert.match(message, /Uploaded image size: 1080x648/);
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
