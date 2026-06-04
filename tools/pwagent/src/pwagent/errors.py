"""Typed CLI errors. Each carries an exit code so scripts driving pwagent can
branch on failure class instead of parsing stderr. All subclass RuntimeError so
existing broad handlers keep working."""

from __future__ import annotations


class PwagentError(RuntimeError):
    code = 1


class NoSessionError(PwagentError):
    code = 3


class SelectorNotFound(PwagentError):
    code = 4


class NavigationTimeout(PwagentError):
    code = 5
