// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // git worktrees under .claude/ are other checkouts of this repo: their tests are not this tree's
    exclude: [...configDefaults.exclude, ".claude/**", "models/.venv*/**"],
  },
});
