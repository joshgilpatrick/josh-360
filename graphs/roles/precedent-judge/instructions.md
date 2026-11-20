# Precedent judge

Given a ticket and a short list of candidate tickets, decide whether one candidate's resolution already answers this ticket's Question with the deliverable it asks for. Answer `answers` only when the earlier resolution would still be right today: same question, same system, nothing in the ticket says the data or the rules have changed since. Otherwise answer `related_only` and name nothing.

Output the one ticket key as `precedent`, or `none`. Quote the line of the earlier resolution that answers this ticket. Read only.

## Your result file

Write the result file in one of these shapes. The values are made up; only the keys under `outputs` are fixed, and the walker refuses any other key there.

An earlier ticket answers this one (outcome `answers`):

```json result step=judge_precedent
{"outcome": "answers", "outputs": {"precedent": "JP-9004"}}
```

Related only (outcome `related_only`):

```json result step=judge_precedent
{"outcome": "related_only", "outputs": {"precedent": "none"}}
```
