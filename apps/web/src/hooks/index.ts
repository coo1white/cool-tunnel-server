// SPDX-License-Identifier: AGPL-3.0-only
//
// Custom React hooks used across the admin web client.
//
// Each hook lives in its own file and is documented inline. The barrel
// re-exports make import sites read as `from "../hooks"` rather than each
// hook's path. Stay minimal — only add to this directory when at least two
// call sites duplicate the same pattern (`useImperativeAction` and
// `useClipboard` were both ≥2-use patterns when extracted).

export {
  type UseClipboardOptions,
  type UseClipboardResult,
  useClipboard,
} from "./use-clipboard";
export {
  type UseImperativeActionOptions,
  type UseImperativeActionResult,
  useImperativeAction,
} from "./use-imperative-action";

export {
  readStoredTheme,
  resolveInitialTheme,
  type Theme,
  type UseThemeResult,
  useTheme,
  writeStoredTheme,
} from "./use-theme";
