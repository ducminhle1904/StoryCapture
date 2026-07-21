import { fileURLToPath } from "node:url";

function resolveExportTarget(specifier) {
  return fileURLToPath(import.meta.resolve(specifier));
}

export function bundleSharedTypesPlugin() {
  return {
    name: "bundle-storycapture-shared-types",
    setup(buildContext) {
      buildContext.onResolve(
        { filter: /^@storycapture\/shared-types(?:\/.*)?$/ },
        ({ path: specifier }) => {
          try {
            return { path: resolveExportTarget(specifier) };
          } catch (error) {
            return {
              errors: [
                {
                  text: error instanceof Error ? error.message : String(error),
                },
              ],
            };
          }
        },
      );
    },
  };
}
