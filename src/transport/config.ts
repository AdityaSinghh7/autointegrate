// resolveActiveConfig: read the learned, machine-readable connection config out of
// memory. The "## Config" fenced YAML in integration.md is the source of truth;
// a customer's "## Config Overrides" (if present) shallow-merges on top.

import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { MEMORY_ROOT, integrationPath, profilePath } from "../memory/paths.js";
import type { ActiveApiConfig } from "./types.js";

async function listKnownApis(): Promise<string[]> {
  try {
    const entries = await readdir(resolve(MEMORY_ROOT, "apis"), { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

function extractFencedBlock(md: string, heading: string): string | null {
  const idx = md.indexOf(heading);
  if (idx === -1) return null;
  const after = md.slice(idx + heading.length);
  const m = after.match(/```(?:ya?ml)?\s*\n([\s\S]*?)\n```/);
  return m ? m[1] : null;
}

export async function resolveActiveConfig(
  apiSlug?: string,
  customerSlug?: string,
): Promise<ActiveApiConfig> {
  let slug = apiSlug;
  if (!slug) {
    const apis = await listKnownApis();
    if (apis.length === 1) slug = apis[0];
    else if (apis.length === 0)
      throw new Error("No API has been learned yet. Teach me one by pasting its docs first.");
    else
      throw new Error(
        `Multiple APIs are known (${apis.join(", ")}). Specify which one with apiSlug.`,
      );
  }

  let md: string;
  try {
    md = await readFile(integrationPath(slug), "utf8");
  } catch {
    throw new Error(`No integration config found for API "${slug}".`);
  }

  const block = extractFencedBlock(md, "## Config");
  if (!block)
    throw new Error(`integration.md for "${slug}" has no machine-readable "## Config" block.`);

  const parsed = (parseYaml(block) ?? {}) as Partial<ActiveApiConfig>;
  if (!parsed.transport || !parsed.baseUrl)
    throw new Error(`Config for "${slug}" is missing required fields (transport, baseUrl).`);

  const cfg: ActiveApiConfig = {
    apiSlug: slug,
    transport: parsed.transport,
    baseUrl: parsed.baseUrl,
    auth: parsed.auth,
    defaultHeaders: parsed.defaultHeaders,
    pathTemplates: parsed.pathTemplates,
    statusEnum: parsed.statusEnum,
    enumFieldPath: parsed.enumFieldPath,
    alwaysPresentFields: parsed.alwaysPresentFields,
    expectedStatusCodes: parsed.expectedStatusCodes,
  };

  if (customerSlug) {
    try {
      const pmd = await readFile(profilePath(slug, customerSlug), "utf8");
      const ov = extractFencedBlock(pmd, "## Config Overrides");
      if (ov) {
        const o = (parseYaml(ov) ?? {}) as Partial<ActiveApiConfig>;
        Object.assign(cfg, o);
        cfg.apiSlug = slug; // never let an override change identity
      }
    } catch {
      // no profile or no overrides; base config stands
    }
  }

  return cfg;
}
