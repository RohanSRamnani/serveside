// Re-exports every table, enum and relation in the schema.
// Each schema file (tenancy, menu, snapshots, hours, orders, platform) is added
// here as it lands; `db()` and drizzle-kit both read the schema through this file.
export * from './tenancy'
export * from './menu'
export * from './snapshots'
export * from './hours'
export * from './orders'
export * from './platform'
