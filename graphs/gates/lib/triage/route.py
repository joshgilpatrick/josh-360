"""The routing table (JP-122; spec, "Routing to exactly one graph"). Python 3.9, standard library only.

Routing uses the two fields every ticket has, type and Repository, because a hand-written ticket has no
`action-triage.spec`. The work kind (from that property, when there is one) only cross-checks `code`. A ticket gets
exactly one route or a conflict, which is a gap like any other. No priority, rank or area is read or returned.
"""
from __future__ import annotations

from typing import Optional, Tuple

DEVELOPMENT = "development"
NON_DEVELOPMENT = "non_development"
CONFLICT = "conflict"
# The name the route record and the target graph's `ready` gate use.
GRAPH_NAMES = {DEVELOPMENT: "development", NON_DEVELOPMENT: "non-development"}

# (type, has a repository) -> route. One row per case; anything not listed is a conflict.
TABLE = {
    ("Bug", True): DEVELOPMENT,
    ("Story", True): DEVELOPMENT,
    ("Task", True): DEVELOPMENT,
    ("Task", False): NON_DEVELOPMENT,
    ("Research", True): DEVELOPMENT,        # the design stretch only: it ends at an approved spec and plan
    ("Research", False): NON_DEVELOPMENT,
}


def decide_route(ticket_type: str, repository: str, work_kind: Optional[str]) -> Tuple[str, str]:
    """(route, reason). The reason is a fixed sentence, empty when the route is not a conflict."""
    has_repository = (repository or "").strip().lower() not in ("", "none")
    route = TABLE.get((ticket_type, has_repository))
    if route is None:
        return CONFLICT, "A {} with Repository {} has no route.".format(ticket_type, "named" if has_repository else "none")
    if (work_kind or "").strip().lower() == "code" and route != DEVELOPMENT:
        return CONFLICT, "The work kind is code but the Repository is none."
    return route, ""
