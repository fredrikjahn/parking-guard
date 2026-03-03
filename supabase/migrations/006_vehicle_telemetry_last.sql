create table if not exists public.vehicle_telemetry_last (
  vehicle_id uuid primary key references public.vehicles(id) on delete cascade,
  ts timestamptz not null,
  lat numeric null,
  lng numeric null,
  speed_kph numeric null,
  shift_state text null,
  updated_at timestamptz not null default now()
);

create index if not exists idx_vehicle_telemetry_last_ts
  on public.vehicle_telemetry_last(ts desc);

alter table public.vehicle_telemetry_last enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'vehicle_telemetry_last'
      and policyname = 'vehicle_telemetry_last_own_rows'
  ) then
    create policy vehicle_telemetry_last_own_rows
      on public.vehicle_telemetry_last
      for all
      using (
        exists (
          select 1
          from public.vehicles v
          where v.id = vehicle_telemetry_last.vehicle_id
            and v.user_id = auth.uid()
        )
      )
      with check (
        exists (
          select 1
          from public.vehicles v
          where v.id = vehicle_telemetry_last.vehicle_id
            and v.user_id = auth.uid()
        )
      );
  end if;
end $$;
