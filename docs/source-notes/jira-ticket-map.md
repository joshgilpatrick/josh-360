# Josh 360 tickets on Jira

## Contents

- [Phase 0: requirements](#phase-0-requirements)
- [Phase 1: foundation](#phase-1-foundation)
- [Phase 2: the full pipeline](#phase-2-the-full-pipeline)
- [Phase 3: reflection](#phase-3-reflection)
- [How to read this](#how-to-read-this)

Epic: [JP-94](https://eventuswh-analytics.atlassian.net/browse/JP-94), Josh 360: one foundation for Josh's agentic workflow. Created on 16 November 2026. Jira is the source of truth, and this page is a map.

## Phase 0: requirements

| Key | Type | Ticket | Blocked by |
| --- | --- | --- | --- |
| [JP-95](https://eventuswh-analytics.atlassian.net/browse/JP-95) | Task | Set up josh-360 as the home: vision doc, repo rules and folder layout | Nothing |

## Phase 1: foundation

| Key | Type | Ticket | Blocked by |
| --- | --- | --- | --- |
| [JP-96](https://eventuswh-analytics.atlassian.net/browse/JP-96) | Research | Inventory the work laptop and give every item a verdict | JP-95 |
| [JP-97](https://eventuswh-analytics.atlassian.net/browse/JP-97) | Research | List every feature of action-triage and Session Atlas with a verdict | JP-95 |
| [JP-98](https://eventuswh-analytics.atlassian.net/browse/JP-98) | Task | Write the ticket conventions, the system registry, the standing priorities file and the surface map | JP-95 |
| [JP-99](https://eventuswh-analytics.atlassian.net/browse/JP-99) | Research | Design the unified data model | JP-96, JP-97 |
| [JP-100](https://eventuswh-analytics.atlassian.net/browse/JP-100) | Task | Make STATE.md the only per-session record | JP-96 |
| [JP-101](https://eventuswh-analytics.atlassian.net/browse/JP-101) | Story | Define the graph convention and build its checker | JP-95 |
| [JP-102](https://eventuswh-analytics.atlassian.net/browse/JP-102) | Research | Design the ticket creation graph | JP-98, JP-101 |
| [JP-103](https://eventuswh-analytics.atlassian.net/browse/JP-103) | Research | Design the triage and sign-off graph | JP-98, JP-101 |
| [JP-104](https://eventuswh-analytics.atlassian.net/browse/JP-104) | Research | Design the non-development graph | JP-98, JP-101 |
| [JP-105](https://eventuswh-analytics.atlassian.net/browse/JP-105) | Task | Connect the laptop to josh-360 once | JP-95 |
| [JP-106](https://eventuswh-analytics.atlassian.net/browse/JP-106) | Task | Put every phase 1 design question to Josh in one sitting | JP-99, JP-102, JP-103, JP-104 |
| [JP-107](https://eventuswh-analytics.atlassian.net/browse/JP-107) | Story | Build the ledger and record facts from every session | JP-105, JP-106 |
| [JP-108](https://eventuswh-analytics.atlassian.net/browse/JP-108) | Story | Write five summary lines when a session goes quiet | JP-107 |
| [JP-109](https://eventuswh-analytics.atlassian.net/browse/JP-109) | Story | Compute loose ends and add the closeout agent | JP-107 |
| [JP-110](https://eventuswh-analytics.atlassian.net/browse/JP-110) | Story | Offer a ticket when a session's work becomes ticket-sized | JP-107 |
| [JP-111](https://eventuswh-analytics.atlassian.net/browse/JP-111) | Story | Move Session Atlas into josh-360 and onto the ledger | JP-108 |
| [JP-112](https://eventuswh-analytics.atlassian.net/browse/JP-112) | Story | Record friction facts from every session, with no model | JP-107 |
| [JP-113](https://eventuswh-analytics.atlassian.net/browse/JP-113) | Story | Add the session debrief form | JP-108, JP-112 |
| [JP-114](https://eventuswh-analytics.atlassian.net/browse/JP-114) | Story | Build the walker | JP-107 |
| [JP-115](https://eventuswh-analytics.atlassian.net/browse/JP-115) | Story | Write the development graph from the 22-step draft | JP-114 |
| [JP-116](https://eventuswh-analytics.atlassian.net/browse/JP-116) | Story | Record Josh's decisions in the ledger, stage one | JP-115 |
| [JP-117](https://eventuswh-analytics.atlassian.net/browse/JP-117) | Story | Bind the walker to Agent Manager and carry a real ticket to a pull request | JP-115 |
| [JP-118](https://eventuswh-analytics.atlassian.net/browse/JP-118) | Story | Pass new ticket comments to the sessions working on that ticket | JP-114 |
| [JP-119](https://eventuswh-analytics.atlassian.net/browse/JP-119) | Task | Start every Josh 360 background job from the one startup list | JP-111, JP-118 |
| [JP-121](https://eventuswh-analytics.atlassian.net/browse/JP-121) | Story | Build the ticket creation graph | JP-114, JP-139, JP-140 |
| [JP-122](https://eventuswh-analytics.atlassian.net/browse/JP-122) | Story | Build the triage and sign-off graph | JP-114, JP-121, JP-139, JP-140 |
| [JP-123](https://eventuswh-analytics.atlassian.net/browse/JP-123) | Story | Build the non-development graph | JP-114, JP-139, JP-140 |
| [JP-120](https://eventuswh-analytics.atlassian.net/browse/JP-120) | Task | Close phase 1: proof pages and the deletion list | JP-100, JP-109, JP-110, JP-112, JP-116, JP-117, JP-119, JP-121, JP-122, JP-123 |

## Phase 2: the full pipeline

| Key | Type | Ticket | Blocked by |
| --- | --- | --- | --- |
| [JP-124](https://eventuswh-analytics.atlassian.net/browse/JP-124) | Story | Move action-triage into josh-360 and onto the ledger | JP-120 |
| [JP-125](https://eventuswh-analytics.atlassian.net/browse/JP-125) | Story | Make the Needs you tab the one place for agent decisions | JP-124 |
| [JP-126](https://eventuswh-analytics.atlassian.net/browse/JP-126) | Story | Decision memory stage two: suggest and confirm with precedent | JP-125 |
| [JP-127](https://eventuswh-analytics.atlassian.net/browse/JP-127) | Story | Run the weekly review that turns repeated friction into improvement tickets | JP-113, JP-120 |
| [JP-128](https://eventuswh-analytics.atlassian.net/browse/JP-128) | Task | Retire the sprint skill once the new graph has replaced it | JP-120 |
| [JP-129](https://eventuswh-analytics.atlassian.net/browse/JP-129) | Task | Close phase 2: prove action-triage is archived and the weekly review works, and collect the deletion list | JP-121, JP-122, JP-123, JP-126, JP-127, JP-128 |

## Phase 3: reflection

| Key | Type | Ticket | Blocked by |
| --- | --- | --- | --- |
| [JP-130](https://eventuswh-analytics.atlassian.net/browse/JP-130) | Research | Design the dashboard and the weekly priorities view | JP-120 |
| [JP-131](https://eventuswh-analytics.atlassian.net/browse/JP-131) | Story | Build the dashboard and the weekly priorities view | JP-129, JP-130 |
| [JP-132](https://eventuswh-analytics.atlassian.net/browse/JP-132) | Research | Design how personal work appears in Josh 360 | JP-120 |
| [JP-133](https://eventuswh-analytics.atlassian.net/browse/JP-133) | Story | Bring personal work into Josh 360 | JP-131, JP-132 |

## How to read this

JP-121, JP-122 and JP-123 moved from phase 2 to phase 1 on 16 November 2026, when Josh said all graphs are phase 1 (JP-147). Their links to JP-129 are kept from before. On 17 November Josh moved the forwarded-email run into the phase 1 close (JP-120), and JP-129 now proves action-triage archived and the weekly review's first improvement ticket.

"Blocked by" lists only the direct blockers, which are the Blocks links in Jira. A ticket can start when every ticket in that column is Done. Josh is needed at five points: the laptop hookup (JP-105), the phase 1 design questions (JP-106), and the close of each phase (JP-120, JP-129 and JP-133).
