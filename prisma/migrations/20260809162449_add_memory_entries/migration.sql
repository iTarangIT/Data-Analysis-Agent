-- Long-term memory (SAD §7, Phase 4E).
--
-- PURELY ADDITIVE. No existing table is altered, no column is dropped, no data
-- is moved and no backfill runs. Nothing in the telemetry path references these
-- objects, so applying this migration cannot change any existing answer.
--
-- Generated with `prisma migrate diff --from-config-datasource --to-schema`.
-- THREE `DROP TABLE` STATEMENTS WERE DELIBERATELY REMOVED from that output:
-- stg_battery, stg_can and stg_gps are the manual-import staging tables created
-- by docs/DATA-IMPORT.md §4.1. They are not modelled in schema.prisma, so the
-- differ proposes dropping them; they are part of the documented import
-- procedure and are none of this migration's business.

-- CreateEnum
CREATE TYPE "memory_kind" AS ENUM ('preferred_vehicle', 'preferred_metric', 'default_window_days', 'report_style');

-- CreateEnum
CREATE TYPE "memory_source" AS ENUM ('user_stated', 'user_confirmed');

-- CreateTable
CREATE TABLE "memory_entries" (
    "id" BIGSERIAL NOT NULL,
    "owner_id" TEXT NOT NULL,
    "kind" "memory_kind" NOT NULL,
    "value" JSONB NOT NULL,
    "source" "memory_source" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "memory_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- One value per preference per owner. This constraint IS the update-and-conflict
-- policy: setting a preference replaces the owner's existing value for that kind.
-- It also serves owner-scoped lookups via its leading column, so no separate
-- index on owner_id is needed.
CREATE UNIQUE INDEX "memory_entries_owner_id_kind_key" ON "memory_entries"("owner_id", "kind");
