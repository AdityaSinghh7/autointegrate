// A tiny broker that lets deep code (e.g. ingestion probers) ask the operator a
// yes/no question through the single CLI readline, without competing for stdin.
// index.ts registers the asker; if none is registered (non-interactive run), the
// answer defaults to "no" so potentially-destructive actions are never taken
// unattended.

type Asker = (question: string) => Promise<boolean>;

let asker: Asker | null = null;

export function setAsker(fn: Asker): void {
  asker = fn;
}

export async function askOperator(question: string): Promise<boolean> {
  if (!asker) return false;
  try {
    return await asker(question);
  } catch {
    return false;
  }
}
