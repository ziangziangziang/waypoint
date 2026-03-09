import test from "node:test";
import assert from "node:assert/strict";
import path from "path";
import {
  MCP_TOOL_DESCRIPTION_TEMPLATE,
  resolveBinaryOutputPolicy,
  validateAtMostOneImageInput,
  validateSingleImageInput,
} from "../src/mcp/policy";

test("resolveBinaryOutputPolicy rejects output_path and output_dir together", () => {
  assert.throws(
    () => resolveBinaryOutputPolicy({ output_path: "/tmp/a.png", output_dir: "/tmp" }),
    /Provide either output_path or output_dir/
  );
});

test("resolveBinaryOutputPolicy rejects output paths outside workspace", () => {
  assert.throws(
    () => resolveBinaryOutputPolicy({ output_path: "/tmp/a.png" }),
    /output_path resolved to/
  );
  assert.throws(
    () => resolveBinaryOutputPolicy({ output_dir: "/tmp" }),
    /output_dir resolved to/
  );
});

test("resolveBinaryOutputPolicy accepts output paths inside workspace", () => {
  const cwd = process.cwd();
  assert.doesNotThrow(() =>
    resolveBinaryOutputPolicy({ output_path: path.join(cwd, "tmp", "a.png") })
  );
  assert.doesNotThrow(() => resolveBinaryOutputPolicy({ output_dir: path.join(cwd, "tmp") }));
});

test("resolveBinaryOutputPolicy requires {index} for n > 1 with output_path", () => {
  const cwd = process.cwd();
  assert.throws(
    () => resolveBinaryOutputPolicy({ n: 2, output_path: path.join(cwd, "tmp", "image.png") }),
    /include '\{index\}'/
  );
});

test("resolveBinaryOutputPolicy defaults includeData to false in file-output mode", () => {
  const resolved = resolveBinaryOutputPolicy({ output_dir: path.join(process.cwd(), "tmp", "icons") });
  assert.equal(resolved.includeData, false);
  assert.equal(resolved.outputBaseRoot, process.cwd());
});

test("resolveBinaryOutputPolicy defaults includeData to true without file-output mode", () => {
  const resolved = resolveBinaryOutputPolicy({});
  assert.equal(resolved.includeData, true);
  assert.equal(resolved.outputBaseRoot, process.cwd());
});

test("resolveBinaryOutputPolicy accepts path under configured output root", () => {
  const pinnedRoot = path.join(process.cwd(), "tmp", "manga-root");
  const resolved = resolveBinaryOutputPolicy(
    { output_dir: path.join(pinnedRoot, "work") },
    { env: { WAYPOINT_MCP_OUTPUT_ROOT: pinnedRoot } }
  );
  assert.equal(resolved.outputBaseRoot, pinnedRoot);
});

test("resolveBinaryOutputPolicy rejects sibling path when output root is pinned", () => {
  const pinnedRoot = path.join(process.cwd(), "tmp", "manga-root");
  const siblingRoot = path.join(process.cwd(), "tmp", "meme-root");
  assert.throws(
    () =>
      resolveBinaryOutputPolicy(
        { output_dir: path.join(siblingRoot, "work") },
        { env: { WAYPOINT_MCP_OUTPUT_ROOT: pinnedRoot } }
      ),
    /must be within/
  );
});

test("resolveBinaryOutputPolicy resolves relative output_dir against configured root", () => {
  const pinnedRoot = path.join(process.cwd(), "tmp", "manga-root");
  assert.doesNotThrow(() =>
    resolveBinaryOutputPolicy(
      { output_dir: "./work" },
      {
        env: {
          WAYPOINT_MCP_OUTPUT_ROOT: pinnedRoot,
          WAYPOINT_MCP_OUTPUT_SUBDIR: "work",
        },
      }
    )
  );
});

test("resolveBinaryOutputPolicy rejects relative output_dir outside configured subdir", () => {
  const pinnedRoot = path.join(process.cwd(), "tmp", "manga-root");
  assert.throws(
    () =>
      resolveBinaryOutputPolicy(
        { output_dir: "./tmp" },
        {
          env: {
            WAYPOINT_MCP_OUTPUT_ROOT: pinnedRoot,
            WAYPOINT_MCP_OUTPUT_SUBDIR: "work",
          },
        }
      ),
    /must be within/
  );
});

test("resolveBinaryOutputPolicy enforces strict output root requirements", () => {
  assert.throws(
    () =>
      resolveBinaryOutputPolicy(
        { output_dir: "./work" },
        { env: { WAYPOINT_MCP_STRICT_OUTPUT_ROOT: "true" } }
      ),
    /requires WAYPOINT_MCP_OUTPUT_ROOT/
  );

  assert.throws(
    () =>
      resolveBinaryOutputPolicy(
        { output_dir: "./work" },
        {
          env: {
            WAYPOINT_MCP_STRICT_OUTPUT_ROOT: "true",
            WAYPOINT_MCP_OUTPUT_ROOT: "relative/path",
          },
        }
      ),
    /must be an absolute path/
  );
});

test("binary tool description template includes normative keywords", () => {
  const template = MCP_TOOL_DESCRIPTION_TEMPLATE.binary;
  assert.match(template, /\bMUST\b/);
  assert.match(template, /\bMUST NOT\b/);
  assert.match(template, /\bSHOULD\b/);
});

test("image-to-text tool description template includes normative keywords", () => {
  const template = MCP_TOOL_DESCRIPTION_TEMPLATE.image_to_text;
  assert.match(template, /\bMUST\b/);
  assert.match(template, /\bMUST NOT\b/);
  assert.match(template, /\bSHOULD\b/);
});

test("validateSingleImageInput enforces xor behavior", () => {
  assert.throws(() => validateSingleImageInput({}), /Exactly one image source/);
  assert.throws(
    () => validateSingleImageInput({ image_path: "/tmp/a.png", image_url: "https://example.com/a.png" }),
    /Exactly one image source/
  );
  assert.doesNotThrow(() => validateSingleImageInput({ image_path: "/tmp/a.png" }));
  assert.doesNotThrow(() => validateSingleImageInput({ image_url: "https://example.com/a.png" }));
});

test("validateAtMostOneImageInput allows none or one image source", () => {
  assert.doesNotThrow(() => validateAtMostOneImageInput({}));
  assert.doesNotThrow(() => validateAtMostOneImageInput({ image_path: "/tmp/a.png" }));
  assert.doesNotThrow(() => validateAtMostOneImageInput({ image_url: "https://example.com/a.png" }));
  assert.throws(
    () => validateAtMostOneImageInput({ image_path: "/tmp/a.png", image_url: "https://example.com/a.png" }),
    /Provide either image_path or image_url/
  );
});
