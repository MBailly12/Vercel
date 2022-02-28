import { createHash } from 'crypto';
import fs from 'fs-extra';
import { Sema } from 'async-sema';

export interface DeploymentFile {
  names: string[];
  data: Buffer;
  mode: number;
}

/**
 * Computes a hash for the given buf.
 *
 * @param {Buffer} file data
 * @return {String} hex digest
 */
function hash(buf: Buffer): string {
  return createHash('sha1').update(buf).digest('hex');
}

/**
 * Transforms map to object
 * @param map with hashed files
 * @return {object}
 */
export const mapToObject = (
  map: Map<string, DeploymentFile>
): { [key: string]: DeploymentFile } => {
  const obj: { [key: string]: DeploymentFile } = {};
  for (const [key, value] of map) {
    obj[key] = value;
  }

  return obj;
};

/**
 * Computes hashes for the contents of each file given.
 *
 * @param files - absolute file paths
 * @param map - optional map of files to append
 * @return Map of hash digest to file object
 */
export async function hashes(
  files: string[],
  map = new Map<string, DeploymentFile>()
): Promise<Map<string, DeploymentFile>> {
  const semaphore = new Sema(100);

  await Promise.all(
    files.map(async (name: string): Promise<void> => {
      await semaphore.acquire();
      const data = await fs.readFile(name);
      const { mode } = await fs.stat(name);

      const h = hash(data);
      const entry = map.get(h);

      if (entry) {
        const names = new Set(entry.names);
        names.add(name);
        entry.names = [...names];
      } else {
        map.set(h, { names: [name], data, mode });
      }

      semaphore.release();
    })
  );
  return map;
}
