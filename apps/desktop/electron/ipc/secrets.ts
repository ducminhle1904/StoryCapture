import {
  deleteGenericSecret,
  loadGenericSecret,
  storeGenericSecret,
} from "./generic-secret-store";
import { legacyHandlers } from "./legacy-command";
import type { InvokeArgs, InvokeHandlers } from "./types";

function genericSecretAddress(args: InvokeArgs) {
  const payload = args as
    | { service?: unknown; account?: unknown; key?: unknown }
    | undefined;
  return {
    service: payload?.service,
    account: payload?.account ?? payload?.key,
  };
}

export const secretsHandlers = {
  store_secret: (args) => {
    const payload = args as { value?: unknown } | undefined;
    const { service, account } = genericSecretAddress(args);
    return storeGenericSecret(service, account, payload?.value);
  },
  delete_secret: (args) => {
    const { service, account } = genericSecretAddress(args);
    return deleteGenericSecret(service, account);
  },
  load_secret: (args) => {
    const { service, account } = genericSecretAddress(args);
    return loadGenericSecret(service, account);
  },
  ...legacyHandlers(["key_get_presence", "key_set", "key_delete", "key_test"]),
} satisfies InvokeHandlers;
