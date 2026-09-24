import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { splitSqlStatements, stripSqlNoise } from "../../src/catalog/dsql-catalog-store";

/**
 * The DSQL-compatibility guard.
 *
 * Every proof in this spike runs against conventional PostgreSQL, which
 * cheerfully accepts everything Aurora DSQL rejects. So nothing observed at run
 * time can establish that this schema is DSQL-compatible — a green proof is
 * perfectly consistent with a schema DSQL would refuse to install. The only
 * thing that can be checked without a cluster is the *syntax*, statically, and
 * that is what this file does.
 *
 * It is a static guard and it is worth being precise about its reach: it proves
 * the schema does not *use* the six features DSQL is documented not to have. It
 * does not prove DSQL accepts everything that remains. The residue — whether
 * `~` regex CHECK constraints, `bigint`, `DROP SCHEMA ... CASCADE` and the rest
 * are actually accepted — is Phase B's job and is listed as such in
 * `docs/design/dsql-catalog-findings.md`.
 */

const schemaPath = resolve("src/catalog/dsql-catalog-schema.sql");
const rawSchema = readFileSync(schemaPath, "utf8");
const executableSchema = stripSqlNoise(rawSchema);

/**
 * The features Aurora DSQL does not have.
 *
 * Each is checked against the schema with comments and string literals
 * stripped. Grepping the raw file would be actively misleading here: the schema
 * documents every feature it had to remove, so the word `TRIGGER` appears
 * several times in prose explaining why there is no trigger. A guard that
 * failed on its own explanation would be deleted within a week, and the
 * protection would go with it.
 */
const FORBIDDEN: readonly (readonly [string, RegExp])[] = [
  ["TRIGGER", /\bTRIGGER\b/i],
  ["REFERENCES", /\bREFERENCES\b/i],
  ["FOREIGN KEY", /\bFOREIGN\s+KEY\b/i],
  ["plpgsql", /\bplpgsql\b/i],
  ["SERIAL", /\b(?:BIG|SMALL)?SERIAL\b/i],
  ["TRUNCATE", /\bTRUNCATE\b/i],
];

describe("the DSQL schema stays inside the supported subset", () => {
  it.each(FORBIDDEN)("uses no %s", (_name, pattern) => {
    expect(executableSchema).not.toMatch(pattern);
  });

  it("uses no PL/pgSQL function bodies", () => {
    // No `$$` quoting at all. This is also what makes `splitSqlStatements`
    // tractable: a dollar-quoted body would hide semicolons from the splitter.
    expect(executableSchema).not.toMatch(/\$\$/);
    expect(executableSchema).not.toMatch(/\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\b/i);
  });

  it("creates no synchronous index", () => {
    // DSQL has no synchronous index build. There are no secondary indexes here
    // at all — every read is a primary-key prefix scan — but if one is ever
    // added it must be ASYNC, and this fails until it is.
    const synchronous = /\bCREATE\s+(?:UNIQUE\s+)?INDEX\b(?!\s+ASYNC)/i;
    expect(executableSchema).not.toMatch(synchronous);
  });

  it("declares every table this adapter reads and writes", () => {
    const tables = [...executableSchema.matchAll(/CREATE TABLE (\w+)/g)].map((match) => match[1]).sort();
    expect(tables).toEqual(["catalog_entry", "object", "receipt", "vault_sequence"]);
  });

  it("stores JSON as text rather than jsonb", () => {
    expect(executableSchema).not.toMatch(/\bjsonb?\b/i);
    expect(executableSchema).toMatch(/receipt\s+text\s+NOT NULL/);
  });

  it("stores no bytes in the database", () => {
    // Object bytes live in the injectable object store. A `bytea` column would
    // put a 64 MiB publication back inside a 10 MiB write transaction.
    expect(executableSchema).not.toMatch(/\bbytea\b/i);
  });

  /**
   * The guard has to be able to fail, or it is decoration.
   *
   * Rather than trusting that the six patterns above would catch a regression,
   * this feeds each one a schema that *does* contain the forbidden feature and
   * requires the check to reject it.
   */
  it.each(FORBIDDEN)("would actually catch a %s if one were added", (name, pattern) => {
    const violating = `${rawSchema}\n${
      name === "TRIGGER" ? "CREATE TRIGGER t BEFORE UPDATE ON object FOR EACH ROW EXECUTE FUNCTION f();"
      : name === "REFERENCES" ? "ALTER TABLE object ADD COLUMN v text REFERENCES vault_sequence (vault_id);"
      : name === "FOREIGN KEY" ? "ALTER TABLE object ADD FOREIGN KEY (vault_id) REFERENCES receipt (vault_id);"
      : name === "plpgsql" ? "CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS 'begin end';"
      : name === "SERIAL" ? "ALTER TABLE object ADD COLUMN n serial;"
      : "TRUNCATE object;"
    }\n`;
    expect(stripSqlNoise(violating)).toMatch(pattern);
  });

  it("does not let a comment or a string literal smuggle a violation past the guard", () => {
    // The inverse check: the guard must not be *so* permissive that it ignores
    // real SQL, nor so strict that prose trips it. Both directions in one test.
    expect(stripSqlNoise("-- CREATE TRIGGER t ...\nCREATE TABLE a (b text);")).not.toMatch(/\bTRIGGER\b/);
    expect(stripSqlNoise("CREATE TABLE a (b text CHECK (b <> 'TRIGGER'));")).not.toMatch(/\bTRIGGER\b/);
    expect(stripSqlNoise("CREATE TRIGGER t BEFORE UPDATE ON a ...")).toMatch(/\bTRIGGER\b/);
  });
});

describe("the schema is installable one DDL statement at a time", () => {
  const statements = splitSqlStatements(rawSchema);

  it("splits into exactly one statement per table", () => {
    // DSQL permits at most one DDL statement per transaction, so the installer
    // cannot send the file as one script the way the PostgreSQL adapter does.
    expect(statements).toHaveLength(4);
    for (const statement of statements) expect(statement).toMatch(/^CREATE TABLE \w+ \(/);
  });

  it("drops comments and keeps the trailing semicolon on each statement", () => {
    for (const statement of statements) {
      expect(statement.endsWith(";")).toBe(true);
      expect(statement).not.toMatch(/^--/m);
    }
  });

  it("does not split inside a string literal", () => {
    // The CHECK constraints carry a regex containing `$`, and a future one
    // could carry a semicolon. A splitter that broke on that would produce two
    // statements neither of which parses.
    expect(splitSqlStatements("CREATE TABLE a (b text CHECK (b ~ 'x;y'));"))
      .toEqual(["CREATE TABLE a (b text CHECK (b ~ 'x;y'));"]);
  });

  it("preserves the content-address CHECK constraints", () => {
    const withChecks = statements.filter((statement) => statement.includes("'^[0-9a-f]{64}$'"));
    expect(withChecks).toHaveLength(2);
  });
});

/**
 * Immutability is no longer enforced by the database, so the one thing left to
 * enforce is that *this adapter* never mutates an object row.
 *
 * The PostgreSQL schema has a `BEFORE UPDATE OR DELETE` trigger that stops a
 * buggy client dead. DSQL has no triggers, so there is nothing to stop one.
 * What remains checkable without a database is narrower and still worth having:
 * the adapter's own generated SQL contains no statement that could mutate or
 * remove a stored object. That converts a convention into a checked property —
 * against this adapter, which is the thing most likely to regress, and against
 * nothing else.
 */
describe("the adapter never mutates a stored object", () => {
  const adapter = readFileSync(resolve("src/catalog/dsql-catalog-store.ts"), "utf8");

  it.each([
    ["UPDATE object", /UPDATE\s+object\b/i],
    ["DELETE FROM object", /DELETE\s+FROM\s+object\b/i],
  ])("emits no %s", (_name, pattern) => {
    expect(adapter).not.toMatch(pattern);
  });

  it("emits exactly one INSERT INTO object", () => {
    expect(adapter.match(/INSERT INTO object\b/g)).toHaveLength(1);
  });

  it("deletes only from catalog_entry, which is the mutable namespace", () => {
    const deletes = [...adapter.matchAll(/DELETE\s+FROM\s+(\w+)/gi)].map((match) => match[1]);
    expect(deletes).toEqual(["catalog_entry"]);
  });
});
