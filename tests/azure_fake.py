"""A made-up Azure container for the JP-150 tests: a folder on disk behind the same four calls as ledger.azure_blob.AzCli."""
import shutil
import sys
from pathlib import Path
from typing import Dict

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from ledger.azure_blob import AzureError  # noqa: E402


class FakeContainer:
    def __init__(self, folder: Path):
        self.folder = Path(folder)
        self.folder.mkdir(parents=True, exist_ok=True)
        self.unreachable = False
        self.uploads = []
        self.deletes = []

    def _check(self):
        if self.unreachable:
            raise AzureError("the container cannot be reached")

    def list_blobs(self) -> Dict[str, int]:
        self._check()
        return {p.name: p.stat().st_size for p in self.folder.iterdir() if p.is_file()}

    def upload(self, name: str, path: Path) -> None:
        self._check()
        shutil.copyfile(str(path), str(self.folder / name))
        self.uploads.append(name)

    def download(self, name: str, path: Path) -> None:
        self._check()
        shutil.copyfile(str(self.folder / name), str(path))

    def delete(self, name: str) -> None:
        self._check()
        (self.folder / name).unlink()
        self.deletes.append(name)
