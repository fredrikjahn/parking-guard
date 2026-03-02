alter table if exists vehicle_connections
  add column if not exists fleet_api_base text null;
