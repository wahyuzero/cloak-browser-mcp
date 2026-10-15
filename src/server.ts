import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z, type ZodTypeAny } from "zod";
import { BrowserSession } from "./browser.js";
import type { ServerConfig } from "./config.js";
import { CloakError } from "./errors.js";
import { collectTools } from "./tools/index.js";
import type { ToolOutput } from "./tools/types.js";
import { fingerprintOverrideScript, uaForPlatform, applyUaOverride } from "./util/fingerprint.js";

export function createServer(cfg: ServerConfig): { server: McpServer; session: BrowserSession } {
  const session = new BrowserSession(cfg);
  // BUG-3 fix: apply the launch-time platform fingerprint (CLI
  // --fingerprint-platform) as a runtime UA override right after launch —
  // compiled-in Chromium flags alone don't change the UA string on Android.
  if (cfg.fingerprintPlatform) {
    session.onLaunched(async (ctx, uaHint) => {
      const ua = uaForPlatform(uaHint, cfg.fingerprintPlatform!);
      if (!ua) return;
      await ctx.addInitScript(fingerprintOverrideScript(cfg.fingerprintPlatform!, ua));
      await applyUaOverride(ctx.pages(), ua, cfg.fingerprintPlatform!);
    });
  }
  const tools = collectTools(cfg);

  const server = new McpServer(
    { name: "cloak-browser-mcp", version: readVersion() },
    { capabilities: { tools: {} } },
  );

  for (const tool of tools) {
    const inputShape = extractObjectShape(tool.inputSchema);
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: inputShape,
      },
      async (args: Record<string, unknown>) => {
        try {
          tool.precondition?.(session);
          const out = await tool.handler(session, args);
          return out as unknown as ToolOutputResponse;
        } catch (e) {
          const msg = e instanceof CloakError ? `[${e.code}] ${e.message}` : e instanceof Error ? e.message : String(e);
          return { content: [{ type: "text", text: msg }], isError: true } as ToolOutputResponse;
        }
      },
    );
  }

  return { server, session };
}

type ToolOutputResponse = ToolOutput & Record<string, unknown>;

/** McpServer.registerTool expects a ZodRawShape (object of zod field schemas), not a ZodObject. */
function extractObjectShape(schema: ZodTypeAny): Record<string, ZodTypeAny> {
  const tn = (schema as unknown as { _def?: { typeName?: string } })._def?.typeName;
  if (tn === "ZodObject") {
    return (schema as unknown as { shape: Record<string, ZodTypeAny> }).shape;
  }
  return { value: z.any() };
}

function readVersion(): string {
  try {
    const { createRequire } = require("module") as typeof import("module");
    const req = createRequire(import.meta.url);
    const pkg = req("../package.json") as { version?: string };
    return String(pkg.version ?? "0.0.0");
  } catch {
    return "0.0.0";
  }
}
