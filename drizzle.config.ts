import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './apps/server/src/db/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
});
