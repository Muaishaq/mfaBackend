-- Add course detail fields present in schema.prisma but missing from the database
ALTER TABLE "courses" ADD COLUMN IF NOT EXISTS "prerequisites" TEXT;
ALTER TABLE "courses" ADD COLUMN IF NOT EXISTS "duration" TEXT;
ALTER TABLE "courses" ADD COLUMN IF NOT EXISTS "schedule" TEXT;
ALTER TABLE "courses" ADD COLUMN IF NOT EXISTS "level" TEXT NOT NULL DEFAULT 'beginner';
ALTER TABLE "courses" ADD COLUMN IF NOT EXISTS "certificate" BOOLEAN NOT NULL DEFAULT false;
