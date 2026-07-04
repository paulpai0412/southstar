import { join } from "node:path";
import { openSouthstarDb } from "../src/v2/db/postgres.ts";
import { listLibraryFiles, syncLibraryFileToGraph } from "../src/v2/design-library/files/library-file-store.ts";

const databaseUrl = process.env.SOUTHSTAR_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:55432/southstar";
const libraryRoot = process.env.SOUTHSTAR_LIBRARY_ROOT ?? join(process.cwd(), "library");

const db = await openSouthstarDb(databaseUrl);

try {
  const files = await listLibraryFiles({ root: libraryRoot });
  let syncedFiles = 0;
  let syncedEdges = 0;
  for (const file of files) {
    const result = await syncLibraryFileToGraph(db, { root: libraryRoot, relativePath: file.relativePath });
    syncedFiles += 1;
    syncedEdges += result.edges.length;
  }

  const scopedLlmEdges = await db.query(
    `update southstar.library_edges edge
        set scope = coalesce(source.state_json->>'scope', edge.scope)
       from southstar.library_objects source
      where edge.from_object_key = source.object_key
        and edge.status = 'active'
        and edge.metadata_json->>'source' = 'library-import-candidate'
        and edge.scope = 'software'
        and coalesce(source.state_json->>'scope', '') not in ('', 'software')
      returning edge.id`,
  );

  console.log(JSON.stringify({
    libraryRoot,
    syncedFiles,
    syncedEdges,
    llmEdgesRescoped: scopedLlmEdges.rowCount ?? 0,
  }, null, 2));
} finally {
  await db.close();
}
