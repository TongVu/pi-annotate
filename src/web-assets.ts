import { readFile } from "node:fs/promises";

export async function readWebAsset(file: string, prefix?: string) {
  const read = (name: string) => readFile(new URL(`../web/${name}`, import.meta.url));
  if (!prefix) return read(file);
  const [shared, page] = await Promise.all([read(prefix), read(file)]);
  return Buffer.concat([shared, Buffer.from("\n"), page]);
}
