-- Additive: existing receipts, jobs and purchased legacy allowances remain valid.
CREATE TABLE quotes(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),snapshot_json TEXT NOT NULL,amount_cents INTEGER NOT NULL,expires_at INTEGER NOT NULL,created_at INTEGER NOT NULL);
ALTER TABLE purchases ADD COLUMN parent_id TEXT REFERENCES purchases(id);
ALTER TABLE purchases ADD COLUMN quote_id TEXT REFERENCES quotes(id);
CREATE UNIQUE INDEX purchase_quote_once ON purchases(quote_id) WHERE quote_id IS NOT NULL;
CREATE TABLE purchase_items(id TEXT PRIMARY KEY REFERENCES purchases(id),purchase_id TEXT NOT NULL REFERENCES purchases(id),snapshot_json TEXT NOT NULL,quantity INTEGER NOT NULL CHECK(quantity>0));
ALTER TABLE allowances ADD COLUMN service TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE allowances ADD COLUMN resolution TEXT NOT NULL DEFAULT '1080p';
ALTER TABLE allowances ADD COLUMN generated_capacity INTEGER NOT NULL DEFAULT 0;
ALTER TABLE allowances ADD COLUMN task_type TEXT;
ALTER TABLE allowances ADD COLUMN policy_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE allowances ADD COLUMN snapshot_json TEXT;
ALTER TABLE allowances ADD COLUMN text_used INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN selected_duration INTEGER;
ALTER TABLE jobs ADD COLUMN task_type TEXT;
ALTER TABLE jobs ADD COLUMN service TEXT;
ALTER TABLE jobs ADD COLUMN resolution TEXT;
ALTER TABLE jobs ADD COLUMN request_key TEXT;
CREATE UNIQUE INDEX jobs_request_once ON jobs(user_id,request_key) WHERE request_key IS NOT NULL;
CREATE TABLE preparations(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),allowance_id TEXT NOT NULL REFERENCES allowances(id),request_key TEXT NOT NULL,raw_text TEXT NOT NULL,status TEXT NOT NULL,result_json TEXT,actual_cents INTEGER,created_at INTEGER NOT NULL,UNIQUE(user_id,request_key));
CREATE TRIGGER preparation_reserve BEFORE INSERT ON preparations BEGIN
 UPDATE allowances SET text_used=text_used+1 WHERE id=NEW.allowance_id AND user_id=NEW.user_id AND text_used<3*CASE WHEN service='legacy' THEN CASE package_id WHEN 'starter' THEN 1 WHEN 'studio' THEN 3 ELSE 5 END ELSE COALESCE((SELECT quantity FROM purchase_items WHERE id=NEW.allowance_id),1) END;
 SELECT CASE WHEN changes()!=1 THEN RAISE(ABORT,'No text preparation allowance available') END;
END;
DROP TRIGGER purchase_fulfill;
CREATE TRIGGER purchase_fulfill AFTER UPDATE OF status ON purchases
WHEN NEW.status='paid' AND OLD.status!='paid' AND NEW.package_id IN ('starter','studio','campaign') BEGIN
 INSERT OR IGNORE INTO allowances(id,user_id,package_id,videos_remaining,portraits_remaining,max_duration,created_at)
 VALUES(NEW.id,NEW.user_id,NEW.package_id,
 CASE NEW.package_id WHEN 'starter' THEN 1 WHEN 'studio' THEN 3 WHEN 'campaign' THEN 5 END,
 CASE NEW.package_id WHEN 'starter' THEN 1 WHEN 'studio' THEN 3 WHEN 'campaign' THEN 5 END,
 CASE NEW.package_id WHEN 'starter' THEN 30 WHEN 'studio' THEN 80 WHEN 'campaign' THEN 120 END,NEW.paid_at);
END;
CREATE INDEX purchases_parent ON purchases(parent_id);
