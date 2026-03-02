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
