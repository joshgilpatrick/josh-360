import { createHash } from 'node:crypto'

// Length-prefix each part so ('ab','') and ('a','b') never collide.
export function sha1Hex(...parts: string[]): string {
  const h = createHash('sha1')
  for (const p of parts) {
    h.update(`${p.length}:`)
    h.update(p)
  }
  return h.digest('hex')
}
