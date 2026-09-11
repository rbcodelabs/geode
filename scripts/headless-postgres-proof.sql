-- Phase 0 test fixture only, installed in the runner's disposable schema.
CREATE TABLE vault (singleton boolean PRIMARY KEY CHECK (singleton), sequence bigint NOT NULL);
INSERT INTO vault VALUES (true, 0);
CREATE TABLE catalog (path text PRIMARY KEY, content text NOT NULL);
CREATE TABLE search_index (path text PRIMARY KEY, content text NOT NULL);
CREATE TABLE receipts (mutation_id text PRIMARY KEY, digest text NOT NULL, receipt jsonb NOT NULL);

CREATE FUNCTION commit_proof(mutation text, base bigint, changes jsonb, fail boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  prior receipts%ROWTYPE;
  request_digest text;
  next_sequence bigint;
  change jsonb;
  result jsonb;
BEGIN
  -- JSONB normalizes object-key ordering; the base is part of request identity.
  request_digest := encode(sha256(convert_to(jsonb_build_object('base', base, 'changes', changes)::text, 'UTF8')), 'hex');

  -- Serialize this tiny fixture vault's publication, then check receipts. A
  -- waiting duplicate sees the winner's receipt before its stale base is tested.
  PERFORM sequence FROM vault WHERE singleton FOR UPDATE;
  SELECT * INTO prior FROM receipts WHERE mutation_id = mutation;
  IF FOUND THEN
    IF prior.digest <> request_digest THEN
      RAISE EXCEPTION 'MUTATION_ID_REUSED';
    END IF;
    RETURN prior.receipt;
  END IF;

  UPDATE vault SET sequence = sequence + 1
    WHERE singleton AND sequence = base RETURNING sequence INTO next_sequence;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CONFLICT';
  END IF;

  FOR change IN SELECT value FROM jsonb_array_elements(changes) LOOP
    INSERT INTO catalog VALUES (change->>'path', change->>'content')
      ON CONFLICT (path) DO UPDATE SET content = EXCLUDED.content;
    INSERT INTO search_index VALUES (change->>'path', change->>'content')
      ON CONFLICT (path) DO UPDATE SET content = EXCLUDED.content;
  END LOOP;
  result := jsonb_build_object('mutationId', mutation, 'sequence', next_sequence,
    'digest', request_digest, 'entries', jsonb_array_length(changes));
  INSERT INTO receipts VALUES (mutation, request_digest, result);
  IF fail THEN
    RAISE EXCEPTION 'INJECTED_FAILURE';
  END IF;
  RETURN result;
END;
$$;
