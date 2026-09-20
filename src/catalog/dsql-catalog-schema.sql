-- Aurora DSQL-compatible multi-vault catalog schema.
--
-- A *second* reference schema, beside `postgres-catalog-schema.sql`, which is
-- unchanged and remains the conventional-PostgreSQL adapter. Neither supersedes
-- the other: they target databases with materially different feature sets, and
-- collapsing them would mean weakening the PostgreSQL one for no reason.
--
-- Aurora DSQL rejects, by documentation, every enforcement mechanism the
-- PostgreSQL schema leans on:
--
--   | PostgreSQL schema                    | DSQL | Replaced here by                    |
--   | ------------------------------------ | ---- | ----------------------------------- |
--   | `REFERENCES vault (vault_id)` x3     | no   | publish ordering in the adapter     |
--   | composite FK to `object`             | no   | publish ordering in the adapter     |
--   | `CREATE TRIGGER object_no_mutation`  | no   | content-addressed keys + read-side  |
--   |                                      |      | verification; NOT prevention        |
--   | `CREATE TRIGGER object_no_truncate`  | no   | nothing. See the findings doc.      |
--   | `publish_catalog()` in plpgsql       | no   | application-layer transaction       |
--   | `restore_catalog()` in plpgsql       | no   | two plain SELECTs                   |
--   | `PERFORM ... FOR UPDATE`             | n/a  | `vault_sequence` PK + OCC retry     |
--   | `jsonb` receipt column               | no   | `text` holding JSON                 |
--   | `bytea` object bytes                 | n/a  | content-addressed blob store        |
--
-- Everything below is restricted to the DSQL-supported subset *by
-- construction*: PRIMARY KEY, UNIQUE, NOT NULL, CHECK and DEFAULT, over TEXT
-- and BIGINT. `tests/unit/dsql-catalog-schema.test.ts` fails if the words
-- TRIGGER, REFERENCES, FOREIGN KEY, plpgsql, SERIAL or TRUNCATE ever appear in
-- this file, so the restriction is checked rather than remembered.
--
-- ## One DDL statement per transaction
--
-- DSQL permits at most one DDL statement per transaction, so this file is a
-- *sequence of statements*, not a script to be executed in one go. The adapter
-- splits it (see `splitSqlStatements`) and issues each statement on its own.
-- The split is quote-aware and comment-aware, which is cheap here only because
-- there are no `$$`-quoted bodies left to confuse it — that is a consequence of
-- having no PL/pgSQL, not a coincidence.
--
-- ## No secondary indexes, deliberately
--
-- Every read this adapter performs is a prefix scan of a primary key:
-- `WHERE vault_id = ...` against `catalog_entry (vault_id, path)`,
-- `object (vault_id, content_address)` and `vault_sequence (vault_id,
-- sequence)`. A secondary index would be unused surface. When one is ever
-- needed it MUST be `CREATE INDEX ASYNC`, in its own transaction, never a bare
-- `CREATE INDEX` — DSQL has no synchronous index build.

-- The per-vault publication log, and the serialization point.
--
-- This replaces the PostgreSQL schema's mutable `vault.sequence` counter, and
-- the replacement is the single most important design change in this file.
--
-- The PostgreSQL design serializes publications with `SELECT ... FOR UPDATE`
-- followed by `UPDATE vault SET sequence = sequence + 1`: a blocking read then
-- a read-modify-write. DSQL has no blocking lock waits (repeatable-read
-- snapshots, optimistic concurrency, conflict detected at COMMIT) and its own
-- guidance warns specifically against read-modify-write counters as hot keys.
--
-- So publication at base B *claims* sequence B+1 by inserting a row whose
-- primary key is (vault_id, B+1). Two publications racing from the same base
-- insert the same key; exactly one survives and the other's transaction aborts.
-- The uniqueness constraint does the serializing, and it does it without any
-- session ever having to wait on another.
--
-- `mutation_id` is recorded so a claimed slot can be attributed. It is
-- deliberately NOT unique: uniqueness of mutation ids is `receipt`'s job, and
-- putting a second unique constraint on the same fact would make one publication
-- contend on two keys for one reason.
--
-- The current sequence is `max(sequence)` over the vault's key prefix. There is
-- no compaction and no garbage collection, exactly as ADR 0022 says of the
-- schema it describes; the log grows with publication count, not vault size.
CREATE TABLE vault_sequence (
  vault_id text NOT NULL,
  sequence bigint NOT NULL CHECK (sequence >= 1),
  mutation_id text NOT NULL,
  PRIMARY KEY (vault_id, sequence)
);

-- Metadata for immutable content-addressed bytes. The bytes themselves are NOT
-- here — they live in the injectable object store (Vercel Blob in Phase B, a
-- filesystem or in-memory store in Phase A), keyed by `object_key`.
--
-- Moving bytes out is not a preference. DSQL holds a write transaction to
-- roughly 10 MiB and 3,000 rows, while `DEFAULT_CATALOG_LIMITS` permits a 64
-- MiB publication. Carrying bytes in the transaction would make the contract's
-- own declared limits unpublishable. With bytes outside, a publication's
-- transaction size is proportional to its *entry count*, which the contract
-- already caps at 1,000.
--
-- This spike derives stable logical keys. Its Blob wrapper disables random
-- suffixes and asserts the returned pathname matches the requested one.
-- `object_key` leaves room for assigned keys, but uploadObjects does not yet
-- propagate arbitrary store-assigned keys; such stores are unsupported here.
CREATE TABLE object (
  vault_id text NOT NULL,
  content_address text NOT NULL CHECK (content_address ~ '^[0-9a-f]{64}$'),
  content_type text NOT NULL,
  byte_length bigint NOT NULL CHECK (byte_length >= 0),
  object_key text NOT NULL,
  PRIMARY KEY (vault_id, content_address)
);

-- The mutable path namespace.
--
-- Two differences from the PostgreSQL schema, both forced:
--
-- 1. There is no `text` column. Note bytes are content-addressed and live in
--    the object store alongside attachment bytes, for the 10 MiB reason above.
--    ADR 0022 called extending content addressing to note bytes "a deliberate
--    non-decision"; DSQL's transaction ceiling decides it.
-- 2. There is no `FOREIGN KEY (vault_id, content_address) REFERENCES object`.
--    The adapter writes objects before the catalog entries that reference them,
--    inside the same transaction, and `verifyRestoredVault` refuses a dangling
--    reference by name (`missing-object`) on the way out. That is detection and
--    ordering, not prevention — see the findings doc.
--
-- `kind` survives because the contract distinguishes notes from attachments on
-- the way out: a note restores as text, an attachment as bytes.
--
-- `content_type` is recorded per *entry*, not taken from the shared `object`
-- row, because one content address can legitimately be reached by entries that
-- disagree about its type. Notes are content-addressed here, so a note whose
-- UTF-8 bytes happen to equal an attachment's bytes collapses to a single
-- object — and that object can only record one content type, whichever
-- publication wrote it first. Reading the type from `object` would then hand a
-- restored attachment the note's `text/markdown`. Per entry, each path answers
-- for its own declared type, which is the one `validatePublication` checked
-- against the allowlist.
CREATE TABLE catalog_entry (
  vault_id text NOT NULL,
  path text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('note', 'attachment')),
  content_address text NOT NULL CHECK (content_address ~ '^[0-9a-f]{64}$'),
  content_type text NOT NULL,
  sequence bigint NOT NULL CHECK (sequence >= 1),
  PRIMARY KEY (vault_id, path)
);

-- Idempotency keys, per vault.
--
-- `receipt` is `text` rather than `jsonb`: DSQL's guidance is to store JSON as
-- TEXT. The adapter parses it, which it had to do anyway — the PostgreSQL
-- adapter already `JSON.parse`s what `psql` prints.
--
-- The primary key is what makes a concurrent duplicate lose. Under the
-- optimistic model there is no lock to wait on, so the receipt check that the
-- PostgreSQL function performs *inside* the transaction cannot be relied on to
-- see a winner that has not committed yet. The PK catches it at commit instead,
-- and the adapter's retry turns that abort into the winner's receipt.
CREATE TABLE receipt (
  vault_id text NOT NULL,
  mutation_id text NOT NULL,
  digest text NOT NULL,
  receipt text NOT NULL,
  PRIMARY KEY (vault_id, mutation_id)
);
