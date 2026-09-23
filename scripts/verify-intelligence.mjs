import "dotenv/config";
import { CopilotKitIntelligence } from "@copilotkit/runtime/v2";
if (!process.env.CPK_INTELLIGENCE_API_KEY)
  throw new Error("Select a CopilotKit project first.");
const client = new CopilotKitIntelligence({
  apiKey: process.env.CPK_INTELLIGENCE_API_KEY,
});
const containerId =
  process.env.CPK_INTELLIGENCE_LEARNING_CONTAINER_ID || "desktop-workflows";
try {
  const snapshot = await client.getLearnedSkillsSnapshot({
    containerId,
    signal: AbortSignal.timeout(15000),
  });
  console.log(
    `Intelligence skill delivery verified: ${containerId}, revision ${snapshot.revision}.`,
  );
  console.log(
    "This read-only check does not verify model access, completed-run ingestion, or future learning analyses.",
  );
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Intelligence verification failed",
  );
  process.exitCode = 1;
}
