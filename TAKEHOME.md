# Hyperscale Engineering Take-Home: Autointegrate

## Overview

Connecting a new system to a software product has historically been a manual task:
an engineer reads the vendor's API docs, writes a client, maps the vendor's fields,
and keeps it working as the vendor changes. Systems integrators do this per customer
and per system, so the cost grows with the number of integrations. Every carrier we
onboard runs a different stack (loads, telematics, maintenance, driver recruiting),
so to grow without growing an integrations team in lockstep we need integration to
work differently: a system that can take on an API it has never seen, use it, and
get more reliable as it is used rather than needing constant maintenance.

This exercise is a small version of that problem.

## What you'll build

A chat agent you can talk to locally. A browser UI is fine, and a simple CLI chat is
also fine if the interaction works. Through conversation, a user hands it a new API
and then uses that API in plain language. Your system should support this sequence:

1. Teach it a new API. The user pastes an API spec into the chat ("here is a new
   system I want you to use: `<spec>`") and your agent ingests it.
2. Use it. In a new chat session, the user asks questions and gives instructions in
   plain language. The agent answers the questions and carries out the actions by
   calling the API, for example moving an applicant to a new stage or adding an
   applicant.
3. It is wrong, and it fixes itself. The API does not behave exactly the way the
   spec claims. When the agent gets something wrong, it should figure out the real
   behavior and correct what it learned, whether the user points out that an answer
   looks off or the agent notices on its own.
4. It stays fixed. In another new session, the same questions work. The correction
   persists across sessions, not only within one conversation.

Assume a non-technical operator. The person using your agent is a recruiting or
operations coordinator, not an engineer, and not you. They paste a vendor's
documentation and talk in plain language, corrections included. A real exchange runs
like "how many drivers did we hire this year?" and then "that is way too low, we
hired a bunch." The intelligence has to live in the system; the operator will not
supply it. When we evaluate, an interviewer drives your agent this way.

The same integration serves more than one customer. You will connect two carriers,
`acme` and `globex`, to the same vendor API. They run the same product but are not
necessarily set up the same way, as two companies on the same software rarely are.
Whatever your system learns has to be scoped sensibly. Something it learns while
serving one customer should not be applied to the other where it does not hold, and
something true of the integration itself should carry across both.

## What you're given

- The Driver Applications API, a stand-in for a third-party driver-recruiting
  system, shipped as a Docker image. We send you `driver-api.tar`; load and run it
  with `docker load -i driver-api.tar`, then
  `docker run -p 8787:8787 driver-applications-api`. The API is then at
  `http://localhost:8787`. No auth. It is multi-tenant (your two customers, `acme`
  and `globex`, live under it) and read-write: you can change applications, not only
  read them. It keeps state in memory and resets to a fresh dataset each time you
  restart the container, which is handy for clean test runs. The endpoints are in
  the vendor docs in Appendix A.
- The vendor's documentation (Appendix A). This is what your user pastes into your
  agent.
- Example questions (Appendix B). The kinds of things a coordinator asks. Use them
  to check yourself.

## How we'll evaluate

We care more about your judgment than about a polished interface or perfect counts.
We will run your system, read your decision record and trace, and use the follow-up
session to understand how you approached an unfamiliar API under a tight time budget.

The API documentation may be incomplete or wrong. The data may be messy. The
operator will speak in plain language, not implementation details. We want to see
what your system learns, what it chooses to trust, how it handles surprises, and how
clearly you can explain the tradeoffs you made.

The example questions are there to help you exercise the system. They are not a
full scoring checklist. Build something that works end to end, then use your
decision record to explain what you prioritized, what you cut, and what you would do
next.

## Rules

- Time: spend no more than 3 hours. We deliberately scoped this larger than fits,
  and the API has more depth than first appears, so the more you poke at it the more
  you find. We do not expect you to reach the bottom. Decide what to tackle first
  and what to cut, and tell us what and why.
- Use whatever you want. Any LLM coding tool, language, framework, libraries, etc.
- It has to run. We will clone it and use it. Include setup steps.
- We will reimburse reasonable LLM API usage for this exercise as necessary.
  Include the rough cost or token usage in your decision record if you can.
- Treat the API like a real vendor's: learn it by reading the docs and calling it.
  Do not reverse-engineer the service implementation; that is not the intended path.
- Build a generic agent, not a solution wired to this sandbox. Do not hardcode this
  API's endpoints, tenants, docs, status codes, counts, answer patterns, or example
  questions into the agent's code, prompts, tools, or seed memory. The operator
  should teach the API at runtime by pasting Appendix A.

## Deliverables

- The repo (it should run; include setup and any keys we need).
- A decision record. This is the main thing we read, more than the code.
  Use it to explain the key design choices, tradeoffs, what you cut, and what you
  would improve.
- Your full agent trace. In Claude Code, run `/export` and include the file; in any
  other harness, export the equivalent complete session log. This is part of what we
  read, so do not curate it.

Build so you can explain every decision, not just so a demo passes. The code will
behave a little differently each run; your reasoning should not.

## If we move forward

If we move forward, expect a working session where we put your system in front of
something it has not seen and talk through the decisions you made and how you would
take the approach further. Build so you can explain your choices, not just demo a
result.

---

## Appendix A: the vendor's documentation

Paste this into your agent.

> # Driver Applications API
>
> Base URL: `http://localhost:8787`
>
> The Driver Applications API exposes a carrier's inbound driver applications: who
> applied, where they are in the hiring process, and their qualifications.
> Authentication is not required for this sandbox.
>
> This is a multi-tenant API. Each carrier (customer) has its own account id, which
> goes in the path. Your customers are `acme` and `globex`.
>
> ## Endpoints
>
> `GET /t/{customer}/applications` returns all of a customer's driver applications
> as a JSON array. Optional query parameters: `status` (filter by status) and
> `limit` (maximum number of results). Example: `GET /t/acme/applications?status=hired`.
>
> `GET /t/{customer}/applications/{id}` returns a single application by id (for
> example `APP-1001`).
>
> `PATCH /t/{customer}/applications/{id}` changes an application's status. Body:
> `{ "status": "new" | "orientation" | "hired" | "rejected" }`.
>
> `POST /t/{customer}/applications` adds an application. Body:
> `{ "driver_name": "...", "status": "..." }`.
>
> ## Application object
>
> | Field | Type | Description |
> | --- | --- | --- |
> | `id` | string | Application id, e.g. `APP-1001`. |
> | `driver_name` | string | Applicant's full name. |
> | `status` | string | Application status: `new`, `orientation`, `hired`, or `rejected`. |
> | `cdl_class` | string | CDL class, `A` or `B`. |
> | `endorsements` | string[] | License endorsements (e.g. `Hazmat`, `Tanker`). |
> | `created_at` | string | ISO date the application was submitted. |
>
> ## Notes
>
> Dates are ISO 8601 (`YYYY-MM-DD`).

## Appendix B: example questions

Once your agent has learned a customer's setup, it should answer questions like
these, in plain language, for whichever customer the operator is working with.

For Acme:

1. How many driver applications does Acme have in total?
2. How many of its applicants has Acme hired?
3. List Acme's applicants who are currently in orientation.
4. How many people applied to Acme this year?
5. Which of Acme's hired drivers hold a Hazmat endorsement?
6. Which of Acme's hired drivers have an expired medical card?

For Globex:

7. How many drivers has Globex hired?
8. How many total applications does Globex have right now?

Actions:

9. Move applicant APP-1101 to hired for Acme, then tell me Acme's new hired count.
10. Add a new applicant named Jordan Rivera for Globex, then confirm Globex's total.

A freshly started chat session, with no memory of the conversation where it learned
the API, should get these right once your system has learned the customer's setup.
