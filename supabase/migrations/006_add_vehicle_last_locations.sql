create table if not exists public.vehicle_last_locations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  vehicle_id uuid not null references public.vehicles(id) on delete cascade,
  lat numeric not null,
  lng numeric not null,
  gps_as_of timestamptz null,
  source text not null default 'telemetry',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (vehicle_id)
);

create index if not exists idx_vehicle_last_locations_user_vehicle
  on public.vehicle_last_locations(user_id, vehicle_id);

alter table public.vehicle_last_locations enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'vehicle_last_locations'
      and policyname = 'vehicle_last_locations_own_rows'
  ) then
    create policy vehicle_last_locations_own_rows
      on public.vehicle_last_locations
      for all
      using (user_id = auth.uid())
      with check (user_id = auth.uid());
  end if;
end $$;
