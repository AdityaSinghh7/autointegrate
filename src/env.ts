// Load ./.env (if present) before anything else imports the SDK. Uses Node's
// built-in env-file loader (Node 20.12+); falls back silently to the ambient
// environment when there is no .env.

import { resolve } from "node:path";

try {
  const loadEnvFile = (process as unknown as { loadEnvFile?: (p: string) => void }).loadEnvFile;
  if (typeof loadEnvFile === "function") loadEnvFile(resolve(process.cwd(), ".env"));
} catch {
  // no .env file present; rely on the ambient environment
}
