import { supabaseAdmin } from '@/lib/db/client';

export type ParkingEventStatus = 'MOVING' | 'PARKED' | 'ENDED';
export type RuleSeverity = 'INFO' | 'WARN' | 'CRITICAL';
export type NotificationKind = 'SOFT' | 'HARD';

type DbResult<T> = {
  data: T | null;
  error: { message: string } | null;
};

export type VehicleConnectionRow = {
  id: string;
  user_id: string;
  provider_key: string;
  token_iv_b64: string;
  token_data_b64: string;
  fleet_api_base: string | null;
  expires_at: string | null;
  status: string;
  created_at: string;
};

export type VehicleRow = {
  id: string;
  user_id: string;
  provider_key: string;
  external_vehicle_id: string;
  display_name: string;
  vin: string | null;
  nickname: string | null;
  created_at: string;
};

export type ParkingEventRow = {
  id: string;
  user_id: string;
  vehicle_id: string;
  started_at: string;
  last_seen_at: string;
  lat: number;
  lng: number;
  status: ParkingEventStatus;
  raw_samples: unknown;
  created_at: string;
};

export type RuleHitRow = {
  id: string;
  parking_event_id: string;
  rules_source_id: string;
  rule_type: string;
  severity: RuleSeverity;
  summary: string;
  raw_json: unknown;
  created_at: string;
};

export type NotificationLogRow = {
  id: string;
  parking_event_id: string;
  kind: NotificationKind;
  sent_at: string;
  user_action: string | null;
  created_at: string;
};

export type VehicleLastLocationRow = {
  id: string;
  user_id: string;
  vehicle_id: string;
  lat: number;
  lng: number;
  gps_as_of: string | null;
  source: string;
  created_at: string;
  updated_at: string;
};

export type RulesSourceWithJurisdictionRow = {
  id: string;
  provider_key: string;
  config: Record<string, unknown> | null;
  enabled: boolean;
  jurisdiction:
    | {
        id: string;
        country: string;
        name: string;
        bbox: unknown;
      }
    | Array<{
        id: string;
        country: string;
        name: string;
        bbox: unknown;
      }>
    | null;
};

type VehicleConnectionInsert = {
  user_id: string;
  provider_key: string;
  token_iv_b64: string;
  token_data_b64: string;
  expires_at: string | null;
  status: string;
};

type VehicleInsert = {
  user_id: string;
  provider_key: string;
  external_vehicle_id: string;
  display_name: string;
  vin: string | null;
};

type ParkingEventInsert = {
  user_id: string;
  vehicle_id: string;
  started_at: string;
  last_seen_at: string;
  lat: number;
  lng: number;
  status: ParkingEventStatus;
  raw_samples: unknown;
};

type RuleHitInsert = {
  parking_event_id: string;
  rules_source_id: string;
  rule_type: string;
  severity: RuleSeverity;
  summary: string;
  raw_json: unknown;
};

type NotificationLogInsert = {
  parking_event_id: string;
  kind: NotificationKind;
  sent_at: string;
  user_action: string | null;
};

type VehicleLastLocationUpsert = {
  user_id: string;
  vehicle_id: string;
  lat: number;
  lng: number;
  gps_as_of: string | null;
  source: string;
  updated_at?: string;
};

async function requireData<T>(query: PromiseLike<DbResult<T>>, context: string): Promise<T> {
  const { data, error } = await query;
  if (error) {
    throw new Error(`${context}: ${error.message}`);
  }
  if (data === null) {
    throw new Error(`${context}: missing data`);
  }
  return data;
}

async function maybeData<T>(query: PromiseLike<DbResult<T>>, context: string): Promise<T | null> {
  const { data, error } = await query;
  if (error) {
    throw new Error(`${context}: ${error.message}`);
  }
  return data;
}

export const repo = {
  async createVehicleConnection(input: VehicleConnectionInsert): Promise<VehicleConnectionRow> {
    return requireData<VehicleConnectionRow>(
      supabaseAdmin.from('vehicle_connections').insert(input).select('*').single() as PromiseLike<
        DbResult<VehicleConnectionRow>
      >,
      'createVehicleConnection',
    );
  },

  async updateVehicleConnectionToken(
    id: string,
    payload: { token_iv_b64: string; token_data_b64: string; expires_at: string | null },
  ): Promise<VehicleConnectionRow> {
    return requireData<VehicleConnectionRow>(
      supabaseAdmin.from('vehicle_connections').update(payload).eq('id', id).select('*').single() as PromiseLike<
        DbResult<VehicleConnectionRow>
      >,
      'updateVehicleConnectionToken',
    );
  },

  async upsertVehicle(input: VehicleInsert): Promise<VehicleRow> {
    return requireData<VehicleRow>(
      supabaseAdmin
        .from('vehicles')
        .upsert(input, { onConflict: 'user_id,provider_key,external_vehicle_id' })
        .select('*')
        .single() as PromiseLike<DbResult<VehicleRow>>,
      'upsertVehicle',
    );
  },

  async getActiveConnectionAndVehicleForUser(
    userId: string,
  ): Promise<{ connection: VehicleConnectionRow | null; vehicle: VehicleRow | null }> {
    const connection = await maybeData<VehicleConnectionRow>(
      supabaseAdmin
        .from('vehicle_connections')
        .select('*')
        .eq('user_id', userId)
        .eq('status', 'active')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle() as PromiseLike<DbResult<VehicleConnectionRow>>,
      'getActiveConnectionAndVehicleForUser.connection',
    );

    if (!connection) {
      return { connection: null, vehicle: null };
    }

    const vehicle = await maybeData<VehicleRow>(
      supabaseAdmin
        .from('vehicles')
        .select('*')
        .eq('user_id', userId)
        .eq('provider_key', connection.provider_key)
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle() as PromiseLike<DbResult<VehicleRow>>,
      'getActiveConnectionAndVehicleForUser.vehicle',
    );

    return { connection, vehicle };
  },

  async getTeslaConnection(userId: string): Promise<VehicleConnectionRow | null> {
    return maybeData<VehicleConnectionRow>(
      supabaseAdmin
        .from('vehicle_connections')
        .select('*')
        .eq('user_id', userId)
        .eq('provider_key', 'tesla_fleet')
        .eq('status', 'active')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle() as PromiseLike<DbResult<VehicleConnectionRow>>,
      'getTeslaConnection',
    );
  },

  async setConnectionFleetBase(connectionId: string, baseUrl: string): Promise<VehicleConnectionRow> {
    return requireData<VehicleConnectionRow>(
      supabaseAdmin
        .from('vehicle_connections')
        .update({ fleet_api_base: baseUrl })
        .eq('id', connectionId)
        .select('*')
        .single() as PromiseLike<DbResult<VehicleConnectionRow>>,
      'setConnectionFleetBase',
    );
  },

  async getUserVehicleById(userId: string, vehicleId: string): Promise<VehicleRow | null> {
    return maybeData<VehicleRow>(
      supabaseAdmin
        .from('vehicles')
        .select('*')
        .eq('id', vehicleId)
        .eq('user_id', userId)
        .limit(1)
        .maybeSingle() as PromiseLike<DbResult<VehicleRow>>,
      'getUserVehicleById',
    );
  },

  async getOpenParkingEvent(vehicleId: string): Promise<ParkingEventRow | null> {
    return maybeData<ParkingEventRow>(
      supabaseAdmin
        .from('parking_events')
        .select('*')
        .eq('vehicle_id', vehicleId)
        .in('status', ['MOVING', 'PARKED'])
        .order('last_seen_at', { ascending: false })
        .limit(1)
        .maybeSingle() as PromiseLike<DbResult<ParkingEventRow>>,
      'getOpenParkingEvent',
    );
  },

  async createParkingEvent(input: ParkingEventInsert): Promise<ParkingEventRow> {
    return requireData<ParkingEventRow>(
      supabaseAdmin.from('parking_events').insert(input).select('*').single() as PromiseLike<
        DbResult<ParkingEventRow>
      >,
      'createParkingEvent',
    );
  },

  async updateParkingEvent(
    id: string,
    patch: Partial<
      Pick<ParkingEventInsert, 'started_at' | 'last_seen_at' | 'lat' | 'lng' | 'status' | 'raw_samples'>
    >,
  ): Promise<ParkingEventRow> {
    return requireData<ParkingEventRow>(
      supabaseAdmin.from('parking_events').update(patch).eq('id', id).select('*').single() as PromiseLike<
        DbResult<ParkingEventRow>
      >,
      'updateParkingEvent',
    );
  },

  async insertRuleHits(hits: RuleHitInsert[]): Promise<RuleHitRow[]> {
    if (hits.length === 0) {
      return [];
    }

    return requireData<RuleHitRow[]>(
      supabaseAdmin.from('rule_hits').insert(hits).select('*') as PromiseLike<DbResult<RuleHitRow[]>>,
      'insertRuleHits',
    );
  },

  async hasNotificationKind(parkingEventId: string, kind: NotificationKind): Promise<boolean> {
    const row = await maybeData<{ id: string }>(
      supabaseAdmin
        .from('notification_log')
        .select('id')
        .eq('parking_event_id', parkingEventId)
        .eq('kind', kind)
        .limit(1)
        .maybeSingle() as PromiseLike<DbResult<{ id: string }>>,
      'hasNotificationKind',
    );

    return Boolean(row);
  },

  async logNotification(input: NotificationLogInsert): Promise<NotificationLogRow> {
    return requireData<NotificationLogRow>(
      supabaseAdmin.from('notification_log').insert(input).select('*').single() as PromiseLike<
        DbResult<NotificationLogRow>
      >,
      'logNotification',
    );
  },

  async upsertVehicleLastLocation(input: VehicleLastLocationUpsert): Promise<VehicleLastLocationRow> {
    const payload = {
      ...input,
      updated_at: input.updated_at ?? new Date().toISOString(),
    };

    return requireData<VehicleLastLocationRow>(
      supabaseAdmin
        .from('vehicle_last_locations')
        .upsert(payload, { onConflict: 'vehicle_id' })
        .select('*')
        .single() as PromiseLike<DbResult<VehicleLastLocationRow>>,
      'upsertVehicleLastLocation',
    );
  },

  async getVehicleLastLocation(userId: string, vehicleId: string): Promise<VehicleLastLocationRow | null> {
    return maybeData<VehicleLastLocationRow>(
      supabaseAdmin
        .from('vehicle_last_locations')
        .select('*')
        .eq('user_id', userId)
        .eq('vehicle_id', vehicleId)
        .limit(1)
        .maybeSingle() as PromiseLike<DbResult<VehicleLastLocationRow>>,
      'getVehicleLastLocation',
    );
  },

  async listEnabledRulesSourcesWithJurisdiction(): Promise<RulesSourceWithJurisdictionRow[]> {
    const { data, error } = (await supabaseAdmin
      .from('rules_sources')
      .select('id,provider_key,config,enabled,jurisdiction:jurisdictions(id,country,name,bbox)')
      .eq('enabled', true)) as DbResult<RulesSourceWithJurisdictionRow[]>;

    if (error) {
      throw new Error(`listEnabledRulesSourcesWithJurisdiction: ${error.message}`);
    }

    return data ?? [];
  },
};
