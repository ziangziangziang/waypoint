import { createEndpoint } from "../src/storage/repositories";
import { ensureStorageDir, resolveStoragePaths } from "../src/storage/files";

async function run(): Promise<void> {
  const paths = resolveStoragePaths();
  await ensureStorageDir(paths);
  await createEndpoint(paths, {
    name: "local-llm",
    baseUrl: "http://localhost:11434",
    insecureTls: false,
    priority: 1,
    type: "llm",
    models: [
      { publicName: "local-default", upstreamModel: "llama3" },
      { publicName: "embed-default", upstreamModel: "nomic-embed-text" }
    ]
  });
  console.log("Seeded endpoint: local-llm");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
