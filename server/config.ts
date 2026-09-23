export function runtimeConfig(env: NodeJS.ProcessEnv) {
  const containerId =
    env.CPK_INTELLIGENCE_LEARNING_CONTAINER_ID || "desktop-workflows";
  if (
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(containerId) ||
    containerId.length > 64
  )
    throw new Error("Invalid learning container ID");
  const model = env.KITE_MODEL || "openai/gpt-4.1";
  const provider = model.split("/")[0];
  const keyNames: Record<string, string> = {
    openai: "OPENAI_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
    google: "GOOGLE_API_KEY",
  };
  if (!keyNames[provider])
    throw new Error("KITE_MODEL must use openai/, anthropic/, or google/");
  return {
    containerId,
    model,
    intelligenceConfigured: !!env.CPK_INTELLIGENCE_API_KEY,
    modelConfigured: !!env[keyNames[provider]],
  };
}
