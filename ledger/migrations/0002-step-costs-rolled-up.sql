-- JP-170: a step's cost with its subagents' cost folded in. Only adds views; `step_costs` stays as it was (a
-- migration never redefines a view), and `measures.py spend`, `measures.py ticket` and the run report read these.

-- The session each subagent's cost belongs to: follow parent_uid up through `subagent` links only, so a nested
-- subagent (S2 > S2a > S2b) lands on S2, and a subagent of a resumed session lands on that resumed session
-- (root_uid also climbs through resumes and forks, which are sessions of their own and keep their own rows).
-- A child with several subagent links uses its first. The depth limit stops a made-up loop.
CREATE VIEW session_subagent_roots AS
WITH RECURSIVE edge(child_uid, parent_uid) AS (
  SELECT l.child_uid, l.parent_uid FROM session_lineage l
  WHERE l.kind = 'subagent'
    AND l.id = (SELECT MIN(l2.id) FROM session_lineage l2 WHERE l2.child_uid = l.child_uid AND l2.kind = 'subagent')
), up(child_uid, top_uid, depth) AS (
  SELECT child_uid, parent_uid, 1 FROM edge
  UNION ALL
  SELECT up.child_uid, e.parent_uid, up.depth + 1 FROM up JOIN edge e ON e.child_uid = up.top_uid WHERE up.depth < 20
)
SELECT u.child_uid AS session_uid, u.top_uid
FROM up u
WHERE u.depth = (SELECT MAX(u2.depth) FROM up u2 WHERE u2.child_uid = u.child_uid)
  AND u.child_uid <> u.top_uid;

-- Each session's own cost, its subagents' cost, and the total. cost_usd is NULL when neither the session nor any
-- subagent has a price yet (not the same as nothing spent). own_pricing_status is NULL when the session has no cost rows.
CREATE VIEW session_costs_rolled_up AS
SELECT s.session_uid,
       t.cost_usd AS own_cost_usd,
       t.pricing_status AS own_pricing_status,
       COALESCE(a.subagents, 0) AS subagents,
       a.cost_usd AS subagent_cost_usd,
       COALESCE(a.not_fully_priced, 0) AS subagents_not_fully_priced,
       COALESCE(a.unpriced, 0) AS subagents_unpriced,
       CASE WHEN t.cost_usd IS NULL AND a.cost_usd IS NULL THEN NULL
            ELSE COALESCE(t.cost_usd, 0) + COALESCE(a.cost_usd, 0) END AS cost_usd
FROM sessions s
LEFT JOIN session_cost_totals t ON t.session_uid = s.session_uid
LEFT JOIN (
  SELECT r.top_uid AS top_uid, COUNT(*) AS subagents, SUM(st.cost_usd) AS cost_usd,
         SUM(CASE WHEN COALESCE(st.pricing_status, 'unpriced') <> 'priced' THEN 1 ELSE 0 END) AS not_fully_priced,
         SUM(CASE WHEN COALESCE(st.pricing_status, 'unpriced') = 'unpriced' THEN 1 ELSE 0 END) AS unpriced
  FROM session_subagent_roots r LEFT JOIN session_cost_totals st ON st.session_uid = r.session_uid
  GROUP BY r.top_uid
) a ON a.top_uid = s.session_uid;

-- Cost per step, the same columns as step_costs (cost_usd now includes the subagents) plus the parts. A gate or an
-- ask step has no session and no cost.
CREATE VIEW step_costs_rolled_up AS
SELECT l.run, l.step, l.attempt, l.loop_count, l.graph_id, l.graph_version, l.tier, l.model, l.ticket, l.started_at,
       l.session AS session_uid,
       c.cost_usd, c.own_cost_usd, c.subagent_cost_usd, c.own_pricing_status,
       c.subagents, c.subagents_not_fully_priced, c.subagents_unpriced
FROM step_ledger l LEFT JOIN session_costs_rolled_up c ON c.session_uid = l.session;
