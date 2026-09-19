import assert from "node:assert/strict";
import { resolve } from "node:path";
import { createPostgresCatalog } from "../src/catalog/postgres-catalog-store";

/**
 * Create or drop one disposable schema, and nothing else.
 *
 * The two-process harness owns the schema's lifecycle — it has to, because
 * neither VM A nor VM B may outlive it or tear down state the other still
 * needs. This exists so that lifecycle still goes through the same audited
 * adapter, rather than through a second, hand-rolled `psql` invocation in a
 * runner where nobody would think to review it.
 *
 * Both the schema name and the action arrive as environment variables
 * (`GEODE_CATALOG_SCHEMA`, `GEODE_ADMIN_ACTION`), matching how the harness
 * launches every other child — one way to pass configuration, not two.
 */

const schema = process.env.GEODE_CATALOG_SCHEMA;
assert.ok(schema, "GEODE_CATALOG_SCHEMA must be set");
const action = process.env.GEODE_ADMIN_ACTION;
assert.ok(action === "install" || action === "drop", "GEODE_ADMIN_ACTION must be `install` or `drop`");

const catalog = createPostgresCatalog({ schema, schemaDirectory: resolve("src/catalog") });
try {
  if (action === "install") await catalog.install();
  else await catalog.drop();
  console.log(JSON.stringify({ schema, action, ok: true }));
} finally {
  catalog.close();
}
