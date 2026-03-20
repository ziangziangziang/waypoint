import test from "node:test";
import assert from "node:assert/strict";
import path from "path";
import {
  resolveBinaryOutputPolicy,
  validateAtMostOneImageInput,
  validateSingleImageInput,
} from "../src/mcp/policy";

test("resolveBinaryOutputPolicy requires workspace_root", () => {
  assert.throws(
    () => resolveBinaryOutputPolicy({ output_dir: "./images" }),
    /workspace_root is required/
  );
});

test("resolveBinaryOutputPolicy rejects output_path and output_dir together", () => {
  assert.throws(
    () =>
      resolveBinaryOutputPolicy({
        workspace_root: path.join(path.sep, "Users", "example", "repo"),
        output_path: "./a.png",
        output_dir: "./images",
      }),
    /Provide either output_path or output_dir/
  );
});

test("resolveBinaryOutputPolicy rejects absolute output paths", () => {
  const workspaceRoot = path.join(path.sep, "Users", "example", "repo");
  assert.throws(
    () => resolveBinaryOutputPolicy({ workspace_root: workspaceRoot, output_path: "/tmp/a.png" }),
    /output_path must be relative to workspace_root/
  );
  assert.throws(
    () => resolveBinaryOutputPolicy({ workspace_root: workspaceRoot, output_dir: "/tmp" }),
    /output_dir must be relative to workspace_root/
  );
});

test("resolveBinaryOutputPolicy accepts relative output paths inside workspace", () => {
  const workspaceRoot = path.join(path.sep, "Users", "example", "repo");
  const resolved = resolveBinaryOutputPolicy({
    workspace_root: workspaceRoot,
    output_path: "./images/a-{index}.png",
  });
  assert.equal(resolved.outputBaseRoot, workspaceRoot);
  assert.equal(resolved.outputPathPattern, "./images/a-{index}.png");
  assert.equal(resolved.includeData, false);
});

test("resolveBinaryOutputPolicy requires {index} for n > 1 with output_path", () => {
  const workspaceRoot = path.join(path.sep, "Users", "example", "repo");
  assert.throws(
    () =>
      resolveBinaryOutputPolicy({
        workspace_root: workspaceRoot,
        n: 2,
        output_path: "./image.png",
      }),
    /include '\{index\}'/
  );
});

test("resolveBinaryOutputPolicy defaults includeData to false", () => {
  const workspaceRoot = path.join(path.sep, "Users", "example", "repo");
  const resolved = resolveBinaryOutputPolicy({
    workspace_root: workspaceRoot,
    output_dir: "./images",
  });
  assert.equal(resolved.includeData, false);
  assert.equal(resolved.outputBaseRoot, workspaceRoot);
});

test("resolveBinaryOutputPolicy accepts workspace_root within pinned root", () => {
  const pinnedRoot = path.join(process.cwd(), "tmp", "manga-root");
  const workspaceRoot = path.join(pinnedRoot, "repo-a");
  const resolved = resolveBinaryOutputPolicy(
    {
      workspace_root: workspaceRoot,
      output_dir: "./images",
    },
    { env: { WAYPOINT_MCP_OUTPUT_ROOT: pinnedRoot } }
  );
  assert.equal(resolved.outputBaseRoot, workspaceRoot);
});

test("resolveBinaryOutputPolicy rejects relative workspace_root", () => {
  assert.throws(
    () =>
      resolveBinaryOutputPolicy({
        workspace_root: "./repo",
        output_dir: "./images",
      }),
    /workspace_root must be an absolute path/
  );
});

test("resolveBinaryOutputPolicy rejects workspace_root outside pinned root", () => {
  const pinnedRoot = path.join(process.cwd(), "tmp", "manga-root");
  const otherRoot = path.join(process.cwd(), "tmp", "meme-root");
  assert.throws(
    () =>
      resolveBinaryOutputPolicy(
        {
          workspace_root: otherRoot,
          output_dir: "./images",
        },
        { env: { WAYPOINT_MCP_OUTPUT_ROOT: pinnedRoot } }
      ),
    /workspace_root resolved to/
  );
});

test("resolveBinaryOutputPolicy enforces strict output root requirements", () => {
  assert.throws(
    () =>
      resolveBinaryOutputPolicy(
        { workspace_root: path.join(process.cwd(), "tmp", "repo"), output_dir: "./images" },
        { env: { WAYPOINT_MCP_STRICT_OUTPUT_ROOT: "true" } }
      ),
    /requires WAYPOINT_MCP_OUTPUT_ROOT/
  );

  assert.throws(
    () =>
      resolveBinaryOutputPolicy(
        { workspace_root: path.join(process.cwd(), "tmp", "repo"), output_dir: "./images" },
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
