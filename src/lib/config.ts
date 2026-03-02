import { z } from 'zod';

const envSchema = z.object({
  NEXT_PUBLIC_APP_URL: z.string().url().default('http://localhost:3000'),

  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  TOKEN_ENCRYPTION_KEY_B64: z.string().min(1),

  TESLA_CLIENT_ID: z.string().min(1).default('todo-client-id'),
  TESLA_CLIENT_SECRET: z.string().min(1).default('todo-client-secret'),
  TESLA_AUTH_BASE_URL: z.string().url().default('https://fleet-auth.prd.vn.cloud.tesla.com'),
  TESLA_API_BASE_URL: z.string().url().default('https://fleet-api.prd.na.vn.cloud.tesla.com'),
  TESLA_SCOPES: z.string().default('openid offline_access vehicle_device_data vehicle_cmds'),

  STOCKHOLM_BASE_URL: z.string().url().default('https://api-extern-webbtjanster.stockholm.se/ltf-tolken/v1'),
  STOCKHOLM_API_KEY: z.string().optional(),

  CRON_SECRET: z.string().min(1),
  DEV_USER_ID: z.string().uuid().default('00000000-0000-0000-0000-000000000001'),
  DEV_EXTERNAL_VEHICLE_ID: z.string().default('dev-vehicle-1'),

  DEFAULT_RADIUS_M: z.coerce.number().int().positive().default(50),
  STILL_MINUTES: z.coerce.number().int().positive().default(2),
  MAX_DRIFT_M: z.coerce.number().positive().default(50),
  SOFT_DELAY_MIN: z.coerce.number().int().positive().default(3),
  HARD_DELAY_MIN: z.coerce.number().int().positive().default(10),
  RULES_CHECK_TTL_SECONDS: z.coerce.number().int().positive().default(120),
});

export const config = envSchema.parse(process.env);
