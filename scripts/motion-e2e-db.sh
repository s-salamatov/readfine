#!/bin/sh
# Throwaway PostgreSQL for the motion run's e2e and visual checks: container
# rf-int-pg-motion (user rootless docker, postgres:16-alpine on tmpfs), published on
# 127.0.0.1:4253 only, database readfine_e2e. Reuses a ready container, otherwise
# recreates it, then waits up to 60 s until it accepts connections.
# Remove it afterwards: docker rm -f rf-int-pg-motion
C=rf-int-pg-motion;{ docker exec $C pg_isready -qh127.0.0.1 -Ureadfine||{ docker rm -f $C;docker run -d --name $C -e POSTGRES_USER=readfine -e POSTGRES_PASSWORD=readfine -e POSTGRES_DB=readfine_e2e -p 127.0.0.1:4253:5432 --tmpfs /var/lib/postgresql/data postgres:16-alpine;};}>/dev/null 2>&1;i=0;until docker exec $C pg_isready -qh127.0.0.1 -Ureadfine -dreadfine_e2e;do i=$((i+1));[ $i -lt 60 ]||exit 1;sleep 1;done

# Playwright starts the app (webServer) before its global setup migrates, and the app
# reads app_settings at startup, so a fresh database is migrated here first. (CI runs no
# Playwright; ci.yml migrates only before pytest.) Only this container's readfine_e2e;
# needs `uv` on PATH.
cd "$(dirname "$0")/../backend" || exit 1
DATABASE_URL=postgresql+asyncpg://readfine:readfine@127.0.0.1:4253/readfine_e2e \
SECRET_KEY=ci-test-secret-key-0123456789abcdef ENCRYPTION_KEY=ci0123456789abcdef0123456789abcd \
  uv run alembic upgrade head >/dev/null 2>&1 || { echo 'motion-e2e-db: alembic upgrade failed' >&2; exit 1; }
