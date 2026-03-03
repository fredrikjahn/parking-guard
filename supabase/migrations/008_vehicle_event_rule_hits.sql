create table if not exists public.vehicle_event_rule_hits (
  id uuid primary key default gen_random_uuid(),
  vehicle_event_id uuid not null references public.vehicle_events(id) on delete cascade,
  provider_key text not null,
  rule_type text not null,
  severity text not null,
  summary text not null,
  raw_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_vehicle_event_rule_hits_event
  on public.vehicle_event_rule_hits(vehicle_event_id, created_at desc);
