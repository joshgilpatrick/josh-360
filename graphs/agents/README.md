# Agents

One folder per named agent: `agent.yaml` (`title`, `fills`) and `instructions.md`. See `graphs/CONVENTION.md`, "Agents". An agent fills a role for one kind of work.

| Agent | Fills | For |
| --- | --- | --- |
| `answerer` | `researcher` | Kind `research`: answer a question, usually with data. |
| `drafter` | `researcher` | Kinds `doc` and `email`: write a document or a reply for Josh to use or send himself. |
| `finder` | `researcher` | Kind `misc`: find a file, a record or a fact and hand it to Josh. |
| `spec-writer` | `designer` | Story, Bug and Task tickets: the build spec (`contracts/spec.md`). |
| `design-writer` | `designer` | Research tickets with a repository: a design spec and an implementation plan. |
