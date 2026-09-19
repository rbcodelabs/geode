-- Reference multi-vault catalog schema for the PostgreSQL adapter.
--
-- Installed into a caller-supplied schema. This is a reviewed reference
-- schema, not a production migration: there is no migration tool, no
-- versioning table, no authorization model and no garbage collection. It
-- supersedes the single-vault fixture in `scripts/headless-postgres-proof.sql`
-- by making `vault_id` a first-class key everywhere, so two vaults publish
-- independently and serialize only against themselves.

CREATE TABLE vault (
  vault_id text PRIMARY KEY,
  sequence bigint NOT NULL DEFAULT 0 CHECK (sequence >= 0)
);

-- Immutable content-addressed bytes. The address is the lowercase hex SHA-256
-- of `bytes`, verified by the publish function rather than trusted from the
-- client. Rows are insert-only: a content address that ever meant one byte
-- string must never come to mean another.
CREATE TABLE object (
  vault_id text NOT NULL REFERENCES vault (vault_id),
  content_address text NOT NULL CHECK (content_address ~ '^[0-9a-f]{64}$'),
  content_type text NOT NULL,
  byte_length bigint NOT NULL CHECK (byte_length >= 0),
  bytes bytea NOT NULL,
  PRIMARY KEY (vault_id, content_address)
);

CREATE FUNCTION object_is_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'GEODE_CATALOG:OBJECT_IMMUTABLE';
END;
$$;

-- Enforced, not merely documented. `DROP SCHEMA ... CASCADE` is DDL and is
-- unaffected, so the disposable-schema lifecycle still works.
CREATE TRIGGER object_no_mutation BEFORE UPDATE OR DELETE ON object
  FOR EACH ROW EXECUTE FUNCTION object_is_immutable();

-- The mutable path namespace. Notes carry their text; attachments carry a
-- reference to immutable bytes. The CHECK makes the two shapes exclusive, so
-- a row can never be half of each.
CREATE TABLE catalog_entry (
  vault_id text NOT NULL REFERENCES vault (vault_id),
  path text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('note', 'attachment')),
  text text,
  content_address text,
  sequence bigint NOT NULL,
  PRIMARY KEY (vault_id, path),
  FOREIGN KEY (vault_id, content_address) REFERENCES object (vault_id, content_address),
  CHECK (
    (kind = 'note' AND text IS NOT NULL AND content_address IS NULL)
    OR (kind = 'attachment' AND text IS NULL AND content_address IS NOT NULL)
  )
);

-- Idempotency keys are per vault: two vaults may independently use the same
-- caller-chosen mutation id without colliding.
CREATE TABLE receipt (
  vault_id text NOT NULL REFERENCES vault (vault_id),
  mutation_id text NOT NULL,
  digest text NOT NULL,
  receipt jsonb NOT NULL,
  PRIMARY KEY (vault_id, mutation_id)
);

-- Publish one changeset atomically, or nothing at all.
--
-- `digest` is computed by the portable contract over the canonicalized payload
-- and recorded verbatim; the database compares it but does not define it.
-- `notes` is [{path, text}]; `assets` is [{path, contentAddress, contentType,
-- hex}]. `fail` injects a post-write failure so rollback is observable.
-- Parameters are `p_`-prefixed: `vault` and `receipt` are table names here, and
-- a parameter that shadows one turns a later edit into a silent behavior change.
CREATE FUNCTION publish_catalog(
  p_vault text,
  p_mutation text,
  p_digest text,
  p_base bigint,
  p_notes jsonb,
  p_assets jsonb,
  p_fail boolean DEFAULT false
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  prior receipt%ROWTYPE;
  next_sequence bigint;
  entry jsonb;
  incoming bytea;
  stored bytea;
  result jsonb;
BEGIN
  -- A vault exists from its first publication. Concurrent first publications
  -- of the same vault serialize on the primary key here, then on the row lock
  -- below; a first publication of a *different* vault touches neither.
  INSERT INTO vault (vault_id, sequence) VALUES (p_vault, 0) ON CONFLICT DO NOTHING;

  -- Serialize publication for this vault only, then check receipts, so a
  -- waiting duplicate sees the winner's receipt before its base is tested.
  PERFORM sequence FROM vault WHERE vault_id = p_vault FOR UPDATE;
  SELECT * INTO prior FROM receipt WHERE vault_id = p_vault AND mutation_id = p_mutation;
  IF FOUND THEN
    IF prior.digest <> p_digest THEN
      RAISE EXCEPTION 'GEODE_CATALOG:MUTATION_ID_REUSED';
    END IF;
    RETURN prior.receipt;
  END IF;

  UPDATE vault SET sequence = sequence + 1
    WHERE vault_id = p_vault AND sequence = p_base RETURNING sequence INTO next_sequence;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'GEODE_CATALOG:CONFLICT';
  END IF;

  -- Objects first: catalog entries reference them, and both land or neither does.
  FOR entry IN SELECT value FROM jsonb_array_elements(p_assets) LOOP
    incoming := decode(entry->>'hex', 'hex');
    -- The store verifies the address itself. Trusting the client here would
    -- make "content-addressed" a naming convention rather than a guarantee.
    IF encode(sha256(incoming), 'hex') <> entry->>'contentAddress' THEN
      RAISE EXCEPTION 'GEODE_CATALOG:INVALID_CONTENT_ADDRESS';
    END IF;
    INSERT INTO object (vault_id, content_address, content_type, byte_length, bytes)
      VALUES (p_vault, entry->>'contentAddress', entry->>'contentType', octet_length(incoming), incoming)
      ON CONFLICT (vault_id, content_address) DO NOTHING;
    SELECT bytes INTO stored FROM object
      WHERE vault_id = p_vault AND content_address = entry->>'contentAddress';
    IF stored IS DISTINCT FROM incoming THEN
      RAISE EXCEPTION 'GEODE_CATALOG:DUPLICATE_WITH_MISMATCHED_BYTES';
    END IF;
  END LOOP;

  FOR entry IN SELECT value FROM jsonb_array_elements(p_notes) LOOP
    INSERT INTO catalog_entry (vault_id, path, kind, text, content_address, sequence)
      VALUES (p_vault, entry->>'path', 'note', entry->>'text', NULL, next_sequence)
      ON CONFLICT (vault_id, path) DO UPDATE
        SET kind = 'note', text = EXCLUDED.text, content_address = NULL, sequence = EXCLUDED.sequence;
  END LOOP;

  FOR entry IN SELECT value FROM jsonb_array_elements(p_assets) LOOP
    INSERT INTO catalog_entry (vault_id, path, kind, text, content_address, sequence)
      VALUES (p_vault, entry->>'path', 'attachment', NULL, entry->>'contentAddress', next_sequence)
      ON CONFLICT (vault_id, path) DO UPDATE
        SET kind = 'attachment', text = NULL, content_address = EXCLUDED.content_address, sequence = EXCLUDED.sequence;
  END LOOP;

  result := jsonb_build_object(
    'vaultId', p_vault, 'mutationId', p_mutation, 'sequence', next_sequence,
    'digest', p_digest,
    'noteCount', jsonb_array_length(p_notes), 'assetCount', jsonb_array_length(p_assets));
  INSERT INTO receipt (vault_id, mutation_id, digest, receipt)
    VALUES (p_vault, p_mutation, p_digest, result);
  IF p_fail THEN
    RAISE EXCEPTION 'GEODE_CATALOG:INJECTED_FAILURE';
  END IF;
  RETURN result;
END;
$$;
