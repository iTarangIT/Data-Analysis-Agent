-- CreateTable
CREATE TABLE "vehicles" (
    "id" BIGSERIAL NOT NULL,
    "vehicle_no" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vehicles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "battery_telemetry" (
    "id" BIGSERIAL NOT NULL,
    "vehicle_id" BIGINT NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL,
    "soc_pct" DECIMAL(5,2),
    "soh_pct" DECIMAL(5,2),
    "pack_voltage" DECIMAL(8,3),
    "pack_current" DECIMAL(8,3),
    "pack_temp_c" DECIMAL(6,2),
    "cell_min_mv" INTEGER,
    "cell_max_mv" INTEGER,
    "charging" BOOLEAN,
    "ingested_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "battery_telemetry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gps_telemetry" (
    "id" BIGSERIAL NOT NULL,
    "vehicle_id" BIGINT NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL,
    "lat" DECIMAL(9,6),
    "lon" DECIMAL(9,6),
    "speed_kph" DECIMAL(6,2),
    "heading" DECIMAL(5,2),
    "ignition" BOOLEAN,
    "gps_fix" BOOLEAN,
    "ext_voltage" DECIMAL(6,2),
    "ingested_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gps_telemetry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "can_telemetry" (
    "id" BIGSERIAL NOT NULL,
    "vehicle_id" BIGINT NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL,
    "payload" JSONB NOT NULL,
    "ingested_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "can_telemetry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "vehicles_vehicle_no_key" ON "vehicles"("vehicle_no");

-- CreateIndex
CREATE INDEX "battery_telemetry_vehicle_id_recorded_at_idx" ON "battery_telemetry"("vehicle_id", "recorded_at");

-- CreateIndex
CREATE INDEX "battery_telemetry_recorded_at_idx" ON "battery_telemetry"("recorded_at");

-- CreateIndex
CREATE INDEX "gps_telemetry_vehicle_id_recorded_at_idx" ON "gps_telemetry"("vehicle_id", "recorded_at");

-- CreateIndex
CREATE INDEX "gps_telemetry_recorded_at_idx" ON "gps_telemetry"("recorded_at");

-- CreateIndex
CREATE INDEX "can_telemetry_vehicle_id_recorded_at_idx" ON "can_telemetry"("vehicle_id", "recorded_at");

-- CreateIndex
CREATE INDEX "can_telemetry_recorded_at_idx" ON "can_telemetry"("recorded_at");

-- AddForeignKey
ALTER TABLE "battery_telemetry" ADD CONSTRAINT "battery_telemetry_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gps_telemetry" ADD CONSTRAINT "gps_telemetry_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "can_telemetry" ADD CONSTRAINT "can_telemetry_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
