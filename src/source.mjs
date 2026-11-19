import { text } from './validation.mjs';

export const collectionPath = "/tax/CN/R2";

export function editionPath(basePath, edition) {
  if (typeof edition !== 'string' || !/^[^/\\]+$/.test(edition) || edition === '.' || edition === '..') throw new Error('版本标识无效：' + edition);
  return basePath.replace(/\/[^/]*$/, '/') + edition;
}

export async function browse(client, path = collectionPath) {
  const document = await client.get(path);
  const raw = document.raw;
  const context = text(raw.edition, "edition");
  if (!Array.isArray(raw.tariffs)) throw new Error('来源目录结构无效');
  const references = raw.tariffs.map(entry => {
    const reference = { identity: text(entry.id, 'id'), href: text(entry.href, 'href'), context };
    if (entry.relations !== undefined) reference.relations = text(entry.relations, 'relations');
    return reference;
  });
  if (new Set(references.map(entry => entry.identity)).size !== references.length) throw new Error('目录包含重复来源身份');
  if (raw.chapters !== undefined && !Array.isArray(raw.chapters)) throw new Error('来源目录章注结构无效');
  const chapters = (raw.chapters ?? []).map(entry => ({ identity: text(entry.id, 'id'), href: text(entry.href, 'href'), context }));
  if (new Set(chapters.map(entry => entry.identity)).size !== chapters.length) throw new Error('目录包含重复章注身份');
  return { context, references, chapters };
}
export async function retrieve(client, reference) {
  const document = await client.get(reference.href);
  if (document.raw.code !== reference.identity) throw new Error('原文身份与目录引用不符');
  if (document.raw.edition !== reference.context) throw new Error('原文上下文与目录不符');
  return document;
}
export async function retrieveNotes(client, reference) {
  const document = await client.get(reference.href);
  if (document.raw.chapter !== reference.identity) throw new Error('章注身份与目录引用不符');
  if (document.raw.edition !== reference.context) throw new Error('章注上下文与目录不符');
  return document;
}
