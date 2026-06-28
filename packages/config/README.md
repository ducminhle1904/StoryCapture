# @storycapture/config

Shared TypeScript configuration package.

## Role

- Exports `tsconfig.base.json` for workspace packages and apps.
- Contains no runtime code.
- Has no package scripts today; verify consumers through root or package
  typecheck commands.

## Agent Notes

- Keep this package small. Add only cross-workspace TypeScript configuration.
- Do not put lint, build, app, or domain conventions here; use `docs/` instead.
