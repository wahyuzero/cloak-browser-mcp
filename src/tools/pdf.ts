import { z } from "zod";
import { basename } from "node:path";
import type { ToolHandler } from "./types.js";
import { textOutput } from "./types.js";

const saveSchema = z.object({
  filename: z.string().describe("Absolute path to write the PDF to."),
  format: z.enum(["A4", "Letter", "Legal"]).optional(),
  landscape: z.boolean().optional(),
  printBackground: z.boolean().optional(),
  scale: z.number().min(0.1).max(2).optional(),
});

export const pdfTools: ToolHandler[] = [
  {
    name: "browser_pdf_save",
    description: "Save the current page as PDF (Chromium-only). On Chromium builds where PDF printing is broken (e.g. the patched CloakBrowser build on Android/Termux), falls back to a full-page PNG screenshot next to the requested path.",
    capability: "pdf",
    inputSchema: saveSchema,
    handler: async (session, raw) => {
      const args = saveSchema.parse(raw);
      const page = session.activePage;
      try {
        await page.pdf({
          path: args.filename,
          format: args.format ?? "A4",
          landscape: args.landscape ?? false,
          printBackground: args.printBackground ?? true,
          scale: args.scale ?? 1,
        });
        return textOutput(`Wrote PDF to ${args.filename}`);
      } catch (e) {
        // BUG-2 root cause: `page.pdf` on the patched CloakBrowser Chromium
        // under Android always dies with "Protocol error (IO.read): Read
        // failed" — the CDP Page.printToPDF result stream (IO.read of the
        // temp handle) is broken inside the patched binary, so this cannot be
        // fixed from the MCP layer. Fail gracefully: surface the real error
        // clearly and fall back to a full-page PNG screenshot.
        const msg = e instanceof Error ? e.message : String(e);
        const fallbackPath = args.filename.replace(/\.pdf$/i, "") + ".png";
        const shot = await page
          .screenshot({ path: fallbackPath, fullPage: true, type: "png" })
          .then(() => true)
          .catch(() => false);
        const lines = [
          `PDF generation failed: ${msg}`,
          `Root cause: Page.printToPDF stream handling (CDP IO.read) is broken in the patched Chromium build on Android — page.pdf cannot work in this environment.`,
        ];
        if (shot) {
          lines.push(`Fallback: full-page screenshot written to ${fallbackPath} (basename: ${basename(fallbackPath)}).`);
        } else {
          lines.push(`Fallback screenshot also failed — the page may be in a broken state; try re-navigating.`);
        }
        return textOutput(lines.join("\n"));
      }
    },
  },
];
