// PreToolUse memory-write guard. The agent may only modify files under ./memory,
// and INDEX.md / integration.md may only be edited incrementally (never clobbered
// with a full-file Write). Everything else is allowed to proceed (the session runs
// in bypassPermissions, so returning {} lets the tool through).
//
// Typed loosely (`any`) against the SDK hook-callback shape on purpose: the hook
// input/output union is broad and we only need a few fields.

import { resolve, sep } from "node:path";
import { MEMORY_ROOT } from "./paths.js";

export async function memoryGuard(input: any): Promise<any> {
  const name: string | undefined = input?.tool_name;
  if (name !== "Write" && name !== "Edit") return {};

  const fp: unknown = input?.tool_input?.file_path;
  if (typeof fp !== "string") return {};

  const abs = resolve(process.cwd(), fp);
  const underMemory = abs === MEMORY_ROOT || abs.startsWith(MEMORY_ROOT + sep);
  if (!underMemory) {
    return deny(
      `Refusing to write outside ./memory (attempted: ${fp}). The agent may only modify its memory files.`,
    );
  }

  if (name === "Write" && /(?:^|\/)(?:INDEX\.md|integration\.md)$/.test(abs)) {
    return deny(
      "INDEX.md and integration.md must be edited incrementally with Edit, not overwritten with Write.",
    );
  }

  return {};
}

function deny(reason: string) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}
