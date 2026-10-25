-- D1 records customer allowances and costs. OpenRouter handles provider billing.
-- Preserve the existing ledger and reservations without requiring manual funding.
DROP TRIGGER job_reserve;
CREATE TRIGGER job_reserve BEFORE INSERT ON jobs BEGIN
 UPDATE allowances SET videos_remaining=videos_remaining-CASE WHEN NEW.kind='video' THEN 1 ELSE 0 END,
 portraits_remaining=portraits_remaining-CASE WHEN NEW.kind='portrait' THEN 1 ELSE 0 END
 WHERE id=NEW.allowance_id AND user_id=NEW.user_id
 AND (NEW.kind!='video' OR videos_remaining>0) AND (NEW.kind!='portrait' OR portraits_remaining>0);
 SELECT CASE WHEN changes()!=1 THEN RAISE(ABORT,'No generation allowance available') END;
 UPDATE provider_budget SET reserved_cents=reserved_cents+NEW.estimate_cents WHERE id=1;
END;
DROP TRIGGER job_failed;
CREATE TRIGGER job_failed AFTER UPDATE OF status ON jobs
WHEN NEW.status='failed' AND OLD.status NOT IN ('failed','completed') AND OLD.released=0 BEGIN
 UPDATE allowances SET videos_remaining=videos_remaining+CASE WHEN NEW.kind='video' THEN 1 ELSE 0 END,
 portraits_remaining=portraits_remaining+CASE WHEN NEW.kind='portrait' THEN 1 ELSE 0 END WHERE id=NEW.allowance_id;
 UPDATE provider_budget SET reserved_cents=MAX(0,reserved_cents-NEW.estimate_cents),
 spent_cents=spent_cents+COALESCE(NEW.actual_cents,0),consecutive_failures=consecutive_failures+1 WHERE id=1;
 UPDATE jobs SET released=1 WHERE id=NEW.id;
END;
DROP TRIGGER job_completed;
CREATE TRIGGER job_completed AFTER UPDATE OF status ON jobs
WHEN NEW.status='completed' AND OLD.status NOT IN ('failed','completed') AND OLD.released=0 BEGIN
 UPDATE provider_budget SET reserved_cents=MAX(0,reserved_cents-NEW.estimate_cents),
 spent_cents=spent_cents+COALESCE(NEW.actual_cents,NEW.estimate_cents),consecutive_failures=0 WHERE id=1;
 UPDATE jobs SET released=1 WHERE id=NEW.id;
END;
UPDATE provider_budget SET paused=0 WHERE id=1;
