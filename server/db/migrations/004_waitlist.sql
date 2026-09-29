-- Waitlist entries table schema
DO $$ BEGIN
    CREATE TYPE waitlist_status AS ENUM (
        'WAITING', 'PROMOTED', 'REMOVED'
    );
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS waitlist_entries (
    id          UUID            NOT NULL DEFAULT gen_random_uuid(),
    user_id     UUID            NOT NULL,
    workshop_id UUID            NOT NULL,
    status      waitlist_status NOT NULL DEFAULT 'WAITING',
    position    INT             NOT NULL,
    created_at  TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    CONSTRAINT waitlist_entries_pkey      PRIMARY KEY (id),
    CONSTRAINT waitlist_user_fk           FOREIGN KEY (user_id)
        REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT waitlist_workshop_fk       FOREIGN KEY (workshop_id)
        REFERENCES workshops(id) ON DELETE CASCADE,
    CONSTRAINT waitlist_position_positive CHECK (position > 0)
);

-- Enforce single active waitlist entry per user per workshop
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_waitlist_per_user
    ON waitlist_entries (user_id, workshop_id)
    WHERE status = 'WAITING';

-- FIFO queue ordering for promotions
CREATE INDEX IF NOT EXISTS idx_waitlist_fifo
    ON waitlist_entries (workshop_id, position)
    WHERE status = 'WAITING';

CREATE TRIGGER waitlist_updated_at
    BEFORE UPDATE ON waitlist_entries
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
