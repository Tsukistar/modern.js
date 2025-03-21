/**
 * This plugin is used to redirectImport only in unbundle mode
 * Taking from https://github.com/ice-lab/icepkg/blob/main/packages/pkg/src/plugins/transform/alias.ts
 */
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'path';
import { Lang, type NapiConfig, parse } from '@ast-grep/napi';
import { fs, logger } from '@modern-js/utils';
import {
  type MatchPath,
  createMatchPath,
  loadConfig,
} from '@modern-js/utils/tsconfig-paths';
import MagicString from 'magic-string';
import { assetExt } from '../../constants/file';
import type { ICompiler } from '../../types';
import {
  getDefaultOutExtension,
  isJsExt,
  isJsLoader,
  isTsExt,
  normalizeSlashes,
  resolvePathAndQuery,
} from '../../utils';
import { getAssetContents } from './asset';
import { isCssModule } from './style/postcssTransformer';

type MatchModule = {
  name?: string;
  start: number;
  end: number;
}[];

enum PathType {
  Absolute = 0,
  Relative = 1,
  ModuleId = 2,
}

function getTypeOfPath(path: string, compiler: ICompiler) {
  const isSupportModuleIdAlias =
    Object.keys(compiler.config.resolve.alias).length > 0;

  if (isAbsolute(path)) {
    return PathType.Absolute;
  }
  if (!path.startsWith('.') && isSupportModuleIdAlias) {
    return PathType.ModuleId;
  }
  return PathType.Relative;
}

async function redirectImport(
  compiler: ICompiler,
  code: string,
  modules: MatchModule,
  aliasRecord: Record<string, string>,
  filePath: string,
  outputDir: string,
  jsExtension: string,
  isModule?: boolean,
  matchPath?: MatchPath,
): Promise<MagicString> {
  const str: MagicString = new MagicString(code);
  const extensions = ['.ts', '.tsx', '.js', '.jsx'];
  await Promise.all(
    modules.map(async module => {
      if (!module.name) {
        return;
      }
      const { start, end } = module;
      let { name } = module;
      const ext = extname(name);

      const { redirect } = compiler.config;
      const { alias, style } = redirect;

      if (alias) {
        // redirect alias
        let absoluteImportPath = matchPath
          ? matchPath(name, undefined, undefined, extensions)
          : undefined;
        for (const alias of Object.keys(aliasRecord)) {
          // prefix
          if (name.startsWith(`${alias}/`)) {
            absoluteImportPath = join(
              aliasRecord[alias],
              name.slice(alias.length + 1),
            );
            break;
          }
          // full path
          if (name === alias) {
            absoluteImportPath = aliasRecord[alias];
            break;
          }
        }

        if (absoluteImportPath) {
          if (
            getTypeOfPath(absoluteImportPath, compiler) === PathType.ModuleId
          ) {
            str.overwrite(start, end, absoluteImportPath);
            name = absoluteImportPath;
          } else {
            const relativePath = relative(
              dirname(filePath),
              absoluteImportPath,
            );
            const relativeImportPath = normalizeSlashes(
              relativePath.startsWith('..')
                ? relativePath
                : `./${relativePath}`,
            );
            str.overwrite(start, end, relativeImportPath);
            name = relativeImportPath;
          }
        }
      }

      if (redirect.autoExtension) {
        if (
          ext === '' &&
          name.startsWith('.') &&
          (jsExtension !== '.js' || isModule)
        ) {
          // add extension for relative path, no check if it's a directory.
          str.overwrite(start, end, `${name}${jsExtension}`);
          return;
        }

        if (isTsExt(name)) {
          //  .c(m)ts -> jsExtension
          str.overwrite(start, end, name.replace(/\.(m|c)?tsx?$/, jsExtension));
          return;
        }
      }

      if (style) {
        // redirect style path
        const { originalFilePath, query } = resolvePathAndQuery(name);

        if (query.css_virtual) {
          // css module
          const replacedName = basename(
            originalFilePath,
            extname(originalFilePath),
          ).replace('.', '_');
          const base = `${replacedName}.css`;
          const key = query.hash as string;
          const contents = compiler.virtualModule.get(key)!;
          const fileName = join(outputDir, base);
          compiler.emitAsset(fileName, {
            type: 'asset',
            contents,
            fileName,
            originalFileName: name,
          });
          const relativeImportPath = normalizeSlashes(`./${base}`);
          str.overwrite(start, end, relativeImportPath);
        }

        if (!name.startsWith('.')) {
          return;
        }

        if (
          ext === '.less' ||
          ext === '.sass' ||
          ext === '.scss' ||
          ext === '.css'
        ) {
          // less sass
          if (isCssModule(name, compiler.config.style.autoModules ?? true)) {
            str.overwrite(start, end, `${name.slice(0, -ext.length)}`);
          } else {
            str.overwrite(start, end, `${name.slice(0, -ext.length)}.css`);
          }
          return;
        }
      }

      if (redirect.asset) {
        if (assetExt.filter(ext => name.endsWith(ext)).length) {
          // asset
          const absPath = resolve(dirname(filePath), name);
          const { contents: relativeImportPath, loader } =
            // HACK: set callOnLoad true to invoke svgr
            await getAssetContents.apply(compiler, [absPath, outputDir, true]);
          if (loader === 'jsx') {
            // svgr
            const ext = extname(name);
            const outputName = `${name.slice(0, -ext.length)}.js`;
            str.overwrite(start, end, outputName);
          } else {
            // other assets
            str.overwrite(start, end, `${relativeImportPath}`);
          }
        }
      }
    }),
  );
  return str;
}

// base dir to redirect import path
const name = 'redirect';
export const redirect = {
  name,
  apply(compiler: ICompiler) {
    // get matchPath func to support tsconfig paths
    let matchPath: MatchPath | undefined;
    if (fs.existsSync(compiler.config.tsconfig)) {
      const result = loadConfig(compiler.config.tsconfig);
      if (result.resultType === 'success') {
        const { absoluteBaseUrl, paths, mainFields, addMatchAll } = result;
        matchPath = createMatchPath(
          absoluteBaseUrl,
          paths,
          mainFields,
          addMatchAll,
        );
      }
    }
    compiler.hooks.transform.tapPromise({ name }, async args => {
      if (!isJsExt(args.path) && !isJsLoader(args.loader)) {
        return args;
      }
      const { code, path: id } = args;
      const { format, sourceDir, outDir, autoExtension } = compiler.config;
      const { root } = compiler.context;

      if (!code || format === 'iife' || format === 'umd') {
        return args;
      }

      const alias =
        Object.keys(compiler.config.resolve.alias).length > 0
          ? compiler.config.resolve.alias
          : compiler.config.alias;

      // transform alias to absolute path
      const absoluteAlias = Object.entries(alias).reduce<typeof alias>(
        (result, [name, target]) => {
          if (getTypeOfPath(target, compiler) === PathType.Relative) {
            result[name] = resolve(compiler.context.root, target);
          } else {
            result[name] = target;
          }
          return result;
        },
        {},
      );

      try {
        const sgNode = parse(Lang.JavaScript, code).root();
        const matcher: NapiConfig = {
          rule: {
            kind: 'string_fragment',
            any: [
              {
                inside: {
                  stopBy: 'end',
                  kind: 'import_statement',
                  field: 'source',
                },
              },
              {
                inside: {
                  stopBy: 'end',
                  kind: 'export_statement',
                  field: 'source',
                },
              },
              {
                inside: {
                  kind: 'string',
                  inside: {
                    kind: 'arguments',
                    inside: {
                      kind: 'call_expression',
                      has: {
                        field: 'function',
                        regex: '^(import|require)$',
                      },
                    },
                  },
                },
              },
            ],
          },
        };
        const matchModule = sgNode.findAll(matcher).map(matchNode => {
          return {
            name: matchNode.text(),
            start: matchNode.range().start.index,
            end: matchNode.range().end.index,
          };
        });
        if (matchModule.length > 0) {
          const { jsExtension, isModule } = getDefaultOutExtension({
            format,
            root,
            autoExtension,
          });
          const outputPath = resolve(outDir, relative(sourceDir, id));
          const str = await redirectImport(
            compiler,
            code,
            matchModule,
            absoluteAlias,
            id,
            dirname(outputPath),
            jsExtension,
            isModule,
            matchPath,
          );
          return {
            ...args,
            code: str.toString(),
            map: str.generateMap({
              hires: true,
              includeContent: true,
            }),
          };
        }
      } catch (e) {
        logger.error('[parse error]', e);
      }
      return args;
    });
  },
};
