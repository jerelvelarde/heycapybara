export function runtimeConfig(env: NodeJS.ProcessEnv) {
  const containerId =
    env.CPK_INTELLIGENCE_LEARNING_CONTAINER_ID || "desktop-workflows";
  if (
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(containerId) ||
    containerId.length > 64
  )
    throw new Error("Invalid learning container ID");
  const model = (env.KITE_MODEL || "gpt-5.4").replace(/^openai\//, "");
  if (!/^gpt-[A-Za-z0-9.-]+$/.test(model))
    throw new Error("KITE_MODEL must name an OpenAI GPT model for Codex");
  return {
    containerId,
    model,
    intelligenceConfigured: !!env.CPK_INTELLIGENCE_API_KEY,
    modelConfigured: !!env.OPENAI_API_KEY,
  };
}
