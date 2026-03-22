-- 수금일에 시각까지 저장 (yyyy-mm-dd hh:mm)
ALTER TABLE payment
  ALTER COLUMN paid_at TYPE TIMESTAMPTZ
  USING (paid_at::timestamp);
