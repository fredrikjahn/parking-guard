create extension if not exists pgcrypto;

create type event_status as enum ('MOVING', 'PARKED', 'ENDED');
create type rule_severity as enum ('INFO', 'WARN', 'CRITICAL');
create type notification_kind as enum ('SOFT', 'HARD');

create table if not exists vehicle_providers (
  key text primary key,
  name text not null,
  auth_type text not null,
  created_at timestamptz not null default now()
);

create table if not exists rules_providers (
  key text primary key,
  name text not null,
  capabilities jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists vehicle_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  provider_key text not null references vehicle_providers(key),
  token_iv_b64 text not null,
  token_data_b64 text not null,
  expires_at timestamptz null,
  status text not null,
  created_at timestamptz not null default now()
);

create table if not exists vehicles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  provider_key text not null references vehicle_providers(key),
  external_vehicle_id text not null,
  display_name text not null,
  vin text null,
  created_at timestamptz not null default now(),
  unique(user_id, provider_key, external_vehicle_id)
);

create table if not exists jurisdictions (
  id uuid primary key default gen_random_uuid(),
  country text not null,
  name text not null,
  bbox jsonb null,
  created_at timestamptz not null default now()
);

create table if not exists rules_sources (
  id uuid primary key default gen_random_uuid(),
  jurisdiction_id uuid not null references jurisdictions(id) on delete cascade,
  provider_key text not null references rules_providers(key),
  config jsonb not null default '{}'::jsonb,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  unique(jurisdiction_id, provider_key)
);

create table if not exists parking_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  vehicle_id uuid not null references vehicles(id) on delete cascade,
  started_at timestamptz not null,
  last_seen_at timestamptz not null,
  lat numeric not null,
  lng numeric not null,
  status event_status not null,
  raw_samples jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists rule_hits (
  id uuid primary key default gen_random_uuid(),
  parking_event_id uuid not null references parking_events(id) on delete cascade,
  rules_source_id uuid not null references rules_sources(id) on delete cascade,
  rule_type text not null,
  severity rule_severity not null,
  summary text not null,
  raw_json jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists notification_log (
  id uuid primary key default gen_random_uuid(),
  parking_event_id uuid not null references parking_events(id) on delete cascade,
  kind notification_kind not null,
  sent_at timestamptz not null,
  user_action text null,
  created_at timestamptz not null default now()
);

create index if not exists idx_vehicle_connections_user_status
  on vehicle_connections(user_id, status, created_at desc);

create index if not exists idx_vehicles_user_provider
  on vehicles(user_id, provider_key, created_at asc);

create index if not exists idx_parking_events_vehicle_status
  on parking_events(vehicle_id, status, last_seen_at desc);

create index if not exists idx_rule_hits_event
  on rule_hits(parking_event_id, created_at desc);

create index if not exists idx_notification_event_kind
  on notification_log(parking_event_id, kind, created_at desc);
alter table vehicle_connections enable row level security;
alter table vehicles enable row level security;
alter table parking_events enable row level security;
alter table rule_hits enable row level security;
alter table notification_log enable row level security;

create policy vehicle_connections_own_rows
  on vehicle_connections
  for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy vehicles_own_rows
  on vehicles
  for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy parking_events_own_rows
  on parking_events
  for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy rule_hits_via_event_owner
  on rule_hits
  for all
  using (
    exists (
      select 1
      from parking_events pe
      where pe.id = rule_hits.parking_event_id
        and pe.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1
      from parking_events pe
      where pe.id = rule_hits.parking_event_id
        and pe.user_id = auth.uid()
    )
  );

create policy notification_log_via_event_owner
  on notification_log
  for all
  using (
    exists (
      select 1
      from parking_events pe
      where pe.id = notification_log.parking_event_id
        and pe.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1
      from parking_events pe
      where pe.id = notification_log.parking_event_id
        and pe.user_id = auth.uid()
    )
  );
insert into vehicle_providers (key, name, auth_type)
values ('tesla_fleet', 'Tesla Fleet', 'oauth2')
on conflict (key) do update
set name = excluded.name,
    auth_type = excluded.auth_type;

insert into rules_providers (key, name, capabilities)
values ('stockholm_ltf', 'Stockholm LTF', '{"within": true}'::jsonb)
on conflict (key) do update
set name = excluded.name,
    capabilities = excluded.capabilities;

with upserted as (
  insert into jurisdictions (country, name, bbox)
  values (
    'SE',
    'Stockholm stad',
    '{"minLat":59.20,"maxLat":59.45,"minLng":17.80,"maxLng":18.30}'::jsonb
  )
  on conflict do nothing
  returning id
), picked as (
  select id from upserted
  union all
  select id from jurisdictions where name = 'Stockholm stad' and country = 'SE' limit 1
)
insert into rules_sources (jurisdiction_id, provider_key, config, enabled)
select
  picked.id,
  'stockholm_ltf',
  '{"baseUrl":"https://api-extern-webbtjanster.stockholm.se/ltf-tolken/v1","apiKeyEnv":"STOCKHOLM_API_KEY"}'::jsonb,
  true
from picked
on conflict (jurisdiction_id, provider_key) do update
set config = excluded.config,
    enabled = excluded.enabled;
