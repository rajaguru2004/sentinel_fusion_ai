"""Convert percent-format .py sources (notebooks/src/*.py) to .ipynb files.

Usage: python notebooks/_make_nb.py [name ...]   (no args = all)
"""
import sys
from pathlib import Path

import nbformat as nbf

SRC = Path(__file__).parent / "src"
OUT = Path(__file__).parent


def convert(py_path: Path) -> Path:
    lines = py_path.read_text().splitlines()
    cells, cur, kind = [], [], None

    def flush():
        if kind is None:
            return
        text = "\n".join(cur).strip("\n")
        if not text:
            return
        if kind == "markdown":
            text = "\n".join(l[2:] if l.startswith("# ") else l.lstrip("#") for l in text.splitlines())
            cells.append(nbf.v4.new_markdown_cell(text))
        else:
            cells.append(nbf.v4.new_code_cell(text))

    for line in lines:
        if line.startswith("# %%"):
            flush()
            kind = "markdown" if "[markdown]" in line else "code"
            cur = []
        else:
            cur.append(line)
    flush()

    nb = nbf.v4.new_notebook(cells=cells, metadata={
        "kernelspec": {"name": "python3", "display_name": "Python 3", "language": "python"},
        "language_info": {"name": "python"},
    })
    out = OUT / (py_path.stem + ".ipynb")
    nbf.write(nb, out)
    print(f"{py_path.name} -> {out.name} ({len(cells)} cells)")
    return out


if __name__ == "__main__":
    names = sys.argv[1:]
    targets = [SRC / f"{n}.py" for n in names] if names else sorted(SRC.glob("*.py"))
    for t in targets:
        convert(t)
