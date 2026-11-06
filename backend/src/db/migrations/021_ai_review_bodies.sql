-- The exact bodies each review's signature covers: the request JSON as sent to NEAR AI Cloud and
-- the response body as received. The signed text holds their SHA-256, so anyone can recompute both
-- and read what the model was asked and answered. They sit beside the evidence, not in it: the
-- review hash (SHA-256 of the evidence) already commits to them through the signed text. Reviews
-- stored before this have neither; a review has both or none. Re-applied on every start: idempotent.
ALTER TABLE ai_reviews ADD COLUMN IF NOT EXISTS request_body TEXT;
ALTER TABLE ai_reviews ADD COLUMN IF NOT EXISTS response_body TEXT;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'ai_reviews'::regclass AND conname = 'ai_reviews_bodies_check') THEN
    ALTER TABLE ai_reviews ADD CONSTRAINT ai_reviews_bodies_check CHECK ((request_body IS NULL) = (response_body IS NULL));
  END IF;
END
$$;
