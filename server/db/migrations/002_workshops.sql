-- Workshops table schema
CREATE TABLE IF NOT EXISTS workshops (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT        NOT NULL,
    description TEXT,
    capacity    INT         NOT NULL DEFAULT 20,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT workshops_name_not_empty    CHECK (char_length(trim(name)) > 0),
    CONSTRAINT workshops_capacity_positive CHECK (capacity > 0)
);
