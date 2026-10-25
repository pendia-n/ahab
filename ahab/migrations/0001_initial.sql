PRAGMA foreign_keys = ON;
CREATE TABLE users (
 id TEXT PRIMARY KEY, username TEXT NOT NULL COLLATE NOCASE UNIQUE,
 password_hash TEXT NOT NULL, recovery_hash TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE sessions (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE TABLE recovery_tickets (
 token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE password_changes (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX password_changes_user ON password_changes(user_id,created_at);
CREATE TRIGGER password_change_limit BEFORE INSERT ON password_changes BEGIN
 SELECT CASE WHEN (SELECT count(*) FROM password_changes WHERE user_id=NEW.user_id AND created_at>NEW.created_at-86400000)>=4
 THEN RAISE(ABORT,'Password change limit') END;
END;
CREATE TABLE prompts (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, text TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX prompts_user ON prompts(user_id,seq);
CREATE TRIGGER prompts_fifo AFTER INSERT ON prompts BEGIN
 DELETE FROM prompts WHERE user_id=NEW.user_id AND seq NOT IN
 (SELECT seq FROM prompts WHERE user_id=NEW.user_id ORDER BY seq DESC LIMIT 80);
END;
CREATE TABLE assets (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('image','audio','video','output')),
 r2_key TEXT NOT NULL UNIQUE, name TEXT NOT NULL, mime TEXT NOT NULL, bytes INTEGER NOT NULL,
 duration REAL, width INTEGER, height INTEGER, created_at INTEGER NOT NULL, expires_at INTEGER
);
CREATE INDEX assets_user ON assets(user_id,kind,seq);
CREATE INDEX assets_expiry ON assets(expires_at);
CREATE TABLE deletion_outbox (r2_key TEXT PRIMARY KEY, created_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0);
CREATE TRIGGER asset_delete BEFORE DELETE ON assets BEGIN
 INSERT OR IGNORE INTO deletion_outbox(r2_key,created_at) VALUES(OLD.r2_key,unixepoch()*1000);
END;
CREATE TRIGGER assets_fifo AFTER INSERT ON assets BEGIN
 DELETE FROM assets WHERE user_id=NEW.user_id AND kind=NEW.kind AND seq NOT IN (
 SELECT seq FROM assets WHERE user_id=NEW.user_id AND kind=NEW.kind ORDER BY seq DESC
 LIMIT CASE NEW.kind WHEN 'image' THEN 40 WHEN 'audio' THEN 20 WHEN 'video' THEN 10 ELSE 23 END);
END;
CREATE TABLE purchases (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), package_id TEXT NOT NULL,
 amount_cents INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', stripe_session_id TEXT UNIQUE,
 created_at INTEGER NOT NULL, paid_at INTEGER
);
CREATE TABLE allowances (
 id TEXT PRIMARY KEY REFERENCES purchases(id), user_id TEXT NOT NULL REFERENCES users(id),
 package_id TEXT NOT NULL, videos_remaining INTEGER NOT NULL CHECK(videos_remaining>=0),
 portraits_remaining INTEGER NOT NULL CHECK(portraits_remaining>=0), max_duration INTEGER NOT NULL,
 created_at INTEGER NOT NULL
);
CREATE TRIGGER purchase_fulfill AFTER UPDATE OF status ON purchases
WHEN NEW.status='paid' AND OLD.status!='paid' BEGIN
 INSERT OR IGNORE INTO allowances VALUES(NEW.id,NEW.user_id,NEW.package_id,
 CASE NEW.package_id WHEN 'starter' THEN 1 WHEN 'studio' THEN 3 WHEN 'campaign' THEN 5 END,
 CASE NEW.package_id WHEN 'starter' THEN 1 WHEN 'studio' THEN 3 WHEN 'campaign' THEN 5 END,
 CASE NEW.package_id WHEN 'starter' THEN 30 WHEN 'studio' THEN 80 WHEN 'campaign' THEN 120 END,NEW.paid_at);
END;
CREATE TABLE webhook_events (id TEXT PRIMARY KEY, type TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE provider_budget (
 id INTEGER PRIMARY KEY CHECK(id=1), funded_cents INTEGER NOT NULL DEFAULT 0,
 reserved_cents INTEGER NOT NULL DEFAULT 0, spent_cents INTEGER NOT NULL DEFAULT 0,
 paused INTEGER NOT NULL DEFAULT 0 CHECK(paused IN (0,1)), consecutive_failures INTEGER NOT NULL DEFAULT 0
);
INSERT INTO provider_budget(id) VALUES(1);
CREATE TABLE jobs (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), allowance_id TEXT NOT NULL REFERENCES allowances(id),
 kind TEXT NOT NULL CHECK(kind IN ('video','portrait')), mode TEXT NOT NULL,
 duration INTEGER NOT NULL, request_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
 provider_id TEXT, asset_id TEXT, estimate_cents INTEGER NOT NULL, actual_cents INTEGER,
 released INTEGER NOT NULL DEFAULT 0, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX jobs_user ON jobs(user_id,created_at);
CREATE TRIGGER job_reserve BEFORE INSERT ON jobs BEGIN
 UPDATE allowances SET videos_remaining=videos_remaining-CASE WHEN NEW.kind='video' THEN 1 ELSE 0 END,
 portraits_remaining=portraits_remaining-CASE WHEN NEW.kind='portrait' THEN 1 ELSE 0 END
 WHERE id=NEW.allowance_id AND user_id=NEW.user_id
 AND (NEW.kind!='video' OR videos_remaining>0) AND (NEW.kind!='portrait' OR portraits_remaining>0);
 SELECT CASE WHEN changes()!=1 THEN RAISE(ABORT,'No generation allowance available') END;
 UPDATE provider_budget SET reserved_cents=reserved_cents+NEW.estimate_cents
 WHERE id=1 AND paused=0 AND funded_cents-spent_cents-reserved_cents>=NEW.estimate_cents;
 SELECT CASE WHEN changes()!=1 THEN RAISE(ABORT,'Generation is temporarily unavailable') END;
END;
CREATE TRIGGER job_failed AFTER UPDATE OF status ON jobs
WHEN NEW.status='failed' AND OLD.status NOT IN ('failed','completed') AND OLD.released=0 BEGIN
 UPDATE allowances SET videos_remaining=videos_remaining+CASE WHEN NEW.kind='video' THEN 1 ELSE 0 END,
 portraits_remaining=portraits_remaining+CASE WHEN NEW.kind='portrait' THEN 1 ELSE 0 END WHERE id=NEW.allowance_id;
 UPDATE provider_budget SET reserved_cents=MAX(0,reserved_cents-NEW.estimate_cents),
 spent_cents=spent_cents+COALESCE(NEW.actual_cents,0), consecutive_failures=consecutive_failures+1,
 paused=CASE WHEN consecutive_failures+1>=3 THEN 1 ELSE paused END WHERE id=1;
 UPDATE jobs SET released=1 WHERE id=NEW.id;
END;
CREATE TRIGGER job_completed AFTER UPDATE OF status ON jobs
WHEN NEW.status='completed' AND OLD.status NOT IN ('failed','completed') AND OLD.released=0 BEGIN
 UPDATE provider_budget SET reserved_cents=MAX(0,reserved_cents-NEW.estimate_cents),
 spent_cents=spent_cents+COALESCE(NEW.actual_cents,NEW.estimate_cents), consecutive_failures=0,
 paused=CASE WHEN spent_cents+COALESCE(NEW.actual_cents,NEW.estimate_cents)>funded_cents THEN 1 ELSE paused END WHERE id=1;
 UPDATE jobs SET released=1 WHERE id=NEW.id;
END;
CREATE TABLE job_inputs (
 job_id TEXT NOT NULL REFERENCES jobs(id), asset_id TEXT NOT NULL,
 r2_key TEXT NOT NULL UNIQUE, mime TEXT NOT NULL, kind TEXT NOT NULL,
 PRIMARY KEY(job_id,asset_id)
);
CREATE TRIGGER job_payload_cleanup AFTER UPDATE OF status ON jobs
WHEN NEW.status IN ('completed','failed') BEGIN
 UPDATE jobs SET request_json='{}' WHERE id=NEW.id;
 INSERT OR IGNORE INTO deletion_outbox(r2_key,created_at) SELECT r2_key,unixepoch()*1000 FROM job_inputs WHERE job_id=NEW.id;
 DELETE FROM job_inputs WHERE job_id=NEW.id;
END;
CREATE VIEW cost_ledger AS SELECT id AS job_id,kind,mode,estimate_cents,actual_cents,status,released,created_at,updated_at FROM jobs;
