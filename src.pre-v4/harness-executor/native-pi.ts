/** Add request-specific settings without replacing Pi's normal configuration or MCP runtime. */
import type { HarnessModelTarget, HarnessPrompt } from './types.ts';

export function nativePiExtension(model: HarnessModelTarget, maxOutputTokens: number,
  protocol: 'compatible' | 'openrouter-json', prompt: HarnessPrompt, authenticated = true): string {
  const options = JSON.stringify({ ...model, maxOutputTokens, protocol, authenticated, schema: prompt.responseSchema, toolUse: prompt.toolUse, requiredTool: prompt.requiredTool });
  return `const config = ${options};
export default function (pi) {
  pi.registerProvider(config.provider, {
    baseUrl: config.endpoint,
    apiKey: "$REDLINE_MODEL_API_KEY",
    authHeader: config.authenticated,
  });
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.model?.provider === config.provider && ctx.model.id === config.model) {
      await pi.setModel({ ...ctx.model, baseUrl: config.endpoint, maxTokens: config.maxOutputTokens });
    }
  });
  let lastCatalogue = "";
  let toolStarted = false;
  pi.on("tool_execution_start", () => { toolStarted = true; });
  pi.on("before_provider_request", (event) => {
    const registered = pi.getAllTools();
    const active = new Set(pi.getActiveTools());
    const indirect = registered.some(tool => active.has(tool.name) && tool.reachesTools !== undefined);
    const tools = registered.filter(tool => tool.exposure !== "hidden" && (active.has(tool.name)
      || indirect && (tool.exposure === "codemode" || tool.exposure === "deferred"))).map(tool => tool.name).sort();
    const catalogue = JSON.stringify(tools);
    if (catalogue !== lastCatalogue) {
      pi.appendEntry("redline-tool-catalog", { tools: tools.slice(0, 512), truncated: tools.length > 512 });
      lastCatalogue = catalogue;
    }
    const payload = event.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
    const next = { ...payload };
    if ("max_completion_tokens" in next) next.max_completion_tokens = config.maxOutputTokens;
    else if (next.generationConfig && typeof next.generationConfig === "object") {
      next.generationConfig = { ...next.generationConfig, maxOutputTokens: config.maxOutputTokens };
    } else next.max_tokens = config.maxOutputTokens;
    if (config.protocol === "openrouter-json") {
      next.provider = { ...(next.provider ?? {}), require_parameters: true };
      if (config.toolUse !== "required-first") next.response_format = config.schema
        ? { type: "json_schema", json_schema: { name: "redline_file_review", strict: true, schema: config.schema } }
        : { type: "json_object" };
    }
    if (config.toolUse === "required-first" || config.requiredTool) {
      // Warmup is agent work. The report schema belongs in its prompt, not on every tool-using turn.
      if (config.toolUse === "required-first") delete next.response_format;
      const functions = Array.isArray(next.tools) ? next.tools.map(tool => tool.function?.name).filter(Boolean) : [];
      if (!toolStarted && functions.length > 0) {
        const discovery = [config.requiredTool, "codemode", "tool_search"].filter(Boolean).find(name => functions.includes(name));
        next.tool_choice = discovery ? { type: "function", function: { name: discovery } } : "required";
      }
    }
    return next;
  });
}
`;
}
