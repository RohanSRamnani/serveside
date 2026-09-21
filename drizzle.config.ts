import { defineConfig } from 'drizzle-kit'
import { config as loadEnv } from 'dotenv'

// drizzle-kit reads no .env file of its own, and the connection strings hold `&`,
// so the shell cannot safely pass them either. Load the file here instead and name
// it with ENV_FILE. The default is the *test* branch: a mistyped command should hit
// the branch nothing depends on.
loadEnv({ path: process.env.ENV_FILE ?? '.env.test', quiet: true })

export default defineConfig({
  schema: './src/db/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  // Migrations run as the table **owner**, never as `app_user`: app_user owns
  // nothing (that is what makes RLS bind it) and so cannot create or alter a table.
  dbCredentials: { url: process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL! },
})
