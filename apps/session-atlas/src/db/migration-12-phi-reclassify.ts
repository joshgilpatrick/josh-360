import type { AtlasDb } from './database.ts'
import { hasPhiSegment } from '../artifacts/path-policy.ts'

// Migration 12 (PR #19 follow-up review, finding 2, ruling R91). Commit 91f60d8 widened the PHI segment rule from `phi` to `phi` and `.phi`,
// but rows written before it were classified under the narrower rule: a catalog built by older code has is_sensitive = 0 and
// protected = 0 for paths under `.phi/`, and the lists, previews and exports trust those flags. This reclassifies the catalog once,
// at upgrade, in the migration's own transaction (so no service ever serves it half done). It only RAISES flags, never lowers one.
// Every pass reads a bounded page (by primary-key order, never the whole table at once): a real catalog can hold ~100k locations.

/** Rows read per SELECT. */
export const PHI_RECLASSIFY_PAGE = 1000

export function reclassifyPhiFolders(db: AtlasDb): void {
  const raw = db.raw
  const locations = raw.prepare('SELECT artifact_id, path, document_id FROM artifacts WHERE artifact_id > ? ORDER BY artifact_id LIMIT ?')
  const raiseLocation = raw.prepare('UPDATE artifacts SET is_sensitive = 1 WHERE artifact_id = ? AND is_sensitive = 0')
  const raiseDocument = raw.prepare('UPDATE artifact_documents SET protected = 1 WHERE document_id = ? AND protected = 0')
  // A document's protection flows to its locations (as adoption does): a location of a protected document is protected.
  const flowToLocations = raw.prepare('UPDATE artifacts SET is_sensitive = 1 WHERE document_id = ? AND is_sensitive = 0')

  // 1. A location whose path has a PHI segment, and the document it belongs to.
  for (let after = 0; ;) {
    const page = locations.all(after, PHI_RECLASSIFY_PAGE) as Array<{ artifact_id: number; path: string; document_id: string | null }>
    for (const r of page) {
      if (!hasPhiSegment(r.path)) continue
      raiseLocation.run(r.artifact_id)
      if (r.document_id !== null) {
        raiseDocument.run(r.document_id)
        flowToLocations.run(r.document_id)
      }
    }
    if (page.length < PHI_RECLASSIFY_PAGE) break
    after = page[page.length - 1]!.artifact_id
  }

  // 2. A document whose repository-relative path has a PHI segment (this includes Git-only documents, which have no location).
  const documents = raw.prepare('SELECT rowid AS id, document_id, relative_path FROM artifact_documents WHERE rowid > ? AND protected = 0 AND relative_path IS NOT NULL ORDER BY rowid LIMIT ?')
  for (let after = 0; ;) {
    const page = documents.all(after, PHI_RECLASSIFY_PAGE) as Array<{ id: number; document_id: string; relative_path: string }>
    for (const r of page) {
      if (!hasPhiSegment(r.relative_path)) continue
      raiseDocument.run(r.document_id)
      flowToLocations.run(r.document_id)
    }
    if (page.length < PHI_RECLASSIFY_PAGE) break
    after = page[page.length - 1]!.id
  }

  // 3. A registered root whose own path has a PHI segment (registration protects such a root), and, as registration does when a
  //    checkout becomes one, every document of the repository that checkout belongs to.
  const roots = raw.prepare('SELECT rowid AS id, root_id, canonical_path, kind, repository_id FROM artifact_roots WHERE rowid > ? ORDER BY rowid LIMIT ?')
  const raiseRoot = raw.prepare('UPDATE artifact_roots SET protected = 1 WHERE root_id = ? AND protected = 0')
  const raiseRepository = raw.prepare(`UPDATE artifact_documents SET protected = 1 WHERE identity_kind = 'repository' AND repository_id = ? AND protected = 0`)
  const flowToRepository = raw.prepare(`UPDATE artifacts SET is_sensitive = 1 WHERE is_sensitive = 0 AND document_id IN (SELECT document_id FROM artifact_documents WHERE identity_kind = 'repository' AND repository_id = ? AND protected = 1)`)
  for (let after = 0; ;) {
    const page = roots.all(after, PHI_RECLASSIFY_PAGE) as Array<{ id: number; root_id: string; canonical_path: string; kind: string; repository_id: string | null }>
    for (const r of page) {
      if (!hasPhiSegment(r.canonical_path)) continue
      raiseRoot.run(r.root_id)
      if (r.kind === 'checkout' && r.repository_id !== null) {
        raiseRepository.run(r.repository_id)
        flowToRepository.run(r.repository_id)
      }
    }
    if (page.length < PHI_RECLASSIFY_PAGE) break
    after = page[page.length - 1]!.id
  }
}
