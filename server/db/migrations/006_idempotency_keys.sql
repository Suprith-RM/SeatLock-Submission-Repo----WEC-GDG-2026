-- Idempotency keys store for state-mutating requests
CREATE TABLE IF NOT EXISTS idempotency_keys (
    key             TEXT        NOT NULL,
    user_id         UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    request_path    TEXT        NOT NULL,
    request_hash    TEXT        NOT NULL,
    response_status INT         NOT NULL,
    response_body   JSONB       NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at      TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '24 hours',
    CONSTRAINT idempotency_keys_pkey      PRIMARY KEY (key, user_id),
    CONSTRAINT idempotency_status_valid   CHECK (response_status = 0 OR (response_status BETWEEN 100 AND 599)),
    CONSTRAINT idempotency_key_not_empty  CHECK (key != ''),
    CONSTRAINT idempotency_hash_not_empty CHECK (request_hash != '')
);

CREATE INDEX IF NOT EXISTS idx_idempotency_expires
    ON idempotency_keys (expires_at);
