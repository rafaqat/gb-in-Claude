# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""Where the eval scripts find gb-mcp and the workspace — one place for all of them (code review 2026-10-06).

workspace(): GB_MCP_WORKSPACE when it is set and not empty (made absolute), else ~/Music/gb-mcp. Scripts that
start a gb-mcp server pass this path to it as GB_MCP_WORKSPACE, so the server and the script always use the same
folder."""
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # gb-mcp/


def default_workspace(root: str = ROOT) -> str:
    return os.path.expanduser("~/Music/gb-mcp")


def workspace(env=None) -> str:
    v = (os.environ if env is None else env).get("GB_MCP_WORKSPACE", "").strip()
    return os.path.abspath(v) if v else default_workspace()
