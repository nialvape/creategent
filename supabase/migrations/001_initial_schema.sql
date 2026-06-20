-- Enable UUID extension
create extension if not exists "pgcrypto";

-- ========== PROJECTS ==========
create table projects (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
  status text not null default 'draft'
    check (status in ('draft', 'planning', 'generating', 'completed', 'failed')),
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ========== CONVERSATIONS ==========
create table conversations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  thread_id text,
  messages jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id)
);

-- ========== CONTENT PLANS ==========
create table content_plans (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  plan jsonb not null default '{}'::jsonb,
  status text not null default 'proposed'
    check (status in ('proposed', 'approved', 'rejected', 'modified')),
  estimated_cost numeric(10, 4) default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ========== ASSETS ==========
create table assets (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  plan_id uuid references content_plans(id) on delete set null,
  type text not null check (type in ('image', 'video', 'audio', 'text', 'avatar')),
  name text not null,
  description text,
  status text not null default 'pending'
    check (status in ('pending', 'generating', 'completed', 'failed')),
  storage_path text,
  public_url text,
  specs jsonb not null default '{}'::jsonb,
  provider text,
  model text,
  estimated_cost numeric(10, 4),
  actual_cost numeric(10, 4),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ========== COST EVENTS ==========
create table cost_events (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  asset_id uuid references assets(id) on delete set null,
  provider text not null,
  model text not null,
  operation text not null,
  units numeric(10, 4) not null,
  unit_type text not null,
  cost_usd numeric(10, 6) not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- ========== PRICING CATALOG ==========
create table pricing_catalog (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  model text not null,
  unit_type text not null,
  price_usd numeric(10, 6) not null,
  notes text,
  updated_at timestamptz not null default now(),
  unique (provider, model)
);

-- ========== INDEXES ==========
create index idx_projects_status on projects(status);
create index idx_projects_updated on projects(updated_at desc);
create index idx_conversations_project on conversations(project_id);
create index idx_content_plans_project on content_plans(project_id);
create index idx_assets_project on assets(project_id);
create index idx_assets_status on assets(status);
create index idx_cost_events_project on cost_events(project_id);
create index idx_cost_events_asset on cost_events(asset_id);

-- ========== UPDATE TRIGGER ==========
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger set_updated_at_projects
  before update on projects
  for each row execute function update_updated_at();

create trigger set_updated_at_conversations
  before update on conversations
  for each row execute function update_updated_at();

create trigger set_updated_at_content_plans
  before update on content_plans
  for each row execute function update_updated_at();

create trigger set_updated_at_assets
  before update on assets
  for each row execute function update_updated_at();

-- ========== SEED PRICING CATALOG ==========
insert into pricing_catalog (provider, model, unit_type, price_usd, notes) values
  ('fal', 'fal-ai/flux-pro', 'per_image', 0.05, 'Flux Pro 1.1'),
  ('fal', 'fal-ai/flux/schnell', 'per_image', 0.003, 'Flux Schnell fast generation'),
  ('fal', 'fal-ai/flux/dev', 'per_image', 0.025, 'Flux Dev'),
  ('fal', 'fal-ai/kling-video/v2/master/image-to-video', 'per_5s_segment', 0.28, 'Kling V2 Master'),
  ('fal', 'fal-ai/minimax/video-01', 'per_5s_segment', 0.20, 'MiniMax Video 01'),
  ('elevenlabs', 'eleven_multilingual_v2', 'per_1k_characters', 0.30, 'Multilingual V2'),
  ('elevenlabs', 'eleven_turbo_v2_5', 'per_1k_characters', 0.18, 'Turbo V2.5'),
  ('openrouter', 'anthropic/claude-sonnet-4-6', 'per_1k_tokens', 0.003, 'Claude Sonnet 4.6'),
  ('openrouter', 'anthropic/claude-3-5-haiku', 'per_1k_tokens', 0.0008, 'Claude Haiku 3.5'),
  ('openrouter', 'openai/gpt-4o', 'per_1k_tokens', 0.0025, 'GPT-4o'),
  ('openrouter', 'openai/gpt-4o-mini', 'per_1k_tokens', 0.00015, 'GPT-4o mini'),
  ('openrouter', 'google/gemini-2.0-flash', 'per_1k_tokens', 0.0001, 'Gemini 2.0 Flash');

-- ========== STORAGE BUCKET ==========
-- Run this in Supabase dashboard or via API:
-- insert into storage.buckets (id, name, public) values ('assets', 'assets', true);
