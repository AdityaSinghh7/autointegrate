// Canonical memory paths + slug helpers + the frozen section-heading contract.
// Every writer (the main agent, the correction hook, the ingest handler) targets
// these exact paths and headings so cold-start parsing never breaks.

import { resolve } from "node:path";

export const MEMORY_ROOT = resolve(process.cwd(), "memory");
export const INDEX_PATH = resolve(MEMORY_ROOT, "INDEX.md");

/** Deterministic, dictionary-free slug. Same input -> same folder (idempotent re-teach). */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

export function apiDir(apiSlug: string): string {
  return resolve(MEMORY_ROOT, "apis", apiSlug);
}
export function integrationPath(apiSlug: string): string {
  return resolve(apiDir(apiSlug), "integration.md");
}
export function correctionsPath(apiSlug: string): string {
  return resolve(apiDir(apiSlug), "corrections.md");
}
export function customerDir(apiSlug: string, customerSlug: string): string {
  return resolve(apiDir(apiSlug), "customers", customerSlug);
}
export function profilePath(apiSlug: string, customerSlug: string): string {
  return resolve(customerDir(apiSlug, customerSlug), "profile.md");
}
