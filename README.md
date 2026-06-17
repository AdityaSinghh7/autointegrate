# Autointegrate

A local CLI chat agent that learns an unfamiliar API at runtime from documentation
you paste into the chat, then uses it in plain language, self-corrects when the API
behaves differently from its docs, and remembers those corrections across sessions.

Built on the Claude Agent SDK (TypeScript). See `IMPLEMENTATION_PLAN.md` for the
design and `DECISION_RECORD.md` for the writeup.

## Setup

1. Install dependencies:

   ```
   npm install
   ```

2. Provide an Anthropic API key:

   ```
   cp .env.example .env
   # then edit .env and set ANTHROPIC_API_KEY
   ```

3. Start the chat:

   ```
   npm run chat
   ```

   To teach a new API, type `/teach`, paste its documentation, then type `/end` on its
   own line. Otherwise just ask in plain language. `/exit` quits.

## Exercising it against a vendor API (the sandbox)

The agent is generic and learns any API at runtime. To run it against the provided
sandbox container:

1. Make sure a container runtime is running and the `docker` CLI can reach it:

   - **Docker Desktop:** start it (macOS: `open -a Docker`, or launch the app; Linux:
     `systemctl --user start docker-desktop`) and wait until it reports "running".
   - **OrbStack:** `open -a OrbStack`.
   - **Plain Docker Engine (Linux):** `sudo systemctl start docker`.

   Then confirm the daemon is reachable (no error means you are good):

   ```
   docker info >/dev/null
   ```

2. Load and run the vendor image (place `driver-api.tar` in this folder first):

   ```
   docker load -i driver-api.tar
   docker run --rm -p 8787:8787 driver-applications-api
   ```

   The API is then at `http://localhost:8787`. It resets to fresh data on restart.

3. In the chat, type `/teach`, paste the vendor's documentation, then type `/end` on
   its own line. The agent ingests it and probes the live API to learn how it really
   behaves (this takes a minute and prints progress). After that, ask questions and
   give instructions in plain language, in this or any later session.

## How memory works

Everything the agent learns is stored as Markdown under `./memory`:

- `memory/INDEX.md` — a manifest of known APIs and customers (read first).
- `memory/apis/<api>/integration.md` — integration-wide knowledge.
- `memory/apis/<api>/customers/<customer>/profile.md` — per-customer knowledge.
- `memory/apis/<api>/corrections.md` — an append-only log of corrections.

This directory is tracked in git on purpose: it is the persistence layer, and it
is the evidence that corrections survive across separate sessions.

## Traces

Every run writes an uncurated log of all agent messages to `./runs/<timestamp>.jsonl`.
