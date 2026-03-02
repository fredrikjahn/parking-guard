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
