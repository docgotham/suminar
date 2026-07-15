from pathlib import Path
import os
import time
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import letter

ROOT = Path(__file__).resolve().parent / "generated"
ROOT.mkdir(parents=True, exist_ok=True)

def text_pdf(path: Path, revision: str) -> None:
    c = canvas.Canvas(str(path), pagesize=letter, invariant=1)
    c.setTitle(f"Debate and Evidence {revision}")
    c.setAuthor("Dana Scholar; Riley Researcher")
    for page in range(1, 4):
        text = c.beginText(72, 720)
        text.setFont("Times-Roman", 12)
        lines = [
            f"Debate and Evidence - {revision} - page {page}",
            "Dana Scholar and Riley Researcher argue that structured disagreement can reveal hidden assumptions.",
            "The study compares a single response with a multi-participant exchange and records qualified gains.",
            "The authors caution that additional inference budget and prompt quality complicate the comparison.",
            "Evidence should be cited precisely, and claims from another participant remain attributed claims.",
        ] * 4
        for line in lines:
            text.textLine(line)
        c.drawText(text)
        c.showPage()
    c.save()

def image_only_pdf(path: Path) -> None:
    c = canvas.Canvas(str(path), pagesize=letter, invariant=1)
    for _ in range(3):
        c.rect(72, 300, 400, 300, fill=0)
        c.showPage()
    c.save()

def atomic_generate(path: Path, writer) -> None:
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    writer(temporary)
    temporary.replace(path)


EXPECTED = [ROOT / name for name in ["clean.pdf", "revised.pdf", "scanned.pdf", "malformed.pdf"]]
LOCK = ROOT / ".fixture-generation.lock"


def fixtures_complete() -> bool:
    return all(path.is_file() and path.stat().st_size > 0 for path in EXPECTED)


if not fixtures_complete():
    lock_fd = None
    for _ in range(200):
        try:
            lock_fd = os.open(LOCK, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            break
        except FileExistsError:
            if fixtures_complete():
                break
            time.sleep(0.05)
    if lock_fd is not None:
        os.close(lock_fd)
        try:
            atomic_generate(ROOT / "clean.pdf", lambda path: text_pdf(path, "first edition"))
            atomic_generate(ROOT / "revised.pdf", lambda path: text_pdf(path, "revised edition"))
            atomic_generate(ROOT / "scanned.pdf", image_only_pdf)
            atomic_generate(ROOT / "malformed.pdf", lambda path: path.write_bytes(b"this is not a PDF"))
        finally:
            LOCK.unlink(missing_ok=True)
    elif not fixtures_complete():
        raise RuntimeError("Timed out waiting for the shared PDF fixtures")
