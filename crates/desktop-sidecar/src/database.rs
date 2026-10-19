use rusqlite::{backup::Backup, Connection, DatabaseName};
use serde_json::{json, Value};
use std::env;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

fn string_param(params: &Value, key: &str) -> Result<String, String> {
    params
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| format!("Missing string parameter: {key}"))
}

pub(crate) fn data_dir() -> PathBuf {
    let args: Vec<String> = env::args().collect();
    args.windows(2)
        .find(|pair| pair[0] == "--data-dir")
        .map(|pair| PathBuf::from(&pair[1]))
        .unwrap_or_else(|| PathBuf::from(".edgeever-desktop"))
}

pub(crate) fn migrations_dir() -> PathBuf {
    let args: Vec<String> = env::args().collect();
    args.windows(2)
        .find(|pair| pair[0] == "--migrations-dir")
        .map(|pair| PathBuf::from(&pair[1]))
        .unwrap_or_else(|| PathBuf::from("migrations"))
}

fn restrict_directory(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        let mut permissions = fs::metadata(path)?.permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(path, permissions)?;
    }
    Ok(())
}

fn restrict_file(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        if path.exists() {
            let mut permissions = fs::metadata(path)?.permissions();
            permissions.set_mode(0o600);
            fs::set_permissions(path, permissions)?;
        }
    }
    Ok(())
}

fn apply_migrations(connection: &Connection, migrations: &Path) -> rusqlite::Result<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS _edgeever_migrations (
           name TEXT PRIMARY KEY,
           applied_at TEXT NOT NULL
         );",
    )?;

    let mut files: Vec<PathBuf> = fs::read_dir(migrations)
        .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?
        .filter_map(|entry| entry.ok().map(|item| item.path()))
        .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("sql"))
        .collect();
    files.sort();

    for path in files {
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        let already_applied: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM _edgeever_migrations WHERE name = ?1)",
            [name],
            |row| row.get(0),
        )?;
        if already_applied {
            continue;
        }

        let sql = fs::read_to_string(&path)
            .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
        let transaction = connection.unchecked_transaction()?;
        transaction.execute_batch(&sql)?;
        transaction.execute(
            "INSERT INTO _edgeever_migrations (name, applied_at) VALUES (?1, datetime('now'))",
            [name],
        )?;
        transaction.commit()?;
    }
    Ok(())
}

pub(crate) fn ensure_sidecar_schema(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS _edgeever_sidecar_meta (
           key TEXT PRIMARY KEY,
           value TEXT NOT NULL,
           updated_at TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS _edgeever_sidecar_outbox (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           kind TEXT NOT NULL,
           entity_id TEXT NOT NULL,
           payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
           status TEXT NOT NULL DEFAULT 'pending',
           attempt_count INTEGER NOT NULL DEFAULT 0,
           last_error TEXT,
           last_error_code TEXT,
           retryable INTEGER NOT NULL DEFAULT 1,
           next_attempt_at TEXT,
           version INTEGER NOT NULL DEFAULT 1,
           created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
           updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         );
         CREATE INDEX IF NOT EXISTS idx_sidecar_outbox_status ON _edgeever_sidecar_outbox(status, id);",
    )?;

    // Offline snapshots of group-shared notes. These live in other
    // workspaces and are never part of the local mirror; the table keeps
    // them strictly separate so no list query can leak them into the
    // personal workspace. Rows are refreshed while online and pruned the
    // moment access disappears (see shared.snapshot.prune).
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS shared_memo_snapshots (
           memo_id TEXT PRIMARY KEY,
           group_id TEXT,
           group_name TEXT,
           notebook_id TEXT,
           title TEXT,
           excerpt TEXT NOT NULL DEFAULT '',
           tags_json TEXT NOT NULL DEFAULT '[]',
           content_json TEXT NOT NULL,
           content_markdown TEXT NOT NULL DEFAULT '',
           content_text TEXT NOT NULL DEFAULT '',
           content_hash TEXT NOT NULL DEFAULT '',
           revision INTEGER NOT NULL DEFAULT 0,
           display_policy_json TEXT,
           memo_created_at TEXT NOT NULL,
           memo_updated_at TEXT NOT NULL,
           snapshot_at TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_shared_snapshots_group ON shared_memo_snapshots(group_id);",
    )?;

    let columns = connection
        .prepare("PRAGMA table_info(_edgeever_sidecar_outbox)")?
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?;
    if !columns.iter().any(|name| name == "version") {
        connection.execute(
            "ALTER TABLE _edgeever_sidecar_outbox ADD COLUMN version INTEGER NOT NULL DEFAULT 1",
            [],
        )?;
    }
    if !columns.iter().any(|name| name == "last_error_code") {
        connection.execute(
            "ALTER TABLE _edgeever_sidecar_outbox ADD COLUMN last_error_code TEXT",
            [],
        )?;
    }
    if !columns.iter().any(|name| name == "retryable") {
        connection.execute(
            "ALTER TABLE _edgeever_sidecar_outbox ADD COLUMN retryable INTEGER NOT NULL DEFAULT 1",
            [],
        )?;
    }
    if !columns.iter().any(|name| name == "next_attempt_at") {
        connection.execute(
            "ALTER TABLE _edgeever_sidecar_outbox ADD COLUMN next_attempt_at TEXT",
            [],
        )?;
    }
    requeue_recoverable_missing_memo_batches(connection)?;
    Ok(())
}

/// Older clients stored temporary memo ids in batch payloads, so a move or pin
/// that raced a create acknowledgement failed permanently with
/// `missing_memos`/`not_found`. Current clients resolve those items instead of
/// wedging the sync badge, but a terminal error is never retried automatically.
/// Requeue them once so an upgrade heals existing failures without user action.
pub(crate) fn requeue_recoverable_missing_memo_batches(
    connection: &Connection,
) -> rusqlite::Result<()> {
    const REPAIR_KEY: &str = "repair.requeue_missing_memo_batches";
    let applied: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM _edgeever_sidecar_meta WHERE key = ?1)",
        [REPAIR_KEY],
        |row| row.get(0),
    )?;
    if applied {
        return Ok(());
    }
    connection.execute(
        "UPDATE _edgeever_sidecar_outbox
            SET status = 'pending', retryable = 1, next_attempt_at = NULL,
                last_error = NULL, last_error_code = NULL,
                version = version + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE status = 'error'
            AND ((kind = 'memo.move' AND last_error_code = 'missing_memos')
              OR (kind = 'memo.pinBatch' AND last_error_code IN ('not_found', 'http_404')))",
        [],
    )?;
    connection.execute(
        "INSERT INTO _edgeever_sidecar_meta (key, value, updated_at)
         VALUES (?1, '1', strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
        [REPAIR_KEY],
    )?;
    Ok(())
}

fn copy_directory(source: &Path, destination: &Path) -> io::Result<()> {
    if !source.exists() {
        return Ok(());
    }
    fs::create_dir_all(destination)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        if source_path.is_dir() {
            copy_directory(&source_path, &destination_path)?;
        } else {
            fs::copy(source_path, destination_path)?;
        }
    }
    Ok(())
}

pub(crate) fn backup_database(connection: &Connection, root: &Path) -> rusqlite::Result<PathBuf> {
    let backup_dir = root.join("backups");
    fs::create_dir_all(&backup_dir)
        .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
    restrict_directory(&backup_dir)
        .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
    let backup_path = backup_dir.join(format!(
        "edgeever-{}.sqlite",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    ));
    let backup_path_text = backup_path.to_string_lossy().to_string();
    connection.execute("VACUUM INTO ?1", [&backup_path_text])?;
    restrict_file(&backup_path)
        .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
    let resource_backup = backup_path.with_extension("resources");
    fs::remove_dir_all(&resource_backup).ok();
    copy_directory(&root.join("resource-outbox"), &resource_backup)
        .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
    let mut backups: Vec<PathBuf> = fs::read_dir(&backup_dir)
        .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?
        .filter_map(|entry| entry.ok().map(|item| item.path()))
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .map(|name| name.starts_with("edgeever-") && name.ends_with(".sqlite"))
                .unwrap_or(false)
        })
        .collect();
    backups.sort();
    while backups.len() > 5 {
        if let Some(oldest) = backups.first() {
            fs::remove_file(oldest)
                .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
            fs::remove_dir_all(oldest.with_extension("resources")).ok();
        }
        backups.remove(0);
    }
    Ok(backup_path)
}

pub(crate) fn list_backups(root: &Path) -> rusqlite::Result<Value> {
    let backup_dir = root.join("backups");
    fs::create_dir_all(&backup_dir)
        .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
    let mut backups = Vec::new();
    for entry in fs::read_dir(&backup_dir)
        .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?
    {
        let path = entry
            .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?
            .path();
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_owned();
        if !name.starts_with("edgeever-") || !name.ends_with(".sqlite") {
            continue;
        }
        let metadata = fs::metadata(&path)
            .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
        let modified_at = metadata
            .modified()
            .ok()
            .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
            .map(|value| value.as_secs().to_string())
            .unwrap_or_default();
        backups.push(json!({ "path": path.to_string_lossy(), "name": name, "size": metadata.len(), "modifiedAt": modified_at }));
    }
    backups.sort_by(|left, right| {
        right
            .get("name")
            .and_then(Value::as_str)
            .cmp(&left.get("name").and_then(Value::as_str))
    });
    Ok(json!({ "backups": backups }))
}

pub(crate) fn restore_database(
    database: &mut Connection,
    root: &Path,
    migrations: &Path,
    params: &Value,
) -> Result<Value, String> {
    let requested = string_param(params, "path")?;
    let backup_dir = root
        .join("backups")
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let backup_path = PathBuf::from(requested)
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if backup_path.parent() != Some(backup_dir.as_path())
        || backup_path.extension().and_then(|value| value.to_str()) != Some("sqlite")
    {
        return Err("Backup path must point to a managed EdgeEver backup".to_owned());
    }

    // Windows refuses to rotate/delete a backup while a read connection still
    // holds the managed file open. Restore from a temporary copy so retention
    // can safely remove the selected snapshot when it is the oldest one.
    let source_copy = root.join(".edgeever-restore-source.sqlite");
    fs::remove_file(&source_copy).ok();
    fs::copy(&backup_path, &source_copy).map_err(|error| error.to_string())?;
    let source = Connection::open(&source_copy).map_err(|error| error.to_string())?;
    // A protective backup rotates the five-file retention window. Preserve the
    // selected snapshot's resource companion before that rotation can remove
    // it when the user restores the oldest retained backup.
    let resource_backup = backup_path.with_extension("resources");
    let resource_restore_source = root.join("resource-outbox.restore-source");
    fs::remove_dir_all(&resource_restore_source).ok();
    if resource_backup.is_dir() {
        copy_directory(&resource_backup, &resource_restore_source)
            .map_err(|error| error.to_string())?;
    }
    // Open the selected snapshot before rotation: if it is the oldest of the
    // five retained files, the protective backup may remove its directory
    // entry while this read-only connection keeps the snapshot available.
    let protective_backup = backup_database(&*database, root).map_err(|error| error.to_string())?;
    let backup = Backup::new_with_names(&source, DatabaseName::Main, database, DatabaseName::Main)
        .map_err(|error| error.to_string())?;
    backup
        .run_to_completion(100, Duration::from_millis(5), None)
        .map_err(|error| error.to_string())?;
    drop(backup);
    drop(source);
    fs::remove_file(&source_copy).map_err(|error| error.to_string())?;
    apply_migrations(database, migrations).map_err(|error| error.to_string())?;
    ensure_sidecar_schema(database).map_err(|error| error.to_string())?;
    let resource_source = if resource_restore_source.is_dir() {
        resource_restore_source.as_path()
    } else {
        resource_backup.as_path()
    };
    if resource_source.is_dir() {
        let restored_resources = root.join("resource-outbox.restore");
        fs::remove_dir_all(&restored_resources).ok();
        copy_directory(resource_source, &restored_resources).map_err(|error| error.to_string())?;
        fs::remove_dir_all(root.join("resource-outbox")).ok();
        fs::rename(restored_resources, root.join("resource-outbox"))
            .map_err(|error| error.to_string())?;
    }
    fs::remove_dir_all(&resource_restore_source).ok();
    Ok(json!({ "ok": true, "path": protective_backup }))
}

pub(crate) fn open_database(root: &Path, migrations: &Path) -> rusqlite::Result<Connection> {
    fs::create_dir_all(root)
        .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
    restrict_directory(root)
        .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
    let existed = root.join("edgeever.sqlite").exists();
    let connection = Connection::open(root.join("edgeever.sqlite"))?;
    connection.pragma_update(None, "journal_mode", "WAL")?;
    ensure_sidecar_schema(&connection)?;
    if existed {
        backup_database(&connection, root)?;
    }
    apply_migrations(&connection, migrations)?;
    for path in [
        root.join("edgeever.sqlite"),
        root.join("edgeever.sqlite-wal"),
        root.join("edgeever.sqlite-shm"),
    ] {
        restrict_file(&path)
            .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
    }
    Ok(connection)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upgrades_legacy_outbox_with_retry_metadata() {
        let connection = Connection::open_in_memory().expect("open test database");
        connection
            .execute_batch(
                "CREATE TABLE _edgeever_sidecar_outbox (
                   id INTEGER PRIMARY KEY AUTOINCREMENT,
                   kind TEXT NOT NULL,
                   entity_id TEXT NOT NULL,
                   payload_json TEXT NOT NULL,
                   status TEXT NOT NULL DEFAULT 'pending',
                   attempt_count INTEGER NOT NULL DEFAULT 0,
                   last_error TEXT,
                   version INTEGER NOT NULL DEFAULT 1,
                   created_at TEXT NOT NULL,
                   updated_at TEXT NOT NULL
                 );
                 INSERT INTO _edgeever_sidecar_outbox
                   (kind, entity_id, payload_json, status, last_error, created_at, updated_at)
                 VALUES ('memo.update', 'memo_legacy', '{}', 'error', 'Memo not found', '2026-01-01', '2026-01-01');",
            )
            .expect("create legacy schema");

        ensure_sidecar_schema(&connection).expect("upgrade legacy schema");

        let upgraded: (bool, Option<String>, Option<String>) = connection
            .query_row(
                "SELECT retryable, last_error_code, next_attempt_at FROM _edgeever_sidecar_outbox WHERE entity_id = 'memo_legacy'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("read upgraded row");
        assert_eq!(upgraded, (true, None, None));
    }

    #[test]
    fn requeues_stuck_missing_memo_batches_once() {
        let connection = Connection::open_in_memory().expect("open test database");
        ensure_sidecar_schema(&connection).expect("create schema");
        connection
            .execute_batch(
                "INSERT INTO _edgeever_sidecar_outbox
                   (kind, entity_id, payload_json, status, last_error, last_error_code, retryable, next_attempt_at)
                 VALUES
                   ('memo.move', 'nb_move_missing', '{\"memoIds\":[\"memo_local_1\"]}', 'error', 'One or more memos cannot be moved.', 'missing_memos', 0, NULL),
                   ('memo.pinBatch', 'batch', '{\"memoIds\":[\"memo_2\"]}', 'error', 'Memo not found', 'not_found', 0, NULL),
                   ('memo.move', 'nb_move_deferred', '{\"memoIds\":[\"memo_3\"]}', 'error', 'Server exploded', 'http_500', 1, '2099-01-01T00:00:00.000Z'),
                   ('memo.merge', 'memo_4', '{\"memoIds\":[\"memo_5\"]}', 'error', 'One or more memos cannot be merged.', 'missing_memos', 0, NULL);",
            )
            .expect("seed failed outbox items");

        // The schema creation above consumed the one-time guard on an empty
        // table; clear it to simulate the first launch after an upgrade.
        connection
            .execute(
                "DELETE FROM _edgeever_sidecar_meta WHERE key = 'repair.requeue_missing_memo_batches'",
                [],
            )
            .expect("reset repair guard");
        requeue_recoverable_missing_memo_batches(&connection).expect("run repair");

        let read = |entity_id: &str| -> (String, bool, Option<String>) {
            connection
                .query_row(
                    "SELECT status, retryable, last_error_code FROM _edgeever_sidecar_outbox WHERE entity_id = ?1",
                    [entity_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .expect("read repaired row")
        };
        assert_eq!(read("nb_move_missing"), ("pending".to_owned(), true, None));
        assert_eq!(read("batch"), ("pending".to_owned(), true, None));
        assert_eq!(read("memo_4"), ("error".to_owned(), false, Some("missing_memos".to_owned())));
        assert_eq!(read("nb_move_deferred"), ("error".to_owned(), true, Some("http_500".to_owned())));

        // The repair must only run once per database.
        connection
            .execute(
                "INSERT INTO _edgeever_sidecar_outbox
                   (kind, entity_id, payload_json, status, last_error, last_error_code, retryable)
                 VALUES ('memo.move', 'nb_2', '{\"memoIds\":[\"memo_6\"]}', 'error', 'gone', 'missing_memos', 0)",
                [],
            )
            .expect("seed new failure");
        ensure_sidecar_schema(&connection).expect("re-open schema");
        assert_eq!(read("nb_2"), ("error".to_owned(), false, Some("missing_memos".to_owned())));
    }
}
