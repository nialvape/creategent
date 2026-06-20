# Agent Graph

## Flow at a glance

```
START → planner → await_approval ──(approved)──→ supervisor → END
                       │                              ↑
                       └──(rejected / feedback)──→ planner
```

The graph has **3 nodes**. Everything else (creative direction, per-asset agents, wave execution) lives inside `supervisor`.

---

## Nodes

### 1. `planner` — [`nodes/planner.ts`](nodes/planner.ts)

Asks the LLM to produce a **ContentPlan**: an ordered list of typed assets (text, image, video, audio, avatar) with dependencies and cost estimates.

- Models are **never chosen by the LLM** — they come from the project's settings and are stamped on each asset by `assignAssetModels()`.
- After generation the plan is validated (`validatePlanRules`). If it breaks a structural rule (e.g. missing Script, video with no first-frame image) the planner re-prompts **once** for a repair.
- On re-entry after a rejection the conversation messages carry the user's feedback, so the LLM revises the plan.
- Outputs: `plan`, `planStatus: 'proposed'`, `status: 'awaiting_approval'`.

### 2. `await_approval` — [`nodes/human-approval.ts`](nodes/human-approval.ts)

Pauses the graph with `interrupt()` so the UI can show the plan to the user.

| Decision | Next node |
|---|---|
| `'approved'` | `supervisor` |
| `'rejected'` or feedback object | `planner` |

Nothing is generated here. The graph simply waits for a `Command` resume from the API route.

### 3. `supervisor` — [`nodes/supervisor.ts`](nodes/supervisor.ts)

The full generation engine. Runs once per approved plan and does everything below in order.

#### 3a. Creative Director sets direction
`establishDirection()` asks the LLM for a short global **style brief** (5–8 lines): tone, visual style, mood. This anchor is passed to every agent so outputs feel coherent.

#### 3b. Wave execution loop
Assets are sorted into **dependency waves** by `computeWaves()`. Assets in the same wave have no dependency on each other and run in parallel; later waves wait for earlier ones.

Example for a typical Reel:
```
Wave 0 → [Script (text)]
Wave 1 → [First-frame image, Voiceover (audio)]   ← both depend on Script
Wave 2 → [Video]                                   ← depends on image
```

**Each wave goes through 4 steps:**

| Step | What happens |
|---|---|
| **Brief** | `briefWave()` — Director writes a per-asset instruction using earlier wave output as context |
| **Generate** | Each asset type runs its own agent in parallel (`copyAgentNode`, `visualAgentNode`, `videoAgentNode`, `audioAgentNode`, `avatarAgentNode`) |
| **Review** | `reviewWave()` — Director scores each output; flags any that miss the brief |
| **Correct** | Failed/weak assets are re-run once with the director's feedback appended to their brief |

After each wave the assets are **persisted to Supabase**, so a crash mid-generation doesn't lose finished work.

#### 3c. Final review
`finalReview()` gives the Director a holistic look at the whole package: an overall score (0–100), per-asset scores, and improvement suggestions. The result lands in `state.reviewResult`.

---

## State — [`state.ts`](state.ts)

The single object that flows through every node. Key fields:

| Field | Set by | Purpose |
|---|---|---|
| `userIdea` | API route | The user's original prompt |
| `plan` | planner | The list of assets to generate |
| `planStatus` | planner / await_approval | `proposed` → `approved` / `rejected` |
| `styleBrief` | supervisor | Global creative anchor from Director |
| `assetBriefs` | supervisor | Per-asset instructions, keyed by plan asset id |
| `directorContext` | supervisor | Director's running notes across waves |
| `assets` | supervisor | Generated assets (merged, never replaced) |
| `reviewResult` | supervisor | Final quality score |
| `status` | each node | `idle` → `planning` → `awaiting_approval` → `generating` → `completed` / `failed` |
| `actualCost` | supervisor | Accumulates — **additive** reducer, not last-wins |
| `errors` | any node | Accumulates across nodes |

---

## Checkpointing

`PostgresSaver` writes a snapshot after every node. The thread ID equals the project ID, so:
- The plan-approval interrupt survives a server restart.
- Generation can resume if the server crashes mid-wave.

Connection string comes from `DATABASE_URL` or `SUPABASE_DB_URL`.
