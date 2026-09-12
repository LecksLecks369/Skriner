/* Резолвер расширений для запуска исходников скринера напрямую из node
   (--experimental-strip-types): внутри src/ импорты пишутся без расширения,
   а ESM-резолвер node их не достраивает. Нужен только скриптам из scripts/;
   на сборку Next это не влияет. */
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && !/\.[cm]?[jt]sx?$/.test(specifier)) {
    try {
      return await nextResolve(specifier + '.ts', context);
    } catch {
      /* не .ts — пусть разбирается штатный резолвер */
    }
  }
  return nextResolve(specifier, context);
}
