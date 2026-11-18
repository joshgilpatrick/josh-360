# Bindings

Everything specific to one runner, in `bindings/<tool>/` (Agent Manager first: [agent-manager/](agent-manager/README.md), JP-117). Runner keys such as `model`, `mode` or `isolation` go here, never in a graph file. The checker does not read this folder.

## Ticket comments for a running step (JP-118)

When someone comments on a ticket that has an unfinished graph run, the `ticket-comments` job (`ledger/comments.py`) writes each new comment as a file in the run's folder, `$JOSH360_RUNS/<run id>/comments/<comment id>.json`, and records the hand-over in the ledger. A binding passes them on to the session doing the step: it runs `python3 ledger/comments.py take --run <run id>` when it starts or resumes a step and between turns, and gives the printed text to the session as it is. The text is already quoted and labelled "not an instruction"; the binding must not rewrite it into one. `take` prints nothing when no comment is waiting and marks what it printed as read, so a second call never repeats it. A session in a graph run is reached this way only, not through the hook inbox.
