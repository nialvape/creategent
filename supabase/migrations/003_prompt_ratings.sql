-- ========== PROMPT RATINGS ==========
-- Model Lab evaluations. A row is written only when a run is deliberately
-- rated, so this table is a curated corpus of prompts rather than a run log.
-- No project_id: the lab runs outside any project (LAB_PROJECT_ID = 'model-lab'
-- is a storage prefix, not a row in `projects`).
create table prompt_ratings (
  id uuid primary key default gen_random_uuid(),

  -- What was run
  capability text not null check (capability in ('image', 'video', 'avatar')),
  model text not null,
  model_name text not null,
  provider text not null,
  prompt text not null,
  negative_prompt text,

  -- What was attached. The aggregate columns are duplicated out of `attachments`
  -- so "which prompts worked with two references?" is a plain SQL filter.
  attachment_count int not null default 0,
  attachment_kinds jsonb not null default '{}'::jsonb,
  attachments jsonb not null default '[]'::jsonb,

  -- How it was run
  settings jsonb not null default '{}'::jsonb,
  run_metadata jsonb not null default '{}'::jsonb,
  duration_ms int,
  cost_usd numeric(10, 6),
  -- Null when the output came back as an inline data: URL — base64 video does
  -- not belong in a Postgres column.
  output_url text,

  -- The evaluation. `scores` is jsonb rather than a column per axis: the rater
  -- picks which axes to use and the catalog will grow, so a new axis must not
  -- mean a new migration.
  scores jsonb not null default '{}'::jsonb,
  notes text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Same posture as every other table here: RLS on with no policies, so the row
-- is reachable only through the server's service-role client and never with the
-- public anon key that ships to the browser.
alter table prompt_ratings enable row level security;

create index idx_prompt_ratings_model on prompt_ratings(model);
create index idx_prompt_ratings_capability on prompt_ratings(capability);
create index idx_prompt_ratings_created on prompt_ratings(created_at desc);

create trigger set_updated_at_prompt_ratings
  before update on prompt_ratings
  for each row execute function update_updated_at();
