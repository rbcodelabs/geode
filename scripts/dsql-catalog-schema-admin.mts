import assert from "node:assert/strict";
import { resolve } from "node:path";
import { createDsqlCatalog } from "../src/catalog/dsql-catalog-store";

/**
 * Create or drop one disposable schema for the DSQL adapter, and nothing else.
 *
 * Same role and same reasoning as `catalog-schema-admin.mts`: the two-process
 * harness owns the schema's lifecycle, because neither VM may outlive it or
 * tear down state the other still needs, and that lifecycle should still go
 * through the audited adapter rather than a second hand-rolled `psql`
 * invocation nobody would think to review.
 *
 * The object store is deliberately absent here. Schema lifecycle is a database
 * act; the object store's lifecycle belongs to the harness, which owns the
 * directory the same way it owns the schema.
 */

const schema = process.env.GEODE_CATALOG_SCHEMA;
assert.ok(schema, "GEODE_CATALOG_SCHEMA must be set");
const action = process.env.GEODE_ADMIN_ACTION;
assert.ok(action === "install" || action === "drop", "GEODE_ADMIN_ACTION must be `install` or `drop`");

const catalog = createDsqlCatalog({ schema, schemaDirectory: resolve("src/catalog") });
try {
  if (action === "install") await catalog.install();
  else await catalog.drop();
  console.log(JSON.stringify({ schema, action, ok: true }));
} finally {
  catalog.close();
}
