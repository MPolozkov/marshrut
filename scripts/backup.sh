#!/bin/sh
# Ежедневная резервная копия базы и загруженных файлов.
# Добавьте в cron на сервере:  15 3 * * *  /opt/marshrut/scripts/backup.sh >> /var/log/marshrut-backup.log 2>&1
set -e
cd "$(dirname "$0")/.."
DIR=${BACKUP_DIR:-/var/backups/marshrut}
STAMP=$(date +%Y-%m-%d_%H%M)
mkdir -p "$DIR"
docker compose exec -T db pg_dump -U marshrut -Fc marshrut > "$DIR/db_$STAMP.dump"
docker compose run --rm -T -v "$DIR:/backup" --entrypoint sh api -c "tar czf /backup/uploads_$STAMP.tgz -C /data uploads"
# Храним 14 последних копий. Копируйте папку в другое хранилище (S3, второй сервер).
ls -1t "$DIR"/db_*.dump | tail -n +15 | xargs -r rm --
ls -1t "$DIR"/uploads_*.tgz | tail -n +15 | xargs -r rm --
echo "$(date) backup ok: $DIR/db_$STAMP.dump"
# Восстановление: docker compose exec -T db pg_restore -U marshrut -d marshrut --clean < файл.dump
