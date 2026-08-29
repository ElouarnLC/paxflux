import { z } from 'zod';

export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().default(3000),
  DATA_DIR: z.string().default('./data'),
  BACKUP_DIR: z.string().default('./backups'),
  PUBLIC_BASE_URL: z.string().url().optional(),
  TZ: z.string().default('Europe/Paris'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  TRUST_PROXY: z.preprocess((val) => {
    if (typeof val === 'string') {
      if (val.toLowerCase() === 'true') return true;
      if (val.toLowerCase() === 'false') return false;
      return val;
    }
    return val;
  }, z.union([z.boolean(), z.string()])).default(false),
  BACKUP_INTERVAL_LIVE_MINUTES: z.coerce.number().int().min(1).default(5),
  BACKUP_RETENTION_COUNT: z.coerce.number().int().min(1).default(300),
  PAIRING_TTL_MINUTES: z.coerce.number().int().min(1).default(30),
  STAFF_SESSION_HOURS: z.coerce.number().int().min(1).default(12),
  DEVICE_SESSION_GRACE_HOURS: z.coerce.number().int().min(1).default(24),
  ENABLE_SWAGGER: z.preprocess((val) => val === 'true' || val === true, z.boolean()).default(false),
});

export type Env = z.infer<typeof EnvSchema>;

export function parseEnv(processEnv: Record<string, string | undefined> = process.env): Env {
  const result = EnvSchema.safeParse(processEnv);
  if (!result.success) {
    console.error('Invalid environment configuration:', result.error.format());
    throw new Error('Invalid environment configuration');
  }
  return result.data;
}
