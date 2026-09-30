/**
 * js-yaml is not hoisted to the repo root and has no adjacent .d.ts of its
 * own, so validate.mts imports it through
 * ../../../packages/shared/node_modules/js-yaml/index.js — a relative
 * specifier ambient `declare module` can't match literally. A wildcard
 * declaration matches any specifier ending in "/js-yaml/index.js", giving the
 * import a typed surface so the editor and bundlers don't treat it as `any`.
 */
declare module "*js-yaml/index.js" {
  const yaml: {
    load(text: string): unknown;
    dump(
      value: unknown,
      opts?: { lineWidth?: number; noRefs?: boolean; quotingType?: string },
    ): string;
  };
  export default yaml;
}
