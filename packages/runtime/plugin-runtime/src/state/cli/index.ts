import type { AppTools, CliPluginFuture } from '@modern-js/app-tools';
import { createRuntimeExportsUtils, getEntryOptions } from '@modern-js/utils';

const PLUGIN_IDENTIFIER = 'state';

export const statePlugin = (): CliPluginFuture<AppTools<'shared'>> => ({
  name: '@modern-js/plugin-state',

  required: ['@modern-js/runtime'],

  setup: api => {
    api._internalRuntimePlugins(({ entrypoint, plugins }) => {
      const { entryName, isMainEntry } = entrypoint;
      const userConfig = api.getNormalizedConfig();
      const { packageName, metaName } = api.getAppContext();

      const stateConfig = getEntryOptions(
        entryName,
        isMainEntry!,
        userConfig.runtime,
        userConfig.runtimeByEntries,
        packageName,
      )?.state;
      if (stateConfig) {
        plugins.push({
          name: PLUGIN_IDENTIFIER,
          path: `@${metaName}/runtime/model`,
          config: typeof stateConfig === 'boolean' ? {} : stateConfig,
        });
      }
      return { entrypoint, plugins };
    });
    api.addRuntimeExports(() => {
      const { internalDirectory, metaName } = api.useAppContext();

      const pluginsExportsUtils = createRuntimeExportsUtils(
        internalDirectory,
        'plugins',
      );
      pluginsExportsUtils.addExport(
        `export { default as state } from '@${metaName}/runtime/model'`,
      );
    });
  },
});

export default statePlugin;
