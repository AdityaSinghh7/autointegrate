// A minimal progress reporter so deep code (ingestion + probers) can surface
// clean, human-readable progress to the CLI without owning stdout or its
// formatting. index.ts registers the sink; default is a no-op (e.g. tests).

type Reporter = (line: string) => void;

let sink: Reporter = () => {};

export function setReporter(fn: Reporter): void {
  sink = fn;
}

export function report(line: string): void {
  sink(line);
}
