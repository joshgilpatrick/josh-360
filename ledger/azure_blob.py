"""The copy of the ledger's backups in Azure blob storage (JP-150): where it is, and how to reach it. Python 3.9,
standard library only.

Nothing here holds a secret. The account and container names are settings, not credentials. Every call goes through
the Azure CLI (`az`) as `--auth-mode login`, which is Josh's own Azure sign-in on the laptop (`az login`), so there is
no key, SAS token or connection string to store, and any such value in the environment is not passed on.

The four calls the upload needs (`list_blobs`, `upload`, `download`, `delete`) are the whole interface, so the tests
use a folder on disk with the same four calls and never reach Azure.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Callable, Dict, Mapping, Optional, Tuple

sys.dont_write_bytecode = True

CONFIG_FILE = "azure-backup.json"
ACCOUNT_KEY = "JOSH360_AZURE_ACCOUNT"
CONTAINER_KEY = "JOSH360_AZURE_CONTAINER"
ACCOUNT = re.compile(r"^[a-z0-9]{3,24}$")
CONTAINER = re.compile(r"^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){1,61}[a-z0-9]$")
PREFIX = "ledger-"
CALL_TIMEOUT = 600
# Variables the Azure CLI would use in place of the sign-in. They are removed from every call.
SECRET_ENV = ("AZURE_STORAGE_KEY", "AZURE_STORAGE_CONNECTION_STRING", "AZURE_STORAGE_SAS_TOKEN",
              "AZURE_STORAGE_ACCOUNT", "AZURE_STORAGE_AUTH_MODE")
AZ_PLACES = ("/opt/homebrew/bin/az", "/usr/local/bin/az")


class AzureError(Exception):
    """The container could not be reached, or the settings for it are wrong."""


Runner = Callable[[list, Mapping[str, str]], Tuple[int, str, str]]


def load_config(state_dir: Path, env: Mapping[str, str]) -> Optional[Tuple[str, str]]:
    """(account, container) from <state>/azure-backup.json, overridden by JOSH360_AZURE_ACCOUNT and
    JOSH360_AZURE_CONTAINER. None when neither is set. AzureError for anything else: half a setting, a bad name, or a
    file that holds anything but the two names (a secret never belongs in it)."""
    values: Dict[str, str] = {}
    path = Path(state_dir) / CONFIG_FILE
    if path.is_file():
        try:
            data = json.loads(path.read_text())
        except (OSError, ValueError) as e:
            raise AzureError("{} cannot be read: {}".format(CONFIG_FILE, e))
        if not isinstance(data, dict) or set(data) - {"account", "container"}:
            raise AzureError("{} may hold only account and container; no secret belongs in this file".format(
                CONFIG_FILE))
        values = {k: v for k, v in data.items() if isinstance(v, str)}
    if env.get(ACCOUNT_KEY):
        values["account"] = env[ACCOUNT_KEY]
    if env.get(CONTAINER_KEY):
        values["container"] = env[CONTAINER_KEY]
    if not values:
        return None
    account, container = values.get("account", ""), values.get("container", "")
    if not ACCOUNT.match(account):
        raise AzureError("the storage account name must be 3 to 24 lower-case letters and digits")
    if not CONTAINER.match(container):
        raise AzureError("the container name must be 3 to 63 lower-case letters, digits and single hyphens")
    return account, container


def _run(argv: list, env: Mapping[str, str]) -> Tuple[int, str, str]:
    try:
        done = subprocess.run(argv, env=dict(env), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              universal_newlines=True, timeout=CALL_TIMEOUT)
    except subprocess.TimeoutExpired:
        raise AzureError("az did not answer within {} seconds".format(CALL_TIMEOUT))
    except OSError as e:
        raise AzureError("az could not be started: {}".format(e))
    return done.returncode, done.stdout, done.stderr


class AzCli:
    """One container, reached through `az storage blob ...` with the signed-in identity."""

    def __init__(self, account: str, container: str, runner: Optional[Runner] = None, az: Optional[str] = None):
        self.account = account
        self.container = container
        self._runner = runner or _run
        self._az = az

    def _az_lookup(self) -> Optional[str]:
        found = os.environ.get("JOSH360_AZ") or shutil.which("az")
        if found:
            return found
        return next((p for p in AZ_PLACES if os.access(p, os.X_OK)), None)

    def _call(self, verb: str, extra: list) -> str:
        az = self._az or self._az_lookup()
        if not az:
            raise AzureError("the Azure CLI (az) is not installed on this laptop")
        argv = [az, "storage", "blob", verb, "--account-name", self.account, "--container-name", self.container,
                "--auth-mode", "login", "--only-show-errors"] + extra
        env = {k: v for k, v in os.environ.items() if k not in SECRET_ENV}
        code, out, err = self._runner(argv, env)
        if code != 0:
            lines = [ln.strip() for ln in (err or out or "").splitlines() if ln.strip()]
            raise AzureError("az storage blob {} failed: {}".format(verb, (lines[0] if lines else "no message")[:200]))
        return out

    def list_blobs(self) -> Dict[str, int]:
        out = self._call("list", ["--prefix", PREFIX, "--output", "json", "--query",
                                  "[].{name:name,size:properties.contentLength}"])
        try:
            rows = json.loads(out or "[]")
            return {str(r["name"]): int(r["size"]) for r in rows}
        except (ValueError, KeyError, TypeError):
            raise AzureError("az storage blob list gave an answer that is not a list of names and sizes")

    def upload(self, name: str, path: Path) -> None:
        self._call("upload", ["--name", name, "--file", str(path), "--overwrite", "true", "--output", "none"])

    def download(self, name: str, path: Path) -> None:
        self._call("download", ["--name", name, "--file", str(path), "--output", "none"])

    def delete(self, name: str) -> None:
        self._call("delete", ["--name", name, "--output", "none"])
