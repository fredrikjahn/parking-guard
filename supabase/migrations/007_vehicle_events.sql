create table if not exists public.vehicle_events (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid not null references public.vehicles(id) on delete cascade,
  type text not null,
  ts timestamptz not null,
  lat numeric null,
  lng numeric null,
  speed_kph numeric null,
  shift_state text null,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_vehicle_events_vehicle_ts
  on public.vehicle_events(vehicle_id, ts desc);

create index if not exists idx_vehicle_events_vehicle_type_ts
  on public.vehicle_events(vehicle_id, type, ts desc);

alter table public.vehicle_events enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'vehicle_events'
      and policyname = 'vehicle_events_own_rows'
  ) then
    create policy vehicle_events_own_rows
      on public.vehicle_events
      for all
      using (
        exists (
          select 1
          from public.vehicles v
          where v.id = vehicle_events.vehicle_id
            and v.user_id = auth.uid()
        )
      )
      with check (
        exists (
          select 1
          from public.vehicles v
          where v.id = vehicle_events.vehicle_id
            and v.user_id = auth.uid()
        )
      );
  end if;
end $$;
